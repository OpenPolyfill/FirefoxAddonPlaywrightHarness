declare const exportFunction: (
  implementation: (host: Element) => ShadowRoot | null,
  target: Window,
  options: { defineAs: string }
) => unknown

export function installClosedShadowRootBridge(): void {
  exportFunction(
    (host: Element) =>
      (host as Element & { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot ??
      host.shadowRoot,
    window,
    { defineAs: '__openpolyfillPlaywrightClosedShadowRoot__' }
  )
}

export function closedShadowRootBridgeSource(): string {
  return `(${installClosedShadowRootBridge.toString()})();`
}
