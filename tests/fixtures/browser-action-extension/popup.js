;(async () => {
  for (let attempt = 0; attempt < 40 && !document.body.dataset.activeTab; attempt++) {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
      if (tab) document.body.dataset.activeTab = tab.url || '(active tab)'
    } catch {}
    if (!document.body.dataset.activeTab) await new Promise((resolve) => setTimeout(resolve, 25))
  }
})()

document.getElementById('confirm').addEventListener('click', () => {
  document.body.dataset.confirmed = document.getElementById('message').value
})
