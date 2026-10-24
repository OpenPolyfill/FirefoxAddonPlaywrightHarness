const listener = () => ({})
const event = browser.webRequest.onBeforeRequest
event.addListener(listener, { urls: ['<all_urls>'] })
event.removeListener(listener)
globalThis.webRequestApiReady = true
