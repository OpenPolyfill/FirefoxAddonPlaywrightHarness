---
title: 'Fixtures and evaluation'
description: 'Use the page-bound extension helpers, explicit page contexts, and raw RDP fixture.'
---

## Fixture overview

`createFirefoxFixtures` adds these Playwright fixtures:

- `context` — the isolated persistent Firefox context.
- `page` — the current test page.
- `extension` — the installed extension handle.
- `rdp` — the connected `FirefoxRDP` client from `@openpolyfill/firefox-rdp`.

## Extension handle

The `extension` fixture exposes:

- `id` and `installPath` — the installed extension identity and source path (directory or XPI).
- `background` — evaluator for the extension background context.
- `isolated` — evaluator bound to the fixture's current `page`.
- `isolatedContexts.get(page)` — evaluator factory for any explicit Playwright page.
- `activateAction(page, kind)` — opens an action popup by default. Pass `{ waitForPopup: false }` to trigger a click-only action without waiting for a popup.
- `waitForPopup()` — waits for an extension popup target.
- `close()` — closes the extension harness.

The configured extension is installed directly from its source directory or XPI. Closed-shadow locator support patches Playwright Firefox's Juggler to install a privileged getter in its utility sandbox; it does not add or modify an extension.

## Background evaluation

Use `extension.background` for code running in the extension background context:

```ts
const runtimeId = await extension.background.evaluate(() => browser.runtime.id)
expect(runtimeId).toBe(extension.id)
```

Both function callbacks and expression strings are supported. `waitForFunction` polls until the result is truthy:

```ts
await extension.background.waitForFunction(() => browser.runtime.id === extension.id)
```

## Page-bound isolated evaluation

`extension.isolated` follows the fixture's current page, including navigations:

```ts
await page.goto('https://example.test')
expect(await extension.isolated.evaluate(() => location.hostname)).toBe('example.test')
```

For another page, use `extension.isolatedContexts.get(page)` explicitly:

```ts
const otherPage = await context.newPage()
await otherPage.goto('https://example.org')
const otherPageIsolated = extension.isolatedContexts.get(otherPage)
expect(await otherPageIsolated.evaluate(() => location.hostname)).toBe('example.org')
```

## Raw RDP client

The `rdp` fixture exposes the live `FirefoxRDP` client. Use it when a high-level harness helper does not cover the protocol operation you need:

```ts
test('inspect tabs through RDP', async ({ rdp }) => {
  const tabs = await rdp.root.listTabs()
  expect(tabs.length).toBeGreaterThan(0)
})
```

The public type is re-exported as `FirefoxRDP`, but protocol methods and actor availability remain dependent on the Firefox build.
