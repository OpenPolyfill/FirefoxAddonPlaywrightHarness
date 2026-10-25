import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'
import type { APIResponse } from '@playwright/test'

const mappedOrigin = 'https://web-request.localhost'
const mappedHost = 'web-request.localhost'
const statusUrl = `${mappedOrigin}/status`
const jsonUrl = `${mappedOrigin}/json`
const contentTypeUrl = `${mappedOrigin}/typed`
const pathUrl = `${mappedOrigin}/path`
const payloadUrl = `${mappedOrigin}/payload.bin`
const responseUrl = `${mappedOrigin}/response`
const redirectUrl = `${mappedOrigin}/redirect`
const redirectTargetUrl = `${mappedOrigin}/redirect-target`
const abortUrl = `${mappedOrigin}/abort`
const authUrl = `${mappedOrigin}/auth`
const origin407Url = `${mappedOrigin}/origin-407`
const blockingCancelUrl = `${mappedOrigin}/blocking-cancel`
const blockingRedirectUrl = `${mappedOrigin}/blocking-redirect`
const requestHeadersUrl = `${mappedOrigin}/request-headers`
const extensionPath = new URL('../fixtures/web-request-local-mode-extension', import.meta.url)
  .pathname
const noListenerExtensionPath = new URL(
  '../fixtures/web-request-no-listeners-extension',
  import.meta.url
).pathname
const localDirectory = new URL('../fixtures/local-web-request-mode', import.meta.url).pathname
const payloadPath = new URL('../fixtures/local-web-request-mode/payload.bin', import.meta.url)
  .pathname

interface WebRequestRecord {
  url: string
  type: string
}

interface WebRequestHeader {
  name: string
  value: string
}

interface WebRequestLifecycleEvent {
  event: string
  url: string
  requestId: string
  type: string
  statusCode?: number
  statusLine?: string
  requestHeaders?: WebRequestHeader[]
  responseHeaders?: WebRequestHeader[]
  redirectUrl?: string
  error?: string
  isProxy?: boolean
  challenger?: { host: string; port: number }
  scheme?: string
  realm?: string
}

interface WebRequestObservations {
  ordinary: WebRequestRecord[]
  events: WebRequestLifecycleEvent[]
  registered: string[]
  registrationErrors: { eventName: string; message: string }[]
  blocking: WebRequestRecord[]
  responseHeaders: {
    url: string
    statusCode: number
    statusLine: string
    headers: WebRequestHeader[]
  }[]
  headerChanges: { url: string; before?: string; after: string }[]
  bodyStreams: { url: string; bytes: number[] }[]
  byteChanges: { before: number; after: number }[]
  streamStops: string[]
}

const test = createFirefoxFixtures(baseTest, {
  extensionPaths: [extensionPath],
  headless: true,
  localMappings: { [mappedHost]: localDirectory }
})

test('localMappings and route.fulfill response fields are visible to webRequest', async ({
  page,
  extensions,
  request
}) => {
  const extension = extensions.values().next().value
  if (!extension?.background) throw new Error('The webRequest fixture must have a background page')
  const background = extension.background
  const authRouteHeaders: Record<string, string>[] = []
  // A real APIResponse is needed for this overload; stub only its request transport
  // so the test can exercise it without starting an HTTP server.
  const requestConnection = (
    request as unknown as {
      _connection: {
        sendMessageToServer: (...args: unknown[]) => Promise<unknown>
      }
    }
  )._connection
  const originalSendMessage = requestConnection.sendMessageToServer
  let apiResponseStubbed = false
  requestConnection.sendMessageToServer = async (...args: unknown[]) => {
    const [object, method] = args
    if (object === request && method === 'fetch') {
      apiResponseStubbed = true
      return {
        response: {
          url: `${mappedOrigin}/api-response-source`,
          status: 206,
          statusText: 'Partial Content',
          headers: [
            { name: 'content-type', value: 'application/octet-stream' },
            { name: 'x-harness-response', value: 'api-response' }
          ],
          fetchUid: 'api-response-fixture'
        }
      }
    }
    return originalSendMessage.call(requestConnection, ...args)
  }
  let apiResponse: APIResponse
  try {
    apiResponse = await request.get(`${mappedOrigin}/api-response-source`, { timeout: 1000 })
  } finally {
    requestConnection.sendMessageToServer = originalSendMessage
  }
  expect(apiResponseStubbed).toBe(true)
  const responseInternals = apiResponse as unknown as { _request: unknown }
  responseInternals._request = {
    _connection: {},
    _wrapApiCall: async (callback: () => Promise<unknown>) => callback(),
    _channel: {
      fetchResponseBody: async () => ({ binary: Buffer.from([0x61, 0x62]) })
    }
  }

  await page.route(statusUrl, (route) =>
    route.fulfill({
      status: 207,
      headers: {
        'content-type': 'application/octet-stream',
        'x-harness-response': 'route-fulfilled',
        'x-harness-extra': 'visible'
      },
      body: Buffer.from([0x52, 0x53, 0x50])
    })
  )
  await page.route(jsonUrl, (route) =>
    route.fulfill({
      status: 201,
      headers: { 'x-harness-response': 'json' },
      json: { fulfilled: true, count: 2 }
    })
  )
  await page.route(contentTypeUrl, (route) =>
    route.fulfill({
      status: 202,
      headers: { 'x-harness-response': 'content-type' },
      contentType: 'application/vnd.harness+json',
      body: 'typed-body'
    })
  )
  await page.route(pathUrl, (route) =>
    route.fulfill({
      status: 203,
      headers: { 'x-harness-response': 'path' },
      path: payloadPath
    })
  )
  await page.route(responseUrl, (route) => route.fulfill({ response: apiResponse }))
  await page.route(redirectUrl, (route) =>
    route.fulfill({
      status: 302,
      headers: { location: redirectTargetUrl },
      body: ''
    })
  )
  await page.route(abortUrl, (route) => route.abort('failed'))
  await page.route(requestHeadersUrl, (route) =>
    route.fulfill({
      status: 200,
      body: 'request headers'
    })
  )
  await page.route(blockingCancelUrl, (route) =>
    route.fulfill({
      status: 200,
      body: 'should be canceled'
    })
  )
  await page.route(blockingRedirectUrl, (route) =>
    route.fulfill({
      status: 200,
      body: 'should be redirected'
    })
  )
  await page.route(authUrl, (route) => {
    const requestHeaders = route.request().headers()
    authRouteHeaders.push(requestHeaders)
    const authorization = requestHeaders.authorization
    if (authorization === 'Basic dGVzdC11c2VyOnRlc3QtcGFzc3dvcmQ=') {
      return route.fulfill({ status: 200, body: 'authenticated' })
    }
    return route.fulfill({
      status: 401,
      headers: { 'www-authenticate': 'Basic realm="harness"' },
      body: 'authentication challenge'
    })
  })
  await page.route(origin407Url, (route) =>
    route.fulfill({
      status: 407,
      headers: { 'proxy-authenticate': 'Basic realm="origin-only"' },
      body: 'origin 407'
    })
  )

  await page.goto(`${mappedOrigin}/`)
  await expect(page.locator('body')).toHaveAttribute('data-fixture', 'local-mappings-web-request')

  const response = await page.evaluate(async () => {
    const fulfilled = []
    for (const path of ['/status', '/json', '/typed', '/path', '/response']) {
      const response = await fetch(path, { cache: 'no-store' })
      fulfilled.push({
        path,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        bytes: Array.from(new Uint8Array(await response.arrayBuffer()))
      })
    }
    const redirected = await fetch('/redirect', { cache: 'no-store' })
    const redirectedResponse = {
      status: redirected.status,
      url: redirected.url,
      body: await redirected.text()
    }
    const blockingRedirect = await fetch('/blocking-redirect', { cache: 'no-store' })
    const blockingRedirectResponse = {
      status: blockingRedirect.status,
      url: blockingRedirect.url,
      body: await blockingRedirect.text()
    }
    let abortError = ''
    try {
      await fetch('/abort', { cache: 'no-store' })
    } catch (error) {
      abortError = String(error)
    }
    let blockingCancelError = ''
    try {
      await fetch('/blocking-cancel', { cache: 'no-store' })
    } catch (error) {
      blockingCancelError = String(error)
    }

    let authStatus: number | null = null
    let authBody = ''
    let authError = ''
    try {
      const auth = await fetch('/auth', { cache: 'no-store' })
      authStatus = auth.status
      authBody = await auth.text()
    } catch (error) {
      authError = String(error)
    }
    let origin407Status: number | null = null
    let origin407Error = ''
    try {
      const origin407 = await fetch('/origin-407', { cache: 'no-store' })
      origin407Status = origin407.status
      await origin407.arrayBuffer()
    } catch (error) {
      origin407Error = String(error)
    }
    const requestHeadersResponse = await fetch('/request-headers', {
      cache: 'no-store',
      headers: { 'x-harness-request': 'original' }
    })
    const requestHeadersStatus = requestHeadersResponse.status
    await requestHeadersResponse.arrayBuffer()
    const mapped = await fetch('/payload.bin', { cache: 'no-store' })
    return {
      fulfilled,
      redirected: redirectedResponse,
      blockingRedirected: blockingRedirectResponse,
      abortError,
      blockingCancelError,
      authStatus,
      authError,
      authBody,
      requestHeadersStatus,
      origin407Status,
      origin407Error,
      mappedStatus: mapped.status,
      mappedBytes: Array.from(new Uint8Array(await mapped.arrayBuffer()))
    }
  })

  await page.waitForLoadState('networkidle')
  expect(authRouteHeaders).toHaveLength(2)
  expect(authRouteHeaders[1]).toMatchObject({
    authorization: 'Basic dGVzdC11c2VyOnRlc3QtcGFzc3dvcmQ='
  })
  const jsonBody = JSON.stringify({ fulfilled: true, count: 2 })

  const readObservations = () =>
    background.evaluate<WebRequestObservations>(() => {
      const observations = (
        globalThis as unknown as { localMappingsWebRequestObservations: WebRequestObservations }
      ).localMappingsWebRequestObservations
      return JSON.parse(JSON.stringify(observations)) as WebRequestObservations
    })

  const expectedStatuses = [
    [statusUrl, 207],
    [jsonUrl, 201],
    [contentTypeUrl, 202],
    [pathUrl, 203],
    [responseUrl, 206]
  ] as const
  const allLifecycleEventNames = [
    'onBeforeRequest',
    'onBeforeSendHeaders',
    'onSendHeaders',
    'onHeadersReceived',
    'onAuthRequired',
    'onBeforeRedirect',
    'onResponseStarted',
    'onCompleted',
    'onErrorOccurred'
  ]
  const expectedLifecycleEvents = expectedStatuses.flatMap(([url, statusCode]) => [
    { event: 'onBeforeRequest', url },
    { event: 'onBeforeSendHeaders', url },
    { event: 'onSendHeaders', url },
    { event: 'onHeadersReceived', url, statusCode },
    { event: 'onResponseStarted', url, statusCode },
    { event: 'onCompleted', url, statusCode }
  ])
  const expectedHeaders = [
    [statusUrl, 'content-type', 'application/octet-stream'],
    [statusUrl, 'content-length', '3'],
    [statusUrl, 'x-harness-response', 'route-fulfilled'],
    [statusUrl, 'x-harness-extra', 'visible'],
    [jsonUrl, 'content-type', 'application/json'],
    [jsonUrl, 'content-length', String(new TextEncoder().encode(jsonBody).length)],
    [jsonUrl, 'x-harness-response', 'json'],
    [contentTypeUrl, 'content-type', 'application/vnd.harness+json'],
    [contentTypeUrl, 'content-length', '10'],
    [contentTypeUrl, 'x-harness-response', 'content-type'],
    [pathUrl, 'content-type', 'application/octet-stream'],
    [pathUrl, 'content-length', '3'],
    [pathUrl, 'x-harness-response', 'path'],
    [responseUrl, 'content-type', 'application/octet-stream'],
    [responseUrl, 'content-length', '2'],
    [responseUrl, 'x-harness-response', 'api-response']
  ] as const
  const expectedBodies = [
    [statusUrl, [0x52, 0x53, 0x50]],
    [jsonUrl, Array.from(new TextEncoder().encode(jsonBody))],
    [contentTypeUrl, Array.from(new TextEncoder().encode('typed-body'))],
    [pathUrl, [0x41, 0x42, 0x43]],
    [responseUrl, [0x61, 0x62]]
  ] as const

  await expect.poll(readObservations).toMatchObject({
    ordinary: expect.arrayContaining(
      [
        `${mappedOrigin}/`,
        statusUrl,
        jsonUrl,
        contentTypeUrl,
        pathUrl,
        payloadUrl,
        authUrl,
        blockingCancelUrl,
        blockingRedirectUrl,
        requestHeadersUrl
      ].map((url) => expect.objectContaining({ url }))
    ),
    blocking: expect.arrayContaining(
      [statusUrl, jsonUrl, contentTypeUrl, pathUrl, payloadUrl].map((url) =>
        expect.objectContaining({ url, type: 'xmlhttprequest' })
      )
    ),
    registered: expect.arrayContaining([
      ...allLifecycleEventNames,
      'blocking.filterResponseData',
      'onHeadersReceived.blocking',
      'onBeforeSendHeaders.blocking',
      'onAuthRequired.blocking'
    ]),
    headerChanges: expect.arrayContaining([
      expect.objectContaining({
        url: statusUrl,
        before: 'route-fulfilled',
        after: 'modified-by-webRequest'
      })
    ]),
    registrationErrors: [],
    blockingDecisions: expect.arrayContaining([
      expect.objectContaining({ url: blockingCancelUrl, action: 'cancel' }),
      expect.objectContaining({
        url: blockingRedirectUrl,
        action: 'redirect',
        redirectUrl: redirectTargetUrl
      }),
      expect.objectContaining({ url: requestHeadersUrl, action: 'requestHeaders' })
    ]),
    events: expect.arrayContaining([
      ...expectedLifecycleEvents.map((event) => expect.objectContaining(event)),
      expect.objectContaining({ url: blockingCancelUrl, event: 'onErrorOccurred' }),
      expect.objectContaining({
        url: blockingRedirectUrl,
        event: 'onBeforeRedirect',
        redirectUrl: redirectTargetUrl
      }),
      expect.objectContaining({
        url: requestHeadersUrl,
        event: 'onSendHeaders',
        requestHeaders: expect.arrayContaining([
          { name: 'x-harness-request', value: 'modified-by-webRequest' }
        ])
      }),
      expect.objectContaining({
        url: authUrl,
        event: 'onBeforeSendHeaders',
        requestHeaders: expect.arrayContaining([
          {
            name: 'authorization',
            value: 'Basic dGVzdC11c2VyOnRlc3QtcGFzc3dvcmQ='
          }
        ])
      })
    ]),
    responseHeaders: expect.arrayContaining(
      expectedStatuses.map(([url, statusCode]) => expect.objectContaining({ url, statusCode }))
    ),
    bodyStreams: expect.arrayContaining(
      expectedBodies.map(([url, bytes]) => expect.objectContaining({ url, bytes }))
    ),
    byteChanges: [{ before: 0x41, after: 0x5a }],
    streamStops: expect.arrayContaining([statusUrl, jsonUrl, contentTypeUrl, pathUrl, payloadUrl])
  })
  expect(response.fulfilled).toMatchObject([
    {
      path: '/status',
      status: 207,
      headers: expect.objectContaining({
        'content-type': 'application/octet-stream',
        'content-length': '3',
        'x-harness-response': 'modified-by-webRequest',
        'x-webrequest-blocking': 'changed',
        'x-harness-extra': 'visible'
      }),
      bytes: [0x52, 0x53, 0x50]
    },
    {
      path: '/json',
      status: 201,
      headers: expect.objectContaining({
        'content-type': 'application/json',
        'content-length': String(new TextEncoder().encode(jsonBody).length),
        'x-harness-response': 'json'
      }),
      bytes: Array.from(new TextEncoder().encode(jsonBody))
    },
    {
      path: '/typed',
      status: 202,
      headers: expect.objectContaining({
        'content-type': 'application/vnd.harness+json',
        'content-length': '10',
        'x-harness-response': 'content-type'
      }),
      bytes: Array.from(new TextEncoder().encode('typed-body'))
    },
    {
      path: '/path',
      status: 203,
      headers: expect.objectContaining({
        'content-type': 'application/octet-stream',
        'content-length': '3',
        'x-harness-response': 'path'
      }),
      bytes: [0x41, 0x42, 0x43]
    },
    {
      path: '/response',
      status: 206,
      headers: expect.objectContaining({
        'content-type': 'application/octet-stream',
        'content-length': '2',
        'x-harness-response': 'api-response'
      }),
      bytes: [0x61, 0x62]
    }
  ])
  expect(response.mappedStatus).toBe(200)
  expect(response.mappedBytes).toEqual([0x5a, 0x42, 0x43])
  expect(response.redirected).toEqual({
    status: 200,
    url: redirectTargetUrl,
    body: 'redirected'
  })
  expect(response.blockingRedirected).toEqual({
    status: 200,
    url: redirectTargetUrl,
    body: 'redirected'
  })
  expect(response.blockingCancelError).toBeTruthy()
  expect(response.requestHeadersStatus).toBe(200)
  expect(response.abortError).toBeTruthy()

  const observations = await readObservations()
  for (const [url, name, value] of expectedHeaders) {
    const responseHeaders = observations.responseHeaders.find((entry) => entry.url === url)?.headers
    expect(responseHeaders).toBeDefined()
    expect(responseHeaders).toContainEqual({ name, value })
  }
  expect(response.authStatus).toBe(200)
  expect(response.authError).toBe('')
  expect(response.authBody).toBe('authenticated')
  expect(
    observations.events.filter(
      (event) => event.url === origin407Url && event.event === 'onAuthRequired'
    )
  ).toHaveLength(0)
  const redirectRequest = observations.events.find(
    (event) => event.url === redirectUrl && event.event === 'onBeforeRequest'
  )
  const redirectRequestId = redirectRequest?.requestId
  expect(redirectRequestId).toBeDefined()
  const redirectEvent = observations.events.find(
    (event) => event.url === redirectUrl && event.event === 'onBeforeRedirect'
  )
  expect(redirectEvent).toMatchObject({
    redirectUrl: redirectTargetUrl,
    statusCode: 302
  })
  expect(redirectEvent?.requestId).toBe(redirectRequestId)
  const redirectChain = observations.events
    .filter((event) => event.requestId === redirectRequestId && event.url === redirectUrl)
    .map((event) => event.event)
  const redirectPhases = [
    'onBeforeRequest',
    'onBeforeSendHeaders',
    'onSendHeaders',
    'onHeadersReceived',
    'onBeforeRedirect'
  ].map((event) => redirectChain.indexOf(event))
  expect(redirectPhases.every((index) => index !== -1)).toBe(true)
  expect(redirectPhases).toEqual([...redirectPhases].sort((first, second) => first - second))
  for (const eventName of [
    'onBeforeRequest',
    'onBeforeSendHeaders',
    'onSendHeaders',
    'onHeadersReceived',
    'onBeforeRedirect'
  ]) {
    expect(
      observations.events.filter(
        (event) =>
          event.requestId === redirectRequestId &&
          event.url === redirectUrl &&
          event.event === eventName
      )
    ).toHaveLength(1)
  }
  expect(redirectChain).not.toContain('onResponseStarted')
  expect(redirectChain).not.toContain('onCompleted')

  const blockingRedirectRequest = observations.events.find(
    (event) => event.url === blockingRedirectUrl && event.event === 'onBeforeRequest'
  )
  const blockingRedirectEvent = observations.events.find(
    (event) => event.url === blockingRedirectUrl && event.event === 'onBeforeRedirect'
  )
  expect(blockingRedirectEvent).toMatchObject({ redirectUrl: redirectTargetUrl })
  expect(blockingRedirectEvent?.requestId).toBe(blockingRedirectRequest?.requestId)
  expect(
    observations.events.filter(
      (event) =>
        event.url === blockingRedirectUrl &&
        (event.event === 'onResponseStarted' || event.event === 'onCompleted')
    )
  ).toHaveLength(0)

  const abortRequest = observations.events.find(
    (event) => event.url === abortUrl && event.event === 'onBeforeRequest'
  )
  expect(abortRequest).toBeDefined()
  const abortEvent = observations.events.find(
    (event) => event.url === abortUrl && event.event === 'onErrorOccurred'
  )
  expect(abortEvent).toBeDefined()
  expect(abortEvent?.error).toBeTruthy()
  expect(abortEvent?.requestId).toBe(abortRequest?.requestId)
  expect(
    observations.events.filter(
      (event) => event.url === abortUrl && event.event === 'onErrorOccurred'
    )
  ).toHaveLength(1)

  const blockingCancelRequest = observations.events.find(
    (event) => event.url === blockingCancelUrl && event.event === 'onBeforeRequest'
  )
  const blockingCancelEvent = observations.events.find(
    (event) => event.url === blockingCancelUrl && event.event === 'onErrorOccurred'
  )
  expect(blockingCancelEvent).toBeDefined()
  expect(blockingCancelEvent?.requestId).toBe(blockingCancelRequest?.requestId)
  for (const eventName of ['onHeadersReceived', 'onResponseStarted', 'onCompleted']) {
    expect(
      observations.events.filter(
        (event) => event.url === blockingCancelUrl && event.event === eventName
      )
    ).toHaveLength(0)
  }

  const headerEvents = observations.events.filter((event) => event.url === requestHeadersUrl)
  const beforeSendHeaders = headerEvents.find((event) => event.event === 'onBeforeSendHeaders')
  const sendHeaders = headerEvents.find((event) => event.event === 'onSendHeaders')
  expect(beforeSendHeaders?.requestHeaders).toContainEqual({
    name: 'x-harness-request',
    value: 'original'
  })
  expect(sendHeaders?.requestHeaders).toContainEqual({
    name: 'x-harness-request',
    value: 'modified-by-webRequest'
  })

  const authRequest = observations.events.find(
    (event) => event.url === authUrl && event.event === 'onBeforeRequest'
  )
  const authEvent = observations.events.find(
    (event) => event.url === authUrl && event.event === 'onAuthRequired'
  )
  expect(authEvent).toMatchObject({ statusCode: 401, scheme: 'basic', realm: 'harness' })
  expect(authEvent?.requestId).toBe(authRequest?.requestId)
  expect(
    observations.events.filter((event) => event.url === authUrl && event.event === 'onAuthRequired')
  ).toHaveLength(1)

  expect(response.origin407Status === 407 || response.origin407Error !== '').toBe(true)
  expect(
    observations.events.filter(
      (event) => event.url === origin407Url && event.event === 'onAuthRequired'
    )
  ).toHaveLength(0)
  for (const [url] of expectedStatuses) {
    const requestEvents = observations.events.filter((event) => event.url === url)
    const requestIds = new Set(requestEvents.map((event) => event.requestId))
    expect(requestIds.size).toBe(1)
    const [requestId] = requestIds
    const eventNames = requestEvents
      .filter((event) => event.requestId === requestId)
      .map((event) => event.event)
    const eventOrder = [
      'onBeforeRequest',
      'onBeforeSendHeaders',
      'onSendHeaders',
      'onHeadersReceived',
      'onResponseStarted',
      'onCompleted'
    ].map((event) => eventNames.indexOf(event))
    expect(eventOrder.every((index) => index !== -1)).toBe(true)
    expect(eventOrder).toEqual([...eventOrder].sort((first, second) => first - second))
  }
  for (const [url] of expectedStatuses) {
    for (const eventName of [
      'onBeforeRequest',
      'onBeforeSendHeaders',
      'onSendHeaders',
      'onHeadersReceived',
      'onResponseStarted',
      'onCompleted'
    ]) {
      expect(
        observations.events.filter((event) => event.url === url && event.event === eventName)
      ).toHaveLength(1)
    }
    for (const eventName of ['onAuthRequired', 'onBeforeRedirect', 'onErrorOccurred']) {
      expect(
        observations.events.filter((event) => event.url === url && event.event === eventName)
      ).toHaveLength(0)
    }
  }
  const statusCompletionEvents = observations.events.filter(
    (event) => event.url === statusUrl && ['onResponseStarted', 'onCompleted'].includes(event.event)
  )
  for (const event of statusCompletionEvents) {
    expect(event.responseHeaders).toContainEqual({
      name: 'x-harness-response',
      value: 'modified-by-webRequest'
    })
    expect(event.responseHeaders).toContainEqual({
      name: 'x-webrequest-blocking',
      value: 'changed'
    })
  }
})
test('route.fulfill does not replay credentials for non-Basic challenges', async ({
  page,
  extensions
}) => {
  const extension = extensions.values().next().value
  if (!extension?.background) throw new Error('The webRequest fixture must have a background page')
  const background = extension.background
  const routeAuthorizations: (string | undefined)[] = []

  await page.route(authUrl, (route) => {
    routeAuthorizations.push(route.request().headers().authorization)
    return route.fulfill({
      status: 401,
      headers: {
        'www-authenticate': 'Digest realm="harness", nonce="digest-nonce", qop="auth"'
      },
      body: 'digest challenge'
    })
  })
  await page.goto(`${mappedOrigin}/`)
  await expect(page.locator('body')).toHaveAttribute('data-fixture', 'local-mappings-web-request')

  const result = await page.evaluate(async () => {
    try {
      const response = await fetch('/auth', { cache: 'no-store' })
      return { status: response.status, error: '' }
    } catch (error) {
      return { status: 0, error: String(error) }
    }
  })
  expect(routeAuthorizations).toEqual([undefined])
  expect(result.status === 401 || !!result.error).toBe(true)

  const authEvents = await background.evaluate(() => {
    const observations = (
      globalThis as unknown as { localMappingsWebRequestObservations: WebRequestObservations }
    ).localMappingsWebRequestObservations
    return observations.events.filter(
      (event) => event.url.endsWith('/auth') && event.event === 'onAuthRequired'
    )
  })
  expect(authEvents).toHaveLength(1)
  expect(authEvents[0]).toMatchObject({ scheme: 'digest', realm: 'harness' })
})

test('onSendHeaders sees request headers changed by blocking listeners', async ({
  page,
  extensions
}) => {
  const extension = extensions.values().next().value
  if (!extension?.background) throw new Error('The webRequest fixture must have a background page')
  const background = extension.background

  await page.route(requestHeadersUrl, (route) =>
    route.fulfill({ status: 200, body: 'request headers' })
  )
  await page.goto(`${mappedOrigin}/`)
  await expect(page.locator('body')).toHaveAttribute('data-fixture', 'local-mappings-web-request')
  const response = await page.evaluate(async () => {
    const result = await fetch('/request-headers', {
      cache: 'no-store',
      headers: { 'x-harness-request': 'original' }
    })
    return { status: result.status, body: await result.text() }
  })
  expect(response).toEqual({ status: 200, body: 'request headers' })

  const readRequestHeaderEvents = () =>
    background.evaluate(() => {
      const observations = (
        globalThis as unknown as { localMappingsWebRequestObservations: WebRequestObservations }
      ).localMappingsWebRequestObservations
      return observations.events.filter(
        (event) => event.url === 'https://web-request.localhost/request-headers'
      )
    })
  await expect
    .poll(async () => {
      const events = await readRequestHeaderEvents()
      const before = events.find((event) => event.event === 'onBeforeSendHeaders')
      const sent = events.find((event) => event.event === 'onSendHeaders')
      return {
        before: before?.requestHeaders?.find((header) => header.name === 'x-harness-request')
          ?.value,
        after: sent?.requestHeaders?.find((header) => header.name === 'x-harness-request')?.value
      }
    })
    .toEqual({ before: 'original', after: 'modified-by-webRequest' })
})

const testWithoutWebRequest = createFirefoxFixtures(baseTest, {
  extensionPaths: [],
  headless: true
})

testWithoutWebRequest(
  'route.fulfill completes without a WebRequest extension',
  async ({ page }) => {
    const origin = 'https://no-webrequest.localhost'
    await page.route(`${origin}/**`, (route) => {
      const pathname = new URL(route.request().url()).pathname
      if (pathname === '/') {
        return route.fulfill({
          status: 209,
          contentType: 'text/html',
          body: '<!doctype html><body>fulfilled without WebRequest</body>'
        })
      }
      return route.fulfill({ status: 209, body: 'fulfilled response' })
    })

    const navigation = await page.goto(`${origin}/`)
    expect(navigation?.status()).toBe(209)
    const response = await page.evaluate(async () => {
      const result = await fetch('/fulfilled')
      return { status: result.status, body: await result.text() }
    })
    expect(response).toEqual({ status: 209, body: 'fulfilled response' })
  }
)

const testWithNoWebRequestListeners = createFirefoxFixtures(baseTest, {
  extensionPaths: [noListenerExtensionPath],
  headless: true
})

testWithNoWebRequestListeners(
  'route.fulfill completes when WebRequest is loaded without listeners',
  async ({ page, extensions }) => {
    const extension = extensions.values().next().value
    const background = extension?.background
    if (!background)
      throw new Error('The no-listener WebRequest fixture must have a background page')
    await expect
      .poll(() => background.evaluate<boolean>(() => globalThis.webRequestApiReady))
      .toBe(true)

    const origin = 'https://no-listener-webrequest.localhost'
    await page.route(`${origin}/**`, (route) => {
      const pathname = new URL(route.request().url()).pathname
      if (pathname === '/') {
        return route.fulfill({
          status: 209,
          contentType: 'text/html',
          body: '<!doctype html><body>fulfilled without listeners</body>'
        })
      }
      return route.fulfill({ status: 200, body: '' })
    })

    const response = await page.goto(`${origin}/`)
    expect(response?.status()).toBe(209)
    await expect(page.locator('body')).toHaveText('fulfilled without listeners')
  }
)
