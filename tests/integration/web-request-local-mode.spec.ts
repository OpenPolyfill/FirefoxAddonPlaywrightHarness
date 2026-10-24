import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'

const mappedOrigin = 'https://web-request.localhost'
const mappedHost = 'web-request.localhost'
const statusUrl = `${mappedOrigin}/status`
const payloadUrl = `${mappedOrigin}/payload.bin`
const extensionPath = new URL('../fixtures/web-request-local-mode-extension', import.meta.url)
  .pathname
const localDirectory = new URL('../fixtures/local-web-request-mode', import.meta.url).pathname

interface WebRequestRecord {
  url: string
  type: string
}

interface WebRequestObservations {
  ordinary: WebRequestRecord[]
  blocking: WebRequestRecord[]
  byteChanges: { before: number; after: number }[]
  streamStops: number
}

const test = createFirefoxFixtures(baseTest, {
  extensionPaths: [extensionPath],
  headless: true,
  localMappings: { [mappedHost]: localDirectory }
})

test('localMappings requests retain response metadata and flow through webRequest listeners', async ({
  page,
  extensions
}) => {
  const extension = extensions.values().next().value
  if (!extension?.background) throw new Error('The webRequest fixture must have a background page')
  const background = extension.background

  await page.route(statusUrl, (route) =>
    route.fulfill({
      status: 207,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-harness-response': 'route-fulfilled'
      },
      body: 'route response'
    })
  )
  await page.goto(`${mappedOrigin}/`)
  await expect(page.locator('body')).toHaveAttribute('data-fixture', 'local-mappings-web-request')

  const response = await page.evaluate(async () => {
    const fulfilled = await fetch('/status', { cache: 'no-store' })
    const fulfilledResult = {
      status: fulfilled.status,
      header: fulfilled.headers.get('x-harness-response'),
      contentType: fulfilled.headers.get('content-type'),
      body: await fulfilled.text()
    }
    const mapped = await fetch('/payload.bin', { cache: 'no-store' })
    return {
      fulfilled: fulfilledResult,
      mappedStatus: mapped.status,
      mappedBytes: Array.from(new Uint8Array(await mapped.arrayBuffer()))
    }
  })

  expect(response.fulfilled).toEqual({
    status: 207,
    header: 'route-fulfilled',
    contentType: 'text/plain; charset=utf-8',
    body: 'route response'
  })
  expect(response.mappedStatus).toBe(200)
  expect(response.mappedBytes).toEqual([0x5a, 0x42, 0x43])

  const readObservations = () =>
    background.evaluate<WebRequestObservations>(() => {
      const observations = (
        globalThis as unknown as { localMappingsWebRequestObservations: WebRequestObservations }
      ).localMappingsWebRequestObservations
      return JSON.parse(JSON.stringify(observations)) as WebRequestObservations
    })

  await expect.poll(readObservations).toMatchObject({
    ordinary: expect.arrayContaining([
      expect.objectContaining({ url: `${mappedOrigin}/` }),
      expect.objectContaining({ url: statusUrl }),
      expect.objectContaining({ url: payloadUrl })
    ]),
    blocking: expect.arrayContaining([
      expect.objectContaining({ url: payloadUrl, type: 'xmlhttprequest' })
    ]),
    byteChanges: [{ before: 0x41, after: 0x5a }],
    streamStops: 1
  })
})
