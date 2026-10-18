---
title: 'Firefox Addon Playwright Harness'
description: 'Playwright fixtures for testing Firefox WebExtensions through Firefox RDP.'
---

**A Playwright harness for Firefox WebExtension integration tests.**

Launch an isolated Firefox profile, install an extension from an unpacked directory or packed XPI, inspect the background context, evaluate page code, activate browser/page actions, and access the underlying Firefox RDP client from one fixture set.

## Start here

- [Getting started](/docs/guide/getting-started) — install the package and create fixtures.
- [Fixtures and evaluation](/docs/guide/fixtures) — use `background`, `isolated`, and the raw `rdp` client.
- [Actions and popups](/docs/guide/actions) — open browser actions and page actions in headless Firefox.
- [RDP access](/docs/guide/rdp) — use the `FirefoxRDP` client for low-level protocol operations.
- [API reference](/docs/api) — browse the public TypeScript API and generated declarations.

## About compatibility

Firefox RDP is an internal, version-sensitive protocol. The harness targets the Firefox revision supplied by Playwright and applies the required compatibility patch during global setup. Run the integration suite against the same Firefox build used in CI.
