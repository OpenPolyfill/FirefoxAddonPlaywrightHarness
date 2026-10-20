const message = document.getElementById('message')
const confirmed = document.getElementById('confirmed')
document.getElementById('confirm').addEventListener('click', (event) => {
  confirmed.textContent = message.value
  confirmed.dataset.clickModifiers = [
    event.altKey,
    event.ctrlKey,
    event.shiftKey,
    event.metaKey
  ].join(',')
  confirmed.dataset.trustedClick = String(event.isTrusted)
})
