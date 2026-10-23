# Firefox Addon Playwright Harness

## About

A TypeScript Playwright harness for testing Firefox WebExtensions. It launches Firefox with an isolated persistent profile, installs the extension through Firefox RDP, evaluates background and page code when a background target exists, and exposes action popup and sidebar helpers.

### Background-less extensions

Extensions without a background page or worker install normally; `extension.background` is `undefined`. Browser and page action popups and extension sidebars are activated through privileged Firefox chrome code and do not require a background context.

## Features

- Isolated Firefox profile per harness instance.
- Temporary extension installation through Firefox RDP from an unpacked directory or packed XPI.
- Optional background evaluation through `extension.background` for extensions with background pages or workers.
- Page-bound isolated evaluation through `extension.isolated`.
- Explicit page contexts through `extension.isolatedContexts.get(page)`.
- Browser action, page action, and extension sidebar activation as Playwright `Page` targets.
- Popup and sidebar input, locators, screenshots, events, and close lifecycle through Playwright.
- `chromePage` exposes the primary `browser.xhtml` window as a Playwright `Page`; embedded Firefox UI documents are also registered as Pages.
- Idempotent Playwright Firefox patching for extension documents and experiment APIs.
- Automatic capture of uncaught exceptions and error-level console messages from Firefox extension backgrounds, content scripts, and browser chrome, attached to failed tests.

## Installation

Install the package and its Firefox RDP dependency from the public npm registry:

```sh
npm install @openpolyfill/firefox-addon-playwright-harness @playwright/test
npx playwright install firefox
```

Requirements:

- Node.js 20 or newer.
- `@playwright/test` 1.40 or newer.
- The Firefox browser installed by Playwright.

## Setup

Apply the required Firefox patch once through Playwright global setup:

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  globalSetup: '@openpolyfill/firefox-addon-playwright-harness/globalSetup',
  projects: [
    {
      name: 'firefox',
      use: { browserName: 'firefox' }
    }
  ]
})
```

Create extension-aware fixtures by passing an unpacked extension directory or packed XPI path to the factory:

```ts
// tests/fixtures.ts
import { test as baseTest } from '@playwright/test'
import { createFirefoxFixtures } from '@openpolyfill/firefox-addon-playwright-harness/fixtures'

export const test = createFirefoxFixtures(baseTest, {
  extensionPath: './dist-extension',
  headless: true
})

export { expect } from '@playwright/test'
```

The harness starts Firefox itself with a localhost RDP endpoint. It does not require a manually started Firefox process.

For serial stateful suites, set `contextScope: 'worker'` to keep one Firefox context for the Playwright worker. Wrap the test with `withSharedPage` when tests must receive the same Playwright `Page` object:

```ts
import { test as base } from '@playwright/test'
import {
  createFirefoxFixtures,
  withSharedPage
} from '@openpolyfill/firefox-addon-playwright-harness/fixtures'

const test = withSharedPage(
  createFirefoxFixtures(base, {
    extensionPath: './dist-extension',
    headless: true,
    contextScope: 'worker'
  })
)

test.describe.configure({ mode: 'serial' })
```

The shared page retains its document state until the tests navigate or reset it. Do not close it before the worker finishes.

## Usage

```ts
import { test, expect } from './fixtures.js'

test('background, isolated page, and browser action', async ({ page, extension }) => {
  await page.goto('https://example.test')

  expect(await extension.background.evaluate(() => browser.runtime.id)).toBe(extension.id)
  expect(await extension.isolated.evaluate(() => location.hostname)).toBe('example.test')

  const popup = await extension.activateAction(page, 'browserAction')
  await popup.waitForSelector('body')
  await popup.click('#confirm')
})
```

The `chromePage` fixture is the primary Firefox `browser.xhtml` window, not a tab containing a browser UI URL. Use its normal Playwright locators and input APIs for menus, toolbars, prompts, and other DOM-backed browser UI. Call `chromePages()` to discover all currently open browser chrome windows, including additional windows opened during the test:

```ts
test('inspect Firefox chrome', async ({ chromePage, chromePages }) => {
  expect(await chromePage.evaluate(() => document.documentURI)).toContain('browser.xhtml')
  await expect(chromePage.locator('#PanelUI-menu-button')).toBeVisible()
  expect(await chromePages()).toContain(chromePage)
})
```

The exported `getFirefoxChromePages(context)` helper provides the same discovery behavior outside the fixture API.

Panels, menus, and doorhangers of a chrome window are reached through that window's Page. Window-modal dialogs, sidebar panels, subdialogs of privileged pages such as `about:preferences`, and other embedded `<browser>` documents are separate Pages, while content `alert`/`confirm`/`prompt` stay Playwright `dialog` events.

The `rdp` fixture exposes the connected `FirefoxRDP` client from `@openpolyfill/firefox-rdp` for low-level protocol access. See the [FirefoxRDP documentation](https://openpolyfill.github.io/FirefoxRDP) for the complete client and actor API:

```ts
test('inspect Firefox through RDP', async ({ rdp }) => {
  const tabs = await rdp.root.listTabs()
  expect(tabs.length).toBeGreaterThan(0)
})
```

The `extension` fixture includes:

- `background` — evaluator for the extension background context.
- `isolated` — evaluator bound to the current fixture `page`.
- `isolatedContexts.get(page)` — evaluator factory for another Playwright page.
- `activateAction(page, kind)` and `waitForPopup()` — open or wait for an action popup. Pass `{ waitForPopup: false }` for click-only actions.
- `activateSidebar(page)` — open the extension sidebar and return its Playwright `Page`.
- `id`, `installPath`, and `close()` — extension identity and lifecycle.

The Firefox fixtures also include `chromePage` for the primary browser chrome window and `chromePages()` for rediscovering all open browser chrome windows. Each is a real Playwright `Page`; use locators on `chromePage` for UI hosted in the same XUL document. Embedded privileged UI documents in separate `<browser>` elements are exposed as additional Pages, while ordinary iframes remain `Frame` objects.

`extension.isolated` is bound to the fixture's current `page` and follows that page across navigations. Use `extension.isolatedContexts.get(otherPage)` when the evaluation must target a specific Playwright page:

```ts
const otherPage = await page.context().newPage()
await otherPage.goto('https://example.org')

const otherPageIsolated = extension.isolatedContexts.get(otherPage)
expect(await otherPageIsolated.evaluate(() => location.hostname)).toBe('example.org')
```

`extension.isolated` is the page-bound evaluator; there is no standalone `isolated` DI fixture.

Activate an action with either supported action kind:

```ts
const browserPopup = await extension.activateAction(page, 'browserAction')
const pagePopup = await extension.activateAction(page, 'pageAction')
```

`activateAction` brings the specified Playwright page to the foreground and invokes the WebExtension action. By default it returns the popup's actual Playwright page. Pass `{ waitForPopup: false }` for click-only actions, which returns `void` after triggering Firefox's action handler without waiting for a popup.

For an extension that declares `sidebar_action`, open the sidebar as a Playwright page:

```ts
const sidebar = await extension.activateSidebar(page)
await sidebar.getByRole('textbox').fill('search text')
```

The sidebar `Page` targets Firefox's inner `webext-panels-browser`, not the outer browser that hosts `webext-panels.xhtml`. Calling `sidebar.close()` hides the sidebar and closes its Playwright page.

## Configuration

`createFirefoxFixtures` accepts the following configuration:

- `extensionPath` — required path to an unpacked extension directory or packed XPI file.
- `headless` — launch Firefox headlessly.
- `firefoxUserPrefs` — additional Firefox preferences; harness-required preferences take precedence.
- `args` — additional Firefox command-line arguments.
- `launchOptions` — additional Playwright persistent-context options.
- `postInstallPages` — optional URL strings or regular expressions used to wait for startup pages.
- `localMappings` — optional hostname-to-directory map for static fixtures through Firefox 153+ DevTools Local Mode; relative directories resolve from the current working directory.
- `nativeMessagingHosts` — host-name map to executable, optional description, and allowed extension IDs. The harness registers each host in a private per-instance manifest directory on Linux/macOS.
- `patchFirefox` — set to `false` only when the required Playwright and Firefox patches are already applied; `localMappings` also requires the Firefox Local Mode compatibility patch.
- `contextScope`: `'test'` by default, or `'worker'` to share one Firefox context for a Playwright worker.
- `resolveProjectOptions`: maps the worker or test `project.use` settings to `headless` and `launchOptions`.

For example, map separate HTTPS origins to local fixture directories without starting a server:

```ts
const test = createFirefoxFixtures(base, {
  extensionPath: './dist-extension',
  localMappings: {
    'app.localhost': './tests/fixtures/app',
    'assets.localhost': './tests/fixtures/assets'
  }
})
```

Each page gets its own Firefox RDP network watcher before it is returned to the test. The watcher is removed and its mappings cleared when its page closes; the harness also cleans up all remaining watchers before closing the Firefox context. Firefox Local Mode is isolated per context.

## Firefox compatibility and security

Firefox RDP is an internal, version-sensitive protocol. Test against the Firefox revision used by your CI image. The harness uses the Firefox executable supplied by Playwright and creates a temporary profile for each run.

Firefox and Playwright bundle changes ship as standard unified diffs in `patches/`. The package's `postinstall` applies the Playwright bundle patch; `globalSetup` applies Firefox's root `omni.ja`, `browser/omni.ja`, and `playwright.cfg` patches. Patch application is idempotent, validates the complete patch set before writing, and atomically replaces each changed file. Incompatible or partially patched installations fail with an actionable error; legacy marker-based Firefox patches are not migrated.

The Playwright patch makes CSS and role selectors traverse closed shadow roots through `element.openOrClosedShadowRoot`. The Firefox patch installs that privileged getter on `Element.prototype` in Playwright's `__playwright_utility_world__` only. Page and extension worlds must not gain access to closed roots through the injected getter. This supports roots created in MAIN and ISOLATED worlds, including by document-start scripts.

`localMappings` requires Firefox 153+ and the `WatcherActor.getNetworkParentActor` / `NetworkParentActor.setLocalModeMappings` RDP capabilities. The Firefox Local Mode patch makes DevTools' Local Mode modules load their dependencies in Firefox's distinct DevTools global. Unsupported versions and missing capabilities are reported during harness setup.

The RDP endpoint is local, privileged, unauthenticated, and unencrypted. The harness binds it to localhost; do not expose it to a LAN or the public Internet.

This package does not start an HTTP server or add XPCOM network hooks. `localMappings` uses Firefox's built-in DevTools Local Mode to serve static files.

## Development

```sh
npm install
npm run format
npm run format:check
npm run lint
npm run typecheck
npm run build
npm run verify
```

The integration suite requires Playwright Firefox and the repository's local extension fixtures:

```sh
npx playwright test tests/integration --workers=1
```

## License

Licensed under the Mozilla Public License 2.0. See [LICENSE](LICENSE).
