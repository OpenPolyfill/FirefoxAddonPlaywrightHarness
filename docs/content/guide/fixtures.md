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

## Context and page lifetime

The default context scope is `test`, so each test gets a fresh Firefox context. Use `contextScope: 'worker'` for serial suites that intentionally retain browser and extension state across tests:

```ts
import { test as base } from '@playwright/test'
import {
  createFirefoxFixtures,
  withSharedPage
} from '@openpolyfill/firefox-addon-playwright-harness/fixtures'

const test = withSharedPage(
  createFirefoxFixtures(base, {
    extensionPath: './dist-extension',
    contextScope: 'worker'
  })
)

test.describe.configure({ mode: 'serial' })
```

The factory's `context` fixture forwards the same worker context to each test. Without `withSharedPage`, its `page` fixture reuses a blank page and resets it to `about:blank` after each test. `withSharedPage` instead provides the same `Page` object to every test. That page retains DOM state until it is navigated or reset, and callers must not close it before the worker finishes.

`resolveProjectOptions` maps Playwright `project.use` settings to Firefox launch options when a context is created. It runs once per test context or once per worker context, according to `contextScope`.

## Extension handle

The `extension` fixture exposes:

- `id` and `installPath` — the installed extension identity and source path (directory or XPI).
- `background` — evaluator for the extension background context.
- `isolated` — evaluator bound to the fixture's current `page`.
- `isolatedContexts.get(page)` — evaluator factory for any explicit Playwright page.
- `activateAction(page, kind)` — opens an action popup as a Playwright page. Pass `{ waitForPopup: false }` for a click-only action.
- `waitForPopup()` — waits for an extension popup target.
- `activateSidebar(page)` — opens the extension sidebar and returns its Playwright page.
- `close()` — closes the extension harness.

The configured extension is installed directly from its source directory or XPI. Closed-shadow locator support patches Playwright Firefox's Juggler to install a privileged getter in its utility sandbox; sidebar targets bind to Firefox's inner WebExtension panel browser rather than its outer sidebar host.

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
