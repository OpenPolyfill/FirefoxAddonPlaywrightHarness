# Firefox Addon Playwright Harness

## About

A TypeScript Playwright harness for testing Firefox WebExtensions. It launches Firefox with an isolated persistent profile, installs the extension through Firefox RDP, evaluates background and page code when a background target exists, and exposes popup/action helpers.

### Background-less extensions

Extensions without a background page or worker install normally; `extension.background` is `undefined`. Browser and page action popups are triggered through privileged Firefox chrome code and do not require a background context.

## Features

- Isolated Firefox profile per harness instance.
- Temporary extension installation through Firefox RDP from an unpacked directory or packed XPI.
- Optional background evaluation through `extension.background` for extensions with background pages or workers.
- Page-bound isolated evaluation through `extension.isolated`.
- Explicit page contexts through `extension.isolatedContexts.get(page)`.
- Browser action and page action popup activation.
- RDP-backed popup evaluation, selector waits, clicks, and close detection.
- Idempotent Playwright Firefox patching for extension documents and experiment APIs.

## Installation

The package depends on `@openpolyfill/firefox-rdp`, which is published to GitHub Packages. Configure the scope registry and authenticate with a GitHub token that has `read:packages`:

```sh
cat > .npmrc <<'EOF'
@openpolyfill:registry=https://npm.pkg.github.com
EOF

npm login --scope=@openpolyfill --auth-type=legacy --registry=https://npm.pkg.github.com
npm install @openpolyfill/firefox-addon-playwright-harness @playwright/test
npx playwright install firefox
```

Use a GitHub personal access token (classic) with `read:packages` when npm asks for the password. Do not commit credentials or a token-bearing `.npmrc`. In CI, provide `NODE_AUTH_TOKEN` through the runner's secret store.

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
- `activateAction(page, kind)` and `waitForPopup()` — popup helpers.
- `id`, `installPath`, and `close()` — extension identity and lifecycle.

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

`activateAction` brings the specified Playwright page to the foreground, invokes the WebExtension action, and returns an RDP popup wrapper. It does not navigate to the popup URL or return a Playwright `Page`; the popup wrapper works in headless Firefox.

## Configuration

`createFirefoxFixtures` accepts the following configuration:

- `extensionPath` — required path to an unpacked extension directory or packed XPI file.
- `headless` — launch Firefox headlessly.
- `firefoxUserPrefs` — additional Firefox preferences; harness-required preferences take precedence.
- `args` — additional Firefox command-line arguments.
- `launchOptions` — additional Playwright persistent-context options.
- `postInstallPages` — optional URL strings or regular expressions used to wait for startup pages.
- `patchFirefox` — set to `false` only when the required Playwright Firefox patch is already applied.

## Firefox compatibility and security

Firefox RDP is an internal, version-sensitive protocol. Test against the Firefox revision used by your CI image. The harness uses the Firefox executable supplied by Playwright and creates a temporary profile for each run.

The patch updates Playwright's Firefox resources only when needed. It enables Firefox Experiment APIs, allows Juggler access to `moz-extension://` documents, and locks `marionette.running` in `playwright.cfg`. Missing, ambiguous, or partially applied patch points fail as incompatible builds. The patch is idempotent.

The package's `postinstall` script patches Playwright's CSS and role selector engines to traverse closed roots through `element.openOrClosedShadowRoot`. The Firefox patch installs that privileged getter on `Element.prototype` in Playwright's `__playwright_utility_world__` only. Page and extension worlds must not gain access to closed roots through the injected getter. This supports roots created in MAIN and ISOLATED worlds, including by document-start scripts. Missing, ambiguous, or partially applied patch points fail as incompatible builds.

The RDP endpoint is local, privileged, unauthenticated, and unencrypted. The harness binds it to localhost; do not expose it to a LAN or the public Internet.

This package intentionally does not include DuckDuckGo's XPCOM network interception, proxy wrappers, local mocking server, or unrelated experiment API patches.

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
