;(async () => {
  for (let attempt = 0; attempt < 40 && !document.body.dataset.activeTab; attempt++) {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
      if (tab) document.body.dataset.activeTab = tab.url || '(active tab)'
    } catch {}
    if (!document.body.dataset.activeTab) await new Promise((resolve) => setTimeout(resolve, 25))
  }
})()

document.getElementById('confirm').addEventListener('pointerdown', (event) => {
  document.body.dataset.shiftPointerDown = String(event.shiftKey)
  document.body.dataset.trustedPointerDown = String(event.isTrusted)
  document.body.dataset.confirmPointerDowns = String(
    Number(document.body.dataset.confirmPointerDowns || '0') + 1
  )
  document.body.dataset.pointerModifiers = [
    event.altKey,
    event.ctrlKey,
    event.shiftKey,
    event.metaKey
  ].join(',')
})

document.body.addEventListener('pointerenter', (event) => {
  document.body.dataset.trustedPointerEnter = String(event.isTrusted)
})

const confirmButton = document.getElementById('confirm')
const mouseEventCounts = {}
for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
  document.addEventListener(
    type,
    (event) => {
      if (!confirmButton.contains(event.target)) return
      mouseEventCounts[type] = (mouseEventCounts[type] || 0) + 1
      document.body.dataset.mouseEventCounts = JSON.stringify(mouseEventCounts)
    },
    true
  )
}

document.getElementById('confirm').addEventListener('click', (event) => {
  document.body.dataset.confirmed = document.getElementById('message').value
  document.body.dataset.shiftConfirmed = String(event.shiftKey)
  document.body.dataset.confirmClickCount = String(
    Number(document.body.dataset.confirmClickCount || '0') + 1
  )
  document.body.dataset.trustedClick = String(event.isTrusted)
  document.body.dataset.clickModifiers = [
    event.altKey,
    event.ctrlKey,
    event.shiftKey,
    event.metaKey
  ].join(',')
})
