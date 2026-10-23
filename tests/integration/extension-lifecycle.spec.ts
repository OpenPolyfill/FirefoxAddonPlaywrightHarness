import { baseTest, expect } from './fixtures.js'
import { createFirefoxFixtures } from '../../src/fixtures.js'
import type { FirefoxExtension } from '../../src/types.js'

const lifecycleOne = new URL('../fixtures/lifecycle-one', import.meta.url).pathname
const lifecycleTwo = new URL('../fixtures/lifecycle-two', import.meta.url).pathname
const unpackedExtension = new URL('../fixtures/no-background-extension', import.meta.url).pathname
const packedExtension = new URL('../fixtures/no-background-extension.xpi', import.meta.url).pathname
const sidebarExtensionPath = new URL('../fixtures/sidebar-action-extension', import.meta.url)
  .pathname

const test = createFirefoxFixtures(baseTest, {
  extensionPaths: [lifecycleOne, lifecycleTwo],
  headless: true
})

test('controls extension lifecycles independently and invalidates stale contexts', async ({
  extensions,
  page
}) => {
  const first = extensions.get('lifecycle-one@example.org')
  const second = extensions.get('lifecycle-two@example.org')
  if (!first || !second) throw new Error('Initial extension collection is incomplete')
  if (!first.background || !second.background)
    throw new Error('Lifecycle fixtures must expose background contexts')

  expect(extensions.size).toBe(2)
  const secondBackground = second.background
  const secondToken = await secondBackground.evaluate('globalThis.harnessBootToken')
  const staleBackground = first.background
  const firstToken = await staleBackground.evaluate('globalThis.harnessBootToken')

  await page.route('https://lifecycle.example/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<main>Lifecycle page</main>' })
  )
  await page.goto('https://lifecycle.example/')
  const staleIsolated = first.isolated
  expect(await staleIsolated.evaluate('location.hostname')).toBe('lifecycle.example')
  const popup = await first.activateAction(page, 'browserAction')
  await popup.locator('button').click()
  await first.reload()

  expect(extensions.get(first.id)).toBe(first)
  expect(first.background).toBeDefined()
  expect(first.background).not.toBe(staleBackground)
  expect(await first.background!.evaluate('browser.runtime.id')).toBe(first.id)
  expect(await first.background!.evaluate('globalThis.harnessBootToken')).not.toBe(firstToken)
  expect(popup.isClosed()).toBe(true)
  await expect(staleBackground.evaluate('browser.runtime.id')).rejects.toThrow(/disposed/)
  await expect(staleIsolated.evaluate('location.hostname')).rejects.toThrow(/stale/)
  expect(second.background).toBe(secondBackground)
  expect(await second.background!.evaluate('browser.runtime.id')).toBe(second.id)
  expect(await second.background!.evaluate('globalThis.harnessBootToken')).toBe(secondToken)

  const beforeDisable = first.background
  if (!beforeDisable) throw new Error('First background disappeared before disable')
  await first.disable()
  expect(first.background).toBeUndefined()
  await expect(beforeDisable.evaluate('browser.runtime.id')).rejects.toThrow(/disposed/)
  expect(second.background).toBe(secondBackground)

  await first.enable()
  expect(extensions.get(first.id)).toBe(first)
  expect(first.background).toBeDefined()
  expect(await first.background!.evaluate('browser.runtime.id')).toBe(first.id)
  expect(second.background).toBe(secondBackground)

  await first.uninstall()
  expect(extensions.has(first.id)).toBe(false)
  expect(extensions.get(second.id)).toBe(second)
})

test('installs and uninstalls directories and XPI files at runtime', async ({ extensions }) => {
  const unpacked = await extensions.install(unpackedExtension)
  expect(extensions.has(unpacked.id)).toBe(true)
  await unpacked.uninstall()
  expect(extensions.has(unpacked.id)).toBe(false)

  const packed = await extensions.install(packedExtension)
  expect(extensions.has(packed.id)).toBe(true)
  await packed.uninstall()
  expect(extensions.has(packed.id)).toBe(false)
})

test('invalidates sidebar pages when an extension is disabled and uninstalled', async ({
  extensions,
  page
}) => {
  const extension = await extensions.install(sidebarExtensionPath)
  const sidebar = await extension.activateSidebar(page)
  await extension.disable()
  expect(sidebar.isClosed()).toBe(true)

  await extension.enable()
  const reopened = await extension.activateSidebar(page)
  await extension.uninstall()
  expect(reopened.isClosed()).toBe(true)
  expect(extensions.has(extension.id)).toBe(false)
})

const workerTest = createFirefoxFixtures(baseTest, {
  extensionPaths: [lifecycleOne],
  headless: true,
  contextScope: 'worker'
})
workerTest.describe.configure({ mode: 'serial' })
let retainedWorkerHandle: FirefoxExtension | undefined

workerTest('worker-scoped handle survives reload and disable', async ({ extensions }) => {
  const extension = extensions.get('lifecycle-one@example.org')
  if (!extension) throw new Error('Worker extension was not installed')
  retainedWorkerHandle = extension
  await extension.reload()
  await extension.disable()
})

workerTest(
  'worker-scoped handle is re-enabled without replacing its identity',
  async ({ extensions }) => {
    const extension = extensions.get('lifecycle-one@example.org')
    expect(extension).toBe(retainedWorkerHandle)
    if (!extension) throw new Error('Worker extension was not installed')
    await extension.enable()
    expect(extension.background).toBeDefined()
  }
)
