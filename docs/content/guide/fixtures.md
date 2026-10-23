---
title: 'Fixtures and evaluation'
description: 'Use page-bound helpers, Firefox chrome Pages, explicit page contexts, and raw RDP.'
---

## Fixture overview

`createFirefoxFixtures` adds these Playwright fixtures:

- `context` — the isolated persistent Firefox context.
- `page` — the current test page.
- `extension` — the installed extension handle.
- `rdp` — the connected `FirefoxRDP` client from `@openpolyfill/firefox-rdp`.
- `chromePage` — the primary Firefox `browser.xhtml` window as a Playwright `Page`.
- `chromePages()` — returns the currently open browser chrome Pages.
- `nativeMessaging` — observe per-process native host sessions and their stdio.

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

## Browser chrome and embedded UI

`chromePage` targets Firefox's actual primary `browser.xhtml` document. It is a regular Playwright `Page`, so use its locators, evaluation, mouse, keyboard, and screenshot APIs for menus, toolbars, doorhangers, and other UI in that chrome document.

Call `chromePages()` each time you need the current set; it includes additional browser windows opened after fixture setup. Outside the fixtures, `getFirefoxChromePages(context)` provides the same discovery API. Privileged documents hosted by separate embedded `<browser>` elements are exposed as additional `Page` targets. Ordinary iframes remain `Frame` objects.

```ts
test('inspect browser chrome', async ({ chromePage, chromePages }) => {
  expect(await chromePage.evaluate(() => document.documentURI)).toContain('browser.xhtml')
  await expect(chromePage.locator('#PanelUI-menu-button')).toBeVisible()
  expect(await chromePages()).toContain(chromePage)
})
```

How Firefox UI maps to Pages:

- **Panels and menus of a chrome window** (the application menu, context menus, doorhangers such as the bookmark and permission panels) belong to that window's Page. Locators and input reach open XUL popups even though they are drawn in their own widgets.
- **Context menus** opened through `chromePage` remain available for clicking their items or dismissing with `Escape`. To operate a tab's native content menu, right-click through `chromePage.mouse` at the content's coordinates relative to the chrome window. Right-clicking through the tab Page retains upstream Playwright behavior, which dismisses the native menu.
- **Window-modal dialogs** (for example `Services.prompt` with a browser window as parent) are separate Pages at `chrome://global/content/commonDialog.xhtml`. A click or key press that closes the dialog completes normally and the Page emits `close`.
- **Content prompts** (`alert`, `confirm`, `prompt` from a page) stay Playwright `dialog` events of that page.
- **Sidebar panels**, such as bookmarks, history, or an extension sidebar, are Pages while the sidebar is open and close with it.
- **Subdialogs of privileged pages**, such as the dialogs of `about:preferences`, are Pages owned by their tab.
- **Embedded `<browser>` documents** keep their Page across navigations, including ones that move the browser to another process. Replacing the `<browser>` element closes its Page and creates a new one.

A `page` event for embedded UI can arrive while the Page still reports its initial `about:blank`, as with popups; wait for the document you expect:

```ts
await page.goto('about:preferences')
const opened = context.waitForEvent('page')
await page.evaluate(() =>
  gSubDialog.open('chrome://browser/content/preferences/dialogs/connection.xhtml')
)
const subdialog = await opened
await subdialog.waitForURL('chrome://browser/content/preferences/dialogs/connection.xhtml')
await subdialog.locator('#networkProxyType radio[value="1"]').click()
```

## Automatic Firefox error diagnostics

The harness listens to Firefox RDP console events from extension background targets, extension content scripts, and browser chrome. Uncaught exceptions and error-level console messages are recorded with a timestamp, execution context, extension ID or source URL when available, message, and stack trace.

When a test fails or times out, Playwright receives a `firefox-error-diagnostics.json` attachment containing the diagnostics collected for that test. Collection starts during browser setup so extension startup errors are included. Buffers are bounded and cleared between tests, including when `contextScope: 'worker'` reuses a Firefox instance.

### Firefox DevTools Local Mode

Use `localMappings` to serve static directories on HTTPS hostnames without starting an HTTP server. Keys are hostnames without a scheme, port, or path; directory paths may be relative to the current working directory:

```ts
const test = createFirefoxFixtures(base, {
  extensionPath: './dist-extension',
  localMappings: {
    'app.localhost': './tests/fixtures/app',
    'assets.localhost': './tests/fixtures/assets'
  }
})
```

Firefox 153+ serves each mapped origin through its built-in DevTools Local Mode. The harness enables `network-event` watching and registers mappings before returning the fixture page or a page created with `context.newPage()`. Each page owns its watcher; closing a page clears its mappings and stops resource watching, and closing the context cleans up any remaining watchers.

### Firefox Native Messaging

Register native hosts in the fixture configuration. Each entry's key becomes the host name in the native manifest:

```ts
const test = createFirefoxFixtures(base, {
  extensionPath: './dist-extension',
  nativeMessagingHosts: {
    'org.example.echo': {
      executable: './tests/native-host',
      description: 'Echo host for tests',
      allowedExtensions: ['my-addon@example.org']
    }
  },
  nativeMessagingObservers: {
    'org.example.echo': { mode: 'non-blocking' }
  }
})
```

The extension must request the `nativeMessaging` permission, and its Gecko ID must appear in `allowedExtensions`. Executable paths resolve from the current working directory and are written to the manifest without checking whether the binary exists or is executable; Firefox reports launch failures when the extension uses the host. The host receives its manifest path and extension ID as arguments.

The `nativeMessaging` fixture exposes sessions only for names explicitly listed in `nativeMessagingObservers`; registering a host does not enable observation. The harness hooks Firefox's Native Messaging process streams inside Firefox through privileged RDP evaluation—there is no executable proxy. `non-blocking` delivers observations without waiting. `blocking` awaits `onData(event)`; returning a `Buffer` or `Uint8Array` replaces those bytes before Firefox forwards them, while returning `undefined` passes them through.

The session emits a `message` event for every decoded frame. `session.messages` and frames buffered for later `waitForMessage()` calls retain at most 256 messages or 4 MiB each; for persistent hosts, wait or subscribe as messages arrive. Consume raw streams to avoid retaining unread bytes.

On Linux, the harness writes manifests under a unique temporary directory for each Firefox instance, then uses privileged RDP evaluation to set `XREUserNativeManifests` before initializing Firefox's native manifest cache. It does not write to `~/.mozilla/native-messaging-hosts`. The worker or test fixture teardown closes Firefox (which shuts down native hosts) before removing the temporary profile and manifests.

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
