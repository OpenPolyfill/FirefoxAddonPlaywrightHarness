---
title: 'Getting started'
description: 'Install the harness, configure Playwright, and create extension fixtures.'
---

## Install

The package and its RDP dependency are published through GitHub Packages:

```sh
printf '%s\n' '@openpolyfill:registry=https://npm.pkg.github.com' >> .npmrc
npm login --scope=@openpolyfill --auth-type=legacy --registry=https://npm.pkg.github.com
npm install @openpolyfill/firefox-addon-playwright-harness @playwright/test
npx playwright install firefox
```

Use a GitHub personal access token (classic) with `read:packages` as the npm password. Keep credentials out of version control. In CI, provide `NODE_AUTH_TOKEN` through the runner's secret store.

Requirements:

- Node.js 20 or newer.
- `@playwright/test` 1.40 or newer.
- Firefox installed by Playwright.

## Configure Playwright

Apply the Firefox patch once through global setup:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  globalSetup: '@openpolyfill/firefox-addon-playwright-harness/globalSetup',
  projects: [{ name: 'firefox', use: { browserName: 'firefox' } }]
})
```

The harness starts Firefox itself with a temporary profile and a localhost-only RDP endpoint. You do not need to start a separate Firefox process.

## Create fixtures

Pass the unpacked extension directory to `createFirefoxFixtures`:

```ts
import { test as baseTest, expect } from '@playwright/test'
import { createFirefoxFixtures } from '@openpolyfill/firefox-addon-playwright-harness/fixtures'

export const test = createFirefoxFixtures(baseTest, {
  extensionPath: './dist-extension',
  headless: true
})

export { expect }
```

Then use the fixtures in a test:

```ts
import { test, expect } from './fixtures.js'

test('extension is installed', async ({ extension }) => {
  expect(extension.id).toBeTruthy()
  expect(await extension.background.evaluate(() => browser.runtime.id)).toBe(extension.id)
})
```

## Next steps

Read [Fixtures and evaluation](/docs/guide/fixtures), [Actions and popups](/docs/guide/actions), and [RDP access](/docs/guide/rdp).
