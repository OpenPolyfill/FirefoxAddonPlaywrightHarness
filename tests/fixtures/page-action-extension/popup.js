browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  document.getElementById('active-tab').textContent = tab?.url || ''
})
