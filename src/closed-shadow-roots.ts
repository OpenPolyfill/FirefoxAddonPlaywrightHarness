declare function exportFunction(
  implementation: (capability: string, utilityGlobal: object) => boolean,
  target: object,
  options: { defineAs: string; allowCrossOriginArguments?: boolean }
): unknown
declare function exportFunction(
  implementation: (host: Element) => ShadowRoot | null,
  target: object,
  options: { defineAs: string; allowCrossOriginArguments?: boolean }
): unknown

const getterName = '__openpolyfillClosedShadowRootGetter__'
const accessName = '__openpolyfillClosedShadowRootForPlaywright__'

function bootstrapGetterName(capability: string): string {
  return `__openpolyfillClosedShadowRootBootstrap_${capability}__`
}

export function installClosedShadowRootBridge(
  capability: string,
  pageGlobalName: string,
  utilityGetterName: string
): void {
  const extensionWindow = window as unknown as Record<string, unknown>
  const wrappedPageGlobal = extensionWindow['wrappedJSObject']
  if (typeof wrappedPageGlobal !== 'object' || wrappedPageGlobal === null)
    throw new Error('Firefox content script did not expose the page global through wrappedJSObject')
  const pageGlobal = wrappedPageGlobal as Record<string, unknown>
  exportFunction(
    (providedCapability: string, utilityGlobal: object) => {
      if (providedCapability !== capability) return false
      try {
        exportFunction(
          (host: Element) => {
            const privilegedHost = host as Element & {
              openOrClosedShadowRoot?: ShadowRoot | null
            }
            return privilegedHost.openOrClosedShadowRoot ?? privilegedHost.shadowRoot
          },
          utilityGlobal,
          { defineAs: utilityGetterName }
        )
        return true
      } finally {
        if (
          !Reflect.deleteProperty(pageGlobal, pageGlobalName) ||
          Object.prototype.hasOwnProperty.call(pageGlobal, pageGlobalName)
        ) {
          throw new Error('Temporary closed-shadow getter could not be removed from page global')
        }
      }
    },
    window,
    { defineAs: pageGlobalName, allowCrossOriginArguments: true }
  )
}

export function closedShadowRootBridgeSource(capability: string): string {
  const pageGlobalName = bootstrapGetterName(capability)
  return `(${installClosedShadowRootBridge.toString()})(${JSON.stringify(capability)}, ${JSON.stringify(pageGlobalName)}, ${JSON.stringify(getterName)});`
}

export function closedShadowRootUtilityInitScript(capability: string): string {
  const pageGlobalName = bootstrapGetterName(capability)
  return `/* @openpolyfill-utility-world */
(() => {
  const pageGlobal = window.wrappedJSObject;
  const bootstrapGetter = pageGlobal?.[${JSON.stringify(pageGlobalName)}];
  if (typeof bootstrapGetter !== 'function')
    throw new Error('Privileged closed-shadow getter was not installed before the utility world');
  const installed = bootstrapGetter(${JSON.stringify(capability)}, globalThis);
  if (!installed)
    throw new Error('Privileged closed-shadow getter could not be installed in the utility world');
  if (typeof globalThis.${getterName} !== 'function')
    throw new Error('Privileged closed-shadow getter is missing from the utility world');
  if (Object.prototype.hasOwnProperty.call(pageGlobal, ${JSON.stringify(pageGlobalName)}))
    throw new Error('Temporary closed-shadow getter remained on the page global');
})();
globalThis.${accessName} = (host) => {
  const getter = globalThis.${getterName};
  return typeof getter === 'function' ? getter(host) : null;
};`
}
