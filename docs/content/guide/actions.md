---
title: 'Actions and popups'
description: 'Activate browser actions and page actions and inspect their popup targets.'
---

## Browser actions

Activate a browser action and use the returned popup as an ordinary Playwright
`Page`:

```ts
const popup = await extension.activateAction(page, 'browserAction')
const message = popup.getByRole('textbox', { name: 'Message' })
await message.fill('typed by Playwright')
await popup.screenshot()
```

The harness triggers the action through privileged Firefox chrome code and
returns the popup's actual Playwright page. It is included in
`page.context().pages()` and supports normal page locators, evaluation,
screenshots, events, and close lifecycle.

## Page actions

Page actions are activated against the specified page:

```ts
await page.goto('https://example.test')
const popup = await extension.activateAction(page, 'pageAction')
expect(await popup.opener()).toBe(page)
```

Both action methods return a `Page` associated with the owning browser context.

## Waiting and closing

When an extension opens an action popup independently, wait for its page:

```ts
const popupPromise = extension.waitForPopup({ timeout: 5_000 })
// Trigger the extension action.
const popup = await popupPromise
```

Popup dismissal is reflected through the standard Playwright close event.
Calling `Page.close()` hides the Firefox popup and closes its page:

```ts
const closed = popup.waitForEvent('close')
await popup.close()
await closed
expect(popup.isClosed()).toBe(true)
```
