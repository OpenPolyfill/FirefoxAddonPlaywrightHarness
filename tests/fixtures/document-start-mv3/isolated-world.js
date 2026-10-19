const getterName = 'openOrClosedShadowRoot'
const pageGlobal = window.wrappedJSObject
const getterVisibleToAddon =
  Object.prototype.hasOwnProperty.call(globalThis, getterName) ||
  Object.prototype.hasOwnProperty.call(pageGlobal, getterName)
document.documentElement.setAttribute(
  'data-utility-getter-visible-to-addon',
  String(getterVisibleToAddon)
)
const readyStateAtDocumentStart = document.readyState
const hostId = 'isolated-world-host'

function attachClosedRoot() {
  const host = document.getElementById(hostId)
  if (!host) return false

  host.setAttribute('data-content-script-ready-state', readyStateAtDocumentStart)
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = '<span>ISOLATED world closed root</span><button>ISOLATED action</button>'
  host.setAttribute('data-closed-root-created', 'true')
  return true
}

if (!attachClosedRoot()) {
  const observer = new MutationObserver(() => {
    if (attachClosedRoot()) observer.disconnect()
  })
  observer.observe(document, { childList: true, subtree: true })
}
