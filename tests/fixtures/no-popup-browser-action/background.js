globalThis.harnessActionClickCount = 0

browser.browserAction.onClicked.addListener(() => {
  globalThis.harnessActionClickCount += 1
})
