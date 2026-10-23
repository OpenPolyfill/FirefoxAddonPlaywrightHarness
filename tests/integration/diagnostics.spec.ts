import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'
import type { FirefoxErrorDiagnostic } from '../../src/diagnostics.js'
import type { InternalFirefoxContext } from '../../src/types.js'

const test = createFirefoxFixtures(baseTest, {
  extensionPaths: [new URL('../fixtures/diagnostics-extension', import.meta.url).pathname],
  headless: true,
  contextScope: 'worker'
})

test.describe.configure({ mode: 'serial' })

test('collects startup, content-script, and browser-chrome errors', async ({
  context,
  extensions,
  page,
  rdp
}) => {
  const extension = extensions.values().next().value!
  const diagnostics = (context as InternalFirefoxContext)._firefoxHarnessDiagnostics
  expect(diagnostics).toBeTruthy()
  if (!diagnostics) throw new Error('Firefox error diagnostics were not initialized')

  await page.route('https://example.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html></html>' })
  )
  await page.goto('https://example.com/#harness-diagnostics')

  if (!extension.background) throw new Error('Diagnostics fixture has no extension background')
  await extension.background.evaluate(() => {
    console.error('DIAGNOSTIC_BACKGROUND_CONSOLE')
    setTimeout(() => {
      throw new Error('DIAGNOSTIC_BACKGROUND_EXCEPTION')
    }, 0)
  })

  const process = await rdp.root.getProcess(0)
  const targetResponse = await process.call('getTarget')
  const targetForm = object(object(targetResponse)?.process ?? targetResponse)
  const consoleActor = string(targetForm?.consoleActor)
  if (!consoleActor) throw new Error('Firefox process target has no console actor')
  await rdp.actor(consoleActor).call('evaluateJSAsync', {
    text: `(() => {
      console.error('DIAGNOSTIC_CHROME_CONSOLE')
      setTimeout(() => { throw new Error('DIAGNOSTIC_CHROME_EXCEPTION') }, 0)
      return true
    })()`
  })

  await expect
    .poll(
      () => {
        const messages = diagnostics
          .snapshot()
          .entries.map((entry) => entry.message)
          .join('\n')
        return [
          'DIAGNOSTIC_BACKGROUND_STARTUP_EXCEPTION',
          'DIAGNOSTIC_BACKGROUND_EXCEPTION',
          'DIAGNOSTIC_CONTENT_EXCEPTION',
          'DIAGNOSTIC_CHROME_EXCEPTION'
        ].every((marker) => messages.includes(marker))
      },
      { timeout: 10_000 }
    )
    .toBe(true)

  const entries = diagnostics.snapshot().entries
  const startupError = find(entries, 'DIAGNOSTIC_BACKGROUND_STARTUP_EXCEPTION')
  const backgroundError = find(entries, 'DIAGNOSTIC_BACKGROUND_EXCEPTION')
  const contentError = find(entries, 'DIAGNOSTIC_CONTENT_EXCEPTION')
  const chromeError = find(entries, 'DIAGNOSTIC_CHROME_EXCEPTION')
  expect(startupError?.executionContext).toBe('extension background')
  expect(startupError?.extensionId).toBe(extension.id)
  expect(backgroundError?.executionContext).toBe('extension background')
  expect(backgroundError?.extensionId).toBe(extension.id)
  expect(contentError?.executionContext).toBe('content script')
  expect(chromeError?.executionContext).toBe('browser chrome')
  expect(entries.some((entry) => entry.message.includes('DIAGNOSTIC_CONTENT_CONSOLE'))).toBe(true)
  expect(entries.some((entry) => entry.message.includes('DIAGNOSTIC_BACKGROUND_CONSOLE'))).toBe(
    true
  )
  expect(entries.some((entry) => entry.message.includes('DIAGNOSTIC_CHROME_CONSOLE'))).toBe(true)
  expect(backgroundError?.timestamp).toBeTruthy()
  expect(backgroundError?.stackTrace).toBeTruthy()
})

test('does not carry diagnostics over from the previous test', async ({ context }) => {
  const diagnostics = (context as InternalFirefoxContext)._firefoxHarnessDiagnostics
  expect(diagnostics).toBeTruthy()
  if (!diagnostics) throw new Error('Firefox error diagnostics were not initialized')

  const messages = diagnostics
    .snapshot()
    .entries.map((entry) => entry.message)
    .join('\n')
  expect(messages).not.toContain('DIAGNOSTIC_BACKGROUND_EXCEPTION')
  expect(messages).not.toContain('DIAGNOSTIC_CONTENT_EXCEPTION')
  expect(messages).not.toContain('DIAGNOSTIC_CHROME_EXCEPTION')
})

test('removes its RDP packet listener when closed', async ({ context, rdp }) => {
  const diagnostics = (context as InternalFirefoxContext)._firefoxHarnessDiagnostics
  expect(diagnostics).toBeTruthy()
  if (!diagnostics) throw new Error('Firefox error diagnostics were not initialized')

  const packetListeners = rdp.listenerCount('packet')
  await diagnostics.close()
  expect(rdp.listenerCount('packet')).toBe(packetListeners - 1)
})

function find(
  entries: FirefoxErrorDiagnostic[],
  marker: string
): FirefoxErrorDiagnostic | undefined {
  return entries.find((entry) => entry.message.includes(marker))
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
