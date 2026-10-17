---
title: 'Actions and popups'
description: 'Activate browser actions and page actions and inspect their popup targets.'
---

## Browser actions

Bring the target page to the foreground and activate its browser action:

```ts
const popup = await extension.activateAction(page, 'browserAction')
await popup.waitForSelector('[data-ready]')
expect(await popup.evaluate(() => document.body.dataset.ready)).toBe('true')
```

The harness invokes the action API through the background context and waits for the extension popup target. It works in headless Firefox without navigating the Playwright page to the popup URL.

## Page actions

Page actions are activated against the specified page as well:

```ts
await page.goto('https://example.test')
const popup = await extension.activateAction(page, 'pageAction')
await popup.waitForSelector('body')
```

The returned popup is an RDP wrapper, not a Playwright `Page`. It exposes `url`, `evaluate`, `waitForSelector`, `click`, `waitForClose`, and `isClosed`.

## Waiting and closing

```ts
await popup.waitForClose({ timeout: 5_000 })
expect(popup.isClosed()).toBe(true)
```

Use `extension.waitForPopup()` when the extension opens a popup independently of an explicit action call.
