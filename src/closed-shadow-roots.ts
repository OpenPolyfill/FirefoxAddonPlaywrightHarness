export function captureClosedShadowRoots(): void {
  const marker = '__playwrightClosedShadowRootCaptureInstalled__'
  const nativeAttachShadow = Element.prototype
    .attachShadow as typeof Element.prototype.attachShadow & {
    __playwrightClosedShadowRootCaptureInstalled__?: boolean
  }
  if (nativeAttachShadow[marker]) return

  const patchedAttachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
    const nativeRoot = nativeAttachShadow.call(this, init)
    if (init.mode === 'closed') {
      const host = (this as Element & { wrappedJSObject?: Element }).wrappedJSObject ?? this
      const root =
        (nativeRoot as ShadowRoot & { wrappedJSObject?: ShadowRoot }).wrappedJSObject ?? nativeRoot
      if (!Object.prototype.hasOwnProperty.call(host, '__playwrightClosedShadowRoot__')) {
        Object.defineProperty(host, '__playwrightClosedShadowRoot__', {
          value: root,
          configurable: false
        })
      }
    }
    return nativeRoot
  }

  Object.defineProperty(patchedAttachShadow, marker, { value: true })
  Element.prototype.attachShadow = patchedAttachShadow
}

export function closedShadowRootCaptureSource(): string {
  return `(${captureClosedShadowRoots.toString()})();`
}
