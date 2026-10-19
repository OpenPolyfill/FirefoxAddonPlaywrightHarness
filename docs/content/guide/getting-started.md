---
title: 'Getting started'
description: 'Install the harness, configure Playwright, and create extension fixtures.'
---

## Install

Both the harness and its RDP dependency are available from the public npm registry:

```sh
npm install @openpolyfill/firefox-addon-playwright-harness @playwright/test
npx playwright install firefox
```

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

Pass the unpacked extension directory or packed XPI path to `createFirefoxFixtures`:

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
