browser.tabs.onUpdated.addListener((tabId) => browser.pageAction.show(tabId))
