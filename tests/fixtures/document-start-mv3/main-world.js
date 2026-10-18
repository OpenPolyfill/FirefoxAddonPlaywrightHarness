const readyStateAtDocumentStart = document.readyState
const hostId = 'main-world-host'

function attachClosedRoot() {
  const host = document.getElementById(hostId)
  if (!host) return false

  host.setAttribute('data-content-script-ready-state', readyStateAtDocumentStart)
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = '<span>MAIN world closed root</span><button>MAIN action</button>'
  host.setAttribute('data-closed-root-created', 'true')
  return true
}

if (!attachClosedRoot()) {
  const observer = new MutationObserver(() => {
    if (attachClosedRoot()) observer.disconnect()
  })
  observer.observe(document, { childList: true, subtree: true })
}
