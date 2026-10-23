---
title: 'API reference'
description: 'Firefox Addon Playwright Harness TypeScript API documentation.'
---

The runtime API and the underlying Firefox RDP client are documented separately.

See [Generated API](/docs/api/reference) for TypeDoc pages generated from `src/index.ts` during `npm run docs:prepare`.

## Main entry points

- `createFirefoxFixtures(test, config)` — extend Playwright with the harness fixtures.
- `chromePage` — automate the primary Firefox browser chrome window as a Playwright `Page`.
- `chromePages()` and `getFirefoxChromePages(context)` — discover the currently open browser chrome Pages.
- `extensions` — read-only Map-like collection of installed handles keyed by Gecko extension ID.
- `extensions.get(id)` / `extensions.has(id)` — select an installed extension or check membership.
- `extensions.install(path)` — install a directory or XPI at runtime.
- `FirefoxExtension.reload()`, `enable()`, `disable()`, and `uninstall()` — control one extension lifecycle.
- A selected handle's `background`, `isolated`, `isolatedContexts.get(page)`, `activateAction(page, kind)`, and `activateSidebar(page)` — evaluate or activate extension contexts and UI.
- `rdp.root.listTabs()` — access the raw `FirefoxRDP` client from a test.
- `nativeMessaging` — inspect host sessions, raw stdio, decoded Native Messaging frames, and process exit events.

Start with [Getting started](/docs/guide/getting-started) or [Fixtures and evaluation](/docs/guide/fixtures).

The generated reference is produced during `npm run docs:prepare` and appears under `/docs/api/reference/`.
