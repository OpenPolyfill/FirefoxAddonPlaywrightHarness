---
title: 'API reference'
description: 'Firefox Addon Playwright Harness TypeScript API documentation.'
---

The runtime API and the underlying Firefox RDP client are documented separately.

See [Generated API](/docs/api/reference) for TypeDoc pages generated from `src/index.ts` during `npm run docs:prepare`.

## Main entry points

- `createFirefoxFixtures(test, config)` — extend Playwright with the harness fixtures.
- `extension.background` — evaluate in the extension background context.
- `extension.isolated` — evaluate in the current fixture page.
- `extension.isolatedContexts.get(page)` — evaluate in an explicitly selected page.
- `extension.activateAction(page, kind)` — open a browser action or page action popup.
- `rdp.root.listTabs()` — access the raw `FirefoxRDP` client from a test.

Start with [Getting started](/docs/guide/getting-started) or [Fixtures and evaluation](/docs/guide/fixtures).

The generated reference is produced during `npm run docs:prepare` and appears under `/docs/api/reference/`.
