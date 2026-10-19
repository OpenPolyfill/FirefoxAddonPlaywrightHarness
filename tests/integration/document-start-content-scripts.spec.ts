import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import JSZip from 'jszip'
import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'

const extensionPath = fileURLToPath(new URL('../fixtures/document-start-mv3', import.meta.url))
const closedShadowPropertyName = 'openOrClosedShadowRoot'
const packedExtensionPath = join(tmpdir(), `document-start-mv3-${randomUUID()}.xpi`)
const test = createFirefoxFixtures(baseTest, { extensionPath, headless: true })
const packedTest = createFirefoxFixtures(baseTest, {
  extensionPath: packedExtensionPath,
  headless: true
})

packedTest.beforeAll(async () => {
  const archive = new JSZip()
  for (const filename of ['manifest.json', 'main-world.js', 'isolated-world.js'])
    archive.file(filename, await readFile(join(extensionPath, filename)))
  await writeFile(packedExtensionPath, await archive.generateAsync({ type: 'nodebuffer' }))
})

packedTest.afterAll(async () => {
  await rm(packedExtensionPath, { force: true })
})

async function assertDocumentStartGetterIsolation(page: Page): Promise<void> {
  await page.route('https://example.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
        <html><body>
          <script>window.__utilityGetterVisibleToPage = Object.prototype.hasOwnProperty.call(window, ${JSON.stringify(closedShadowPropertyName)})</script>
          <div id="main-world-host"></div>
          <div id="isolated-world-host"></div>
        </body></html>`
    })
  )
  await page.goto('https://example.com/')
  expect(await page.locator('html').getAttribute('data-utility-getter-visible-to-addon')).toBe(
    'false'
  )
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __utilityGetterVisibleToPage?: boolean })
          .__utilityGetterVisibleToPage
    )
  ).toBe(false)
  expect(
    await page.evaluate(
      (name: string) => ({
        type: typeof (globalThis as typeof globalThis & Record<string, unknown>)[name],
        own: Object.prototype.hasOwnProperty.call(globalThis, name)
      }),
      closedShadowPropertyName
    )
  ).toEqual({ type: 'undefined', own: false })

  for (const { host, text, action } of [
    {
      host: '#main-world-host',
      text: 'MAIN world closed root',
      action: 'MAIN action'
    },
    {
      host: '#isolated-world-host',
      text: 'ISOLATED world closed root',
      action: 'ISOLATED action'
    }
  ]) {
    await expect(page.locator(host)).toHaveAttribute('data-content-script-ready-state', 'loading')
    await expect(page.locator(host)).toHaveAttribute('data-closed-root-created', 'true')
    await expect(page.locator(`${host} >> css=span`)).toHaveText(text)
    await expect(page.getByText(text)).toBeVisible()
    await expect(page.getByRole('button', { name: action })).toBeVisible()
    expect(await page.locator(host).evaluate((element) => element.shadowRoot)).toBeNull()
    expect(
      await page.locator(host).evaluate((element) => {
        const root = (element as Element & { openOrClosedShadowRoot?: ShadowRoot })
          .openOrClosedShadowRoot
        return root !== undefined && root !== null
      })
    ).toBe(false)
  }
}

test('MV3 document_start scripts expose roots from MAIN and ISOLATED worlds', async ({ page }) =>
  assertDocumentStartGetterIsolation(page))

packedTest(
  'packed MV3 document_start exposes roots from MAIN and ISOLATED worlds',
  async ({ page }) => assertDocumentStartGetterIsolation(page)
)
