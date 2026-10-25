---
title: 'Local mappings and WebRequest'
description: 'Serve static fixtures with Firefox Local Mode and test fulfilled responses through WebExtension WebRequest.'
---

## Use both response paths

`localMappings` and Playwright routing solve different test needs:

- `localMappings` serves static files from a directory on an HTTPS `*.localhost` origin through Firefox DevTools Local Mode.
- `page.route()` plus `route.fulfill()` creates a dynamic response directly in the browser test.

Both paths work without an HTTP server. The harness installs the Firefox compatibility patch during global setup; `localMappings` requires Firefox 153 or newer. See [Fixtures and evaluation](/docs/guide/fixtures#firefox-devtools-local-mode) for mapping lifecycle and configuration details.

```ts
import { test as baseTest, expect } from '@playwright/test'
import { createFirefoxFixtures } from '@openpolyfill/firefox-addon-playwright-harness/fixtures'

const origin = 'https://web-request.localhost'
const test = createFirefoxFixtures(baseTest, {
  extensionPaths: ['./tests/fixtures/web-request-local-mode-extension'],
  headless: true,
  localMappings: {
    'web-request.localhost': './tests/fixtures/local-web-request-mode'
  }
})

test('observe a fulfilled response', async ({ page }) => {
  await page.route(`${origin}/status`, (route) =>
    route.fulfill({
      status: 207,
      headers: { 'x-harness-response': 'original' },
      body: Buffer.from([0x52, 0x53, 0x50])
    })
  )

  await page.goto(`${origin}/`)
  const result = await page.evaluate(async () => {
    const response = await fetch('/status')
    return {
      status: response.status,
      marker: response.headers.get('x-harness-response'),
      blocking: response.headers.get('x-webrequest-blocking'),
      bytes: Array.from(new Uint8Array(await response.arrayBuffer()))
    }
  })

  expect(result).toEqual({
    status: 207,
    marker: 'modified-by-webRequest',
    blocking: 'changed',
    bytes: [0x52, 0x53, 0x50]
  })
  const mappedBytes = await page.evaluate(async () =>
    Array.from(new Uint8Array(await (await fetch('/payload.bin')).arrayBuffer()))
  )
  expect(mappedBytes).toEqual([0x5a, 0x42, 0x43])
})
```

Register `page.route()` before the request. A routed URL still needs to match the add-on's URL filters and host permissions for the WebRequest listener to observe it.

## WebRequest sees fulfilled responses

Firefox normally dispatches WebRequest phases from its channel observers. A Playwright `route.fulfill()` response is synthesized by Juggler, so the harness bridges that fulfilled response through Firefox's WebRequest manager. The bridge uses the manager that owns the add-on listeners and preserves Firefox's URL, host-permission, tab, window, container, and proxy-auth matching.

For a successful fulfilled request, assert events as one request-ID-correlated sequence:

1. `onBeforeRequest`
2. `onBeforeSendHeaders`
3. `onSendHeaders`
4. `onHeadersReceived`
5. `onResponseStarted`
6. `onCompleted`

The status and response headers in the response-phase events describe the fulfilled response. If a blocking `onHeadersReceived` listener returns replacement headers, those headers are applied to the response that `fetch()` receives downstream.

```js
browser.webRequest.onHeadersReceived.addListener(
  (details) => ({
    responseHeaders: (details.responseHeaders ?? []).map((header) =>
      header.name.toLowerCase() === 'x-harness-response'
        ? { ...header, value: 'modified-by-webRequest' }
        : header
    )
  }),
  { urls: ['https://web-request.localhost/status'] },
  ['blocking', 'responseHeaders']
)
```

Check the downstream header to confirm that the blocking listener's change was applied:

```ts
const value = await page.evaluate(async () => {
  const response = await fetch('/status')
  return response.headers.get('x-harness-response')
})
expect(value).toBe('modified-by-webRequest')
```

## Transform response bytes

Firefox's `webRequest.filterResponseData()` can inspect or transform the response stream. Write the modified `Uint8Array` back to the filter and close it when the stream stops:

```js
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.url !== 'https://web-request.localhost/payload.bin') return {}

    const filter = browser.webRequest.filterResponseData(details.requestId)
    filter.ondata = ({ data }) => {
      const bytes = new Uint8Array(data)
      if (bytes.length) bytes[0] = 0x5a
      filter.write(bytes)
    }
    filter.onstop = () => filter.close()
    return {}
  },
  { urls: ['https://web-request.localhost/*'] },
  ['blocking']
)
```

Compare the exact bytes received by downstream JavaScript, not just decoded text. The integration fixture also uses a static `payload.bin` from `localMappings` to verify the ordinary Firefox response-filter path.

## Fulfillment inputs and conditional events

`route.fulfill()` accepts equivalent ways to provide response data:

- `body` for explicit bytes or text;
- `json` for a serialized JSON body;
- `contentType` to set the content type for a body;
- `path` to load a body from a local file;
- `response` to reuse an `APIResponse`'s status, headers, and body;
- `status` and `headers` to set the HTTP-visible response metadata.

The harness regression test exercises these input forms and compares the add-on's response-phase events with the status, headers, and bytes observed downstream.

Redirect, authentication, and error events are conditional, not part of every successful response:

- A fulfilled 3xx with `Location` can produce `onBeforeRedirect`; the target request has its own lifecycle.
- A 401 response with `WWW-Authenticate` produces `onAuthRequired`. A 407 is treated as proxy authentication only when Firefox reports an actual proxy; the event's challenger comes from that proxy.
- An aborted request produces `onErrorOccurred` instead of a successful response completion.

Test these cases separately and correlate by `requestId`. Ordinary successful 2xx responses should not produce `onAuthRequired`, `onBeforeRedirect`, or `onErrorOccurred`.

## Permissions and troubleshooting

The extension needs `webRequest`, the applicable host permission (for example `https://app.localhost/*`), and `webRequestBlocking` for blocking listeners. Firefox's normal WebRequest matching and permission checks still apply; the harness does not grant extra host access.

If an event is missing, check that:

- Playwright global setup applied the required Firefox patch;
- the extension registered the listener before the request;
- the URL filter and host permission match the full HTTPS origin;
- the assertion groups events by `requestId`, so a redirect or retry is not combined with another request.

`localMappings` serves files only; use `route.fulfill()` for per-request dynamic statuses, headers, and bodies. Neither requires a manually started HTTP server.

## Run the regression test

From the repository root, run:

```sh
npx playwright test tests/integration/web-request-local-mode.spec.ts --workers=1
```

This case uses `localMappings` for static files and `route.fulfill()` for response cases; it does not start an HTTP server.
