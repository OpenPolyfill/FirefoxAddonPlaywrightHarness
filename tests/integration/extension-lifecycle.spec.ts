import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
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
async function setManifestVersion(extensionPath: string, version: string): Promise<void> {
  const manifestPath = join(extensionPath, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  manifest.version = version
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
}

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
  await first.reload()
  expect(first.background).toBeUndefined()
  expect(extensions.get(first.id)).toBe(first)
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

test('replaces the same Gecko ID from a directory and XPI while preserving its handle', async ({
  extensions,
  page
}) => {
  const extension = extensions.get('lifecycle-one@example.org')
  const sibling = extensions.get('lifecycle-two@example.org')
  if (!extension || !sibling?.background || !extension.background)
    throw new Error('Replacement fixtures must expose both background contexts')
  const siblingBackground = sibling.background
  const collectionSize = extensions.size
  await page.route('https://replacement.example/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<main>Replacement page</main>' })
  )
  await page.goto('https://replacement.example/')
  const staleIsolatedBeforeDirectory = extension.isolated
  expect(await staleIsolatedBeforeDirectory.evaluate('location.hostname')).toBe(
    'replacement.example'
  )
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'firefox-elc-replacement-'))

  try {
    const directoryReplacement = join(temporaryDirectory, 'directory')
    await cp(lifecycleOne, directoryReplacement, { recursive: true })
    await setManifestVersion(directoryReplacement, '2.0')

    const staleBeforeDirectory = extension.background
    const popup = await extension.activateAction(page, 'browserAction')
    const directoryHandle = await extensions.install(directoryReplacement)
    expect(directoryHandle).toBe(extension)
    expect(extensions.get(extension.id)).toBe(extension)
    expect(extensions.size).toBe(collectionSize)
    expect(extension.installPath).toBe(directoryReplacement)
    expect(popup.isClosed()).toBe(true)
    await expect(staleBeforeDirectory.evaluate('browser.runtime.id')).rejects.toThrow(/disposed/)
    await expect(staleIsolatedBeforeDirectory.evaluate('location.hostname')).rejects.toThrow(
      /stale/
    )
    expect(await extension.background!.evaluate('browser.runtime.getManifest().version')).toBe(
      '2.0'
    )

    const staleBeforeReload = extension.background
    await setManifestVersion(directoryReplacement, '2.1')
    const reloadOperation = extension.reload()
    const replacementOperation = extensions.install(directoryReplacement)
    const [, concurrentReplacement] = await Promise.all([reloadOperation, replacementOperation])
    expect(concurrentReplacement).toBe(extension)
    expect(extensions.size).toBe(collectionSize)
    await expect(staleBeforeReload!.evaluate('browser.runtime.id')).rejects.toThrow(/disposed/)
    expect(await extension.background!.evaluate('browser.runtime.getManifest().version')).toBe(
      '2.1'
    )

    const staleIsolatedBeforeXpi = extension.isolated
    expect(await staleIsolatedBeforeXpi.evaluate('location.hostname')).toBe('replacement.example')
    await setManifestVersion(directoryReplacement, '3.0')
    const archive = new JSZip()
    for (const filename of ['manifest.json', 'background.js', 'popup.html'])
      archive.file(filename, await readFile(join(directoryReplacement, filename)))
    const xpiReplacement = join(temporaryDirectory, 'replacement.xpi')
    await writeFile(xpiReplacement, await archive.generateAsync({ type: 'nodebuffer' }))

    const staleBeforeXpi = extension.background
    const replacementPopup = await extension.activateAction(page, 'browserAction')
    const xpiHandle = await extensions.install(xpiReplacement)
    expect(xpiHandle).toBe(extension)
    expect(extensions.get(extension.id)).toBe(extension)
    expect(extensions.size).toBe(collectionSize)
    expect(extension.installPath).toBe(xpiReplacement)
    expect(replacementPopup.isClosed()).toBe(true)
    await expect(staleBeforeXpi!.evaluate('browser.runtime.id')).rejects.toThrow(/disposed/)
    await expect(staleIsolatedBeforeXpi.evaluate('location.hostname')).rejects.toThrow(/stale/)
    expect(await extension.background!.evaluate('browser.runtime.getManifest().version')).toBe(
      '3.0'
    )
    expect(sibling.background).toBe(siblingBackground)
    expect(await sibling.background.evaluate('browser.runtime.id')).toBe(sibling.id)
  } finally {
    if (extensions.has(extension.id)) await extension.uninstall().catch(() => undefined)
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
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
