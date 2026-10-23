document.querySelector('#request').addEventListener('click', async () => {
  const granted = await browser.permissions.request({ permissions: ['notifications'] })
  document.querySelector('#result').textContent = String(granted)
})
