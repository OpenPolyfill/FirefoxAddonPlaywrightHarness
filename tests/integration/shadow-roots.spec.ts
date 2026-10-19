import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'
import type { FirefoxIsolatedPage } from '../../src/types.js'
import type { Page } from '@playwright/test'

const extensionPath = new URL('../fixtures/no-background-browser-action', import.meta.url).pathname
const bootstrapGlobalPrefix = '__openpolyfillClosedShadowRootBootstrap_'

const test = createFirefoxFixtures(baseTest, { extensionPath, headless: true })

async function openHostPage(page: Page): Promise<void> {
  await page.route('https://example.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><body>
        <script>window.__sawTemporaryClosedShadowGetter = Object.getOwnPropertyNames(window).some((name) => name.startsWith(${JSON.stringify(bootstrapGlobalPrefix)}))</script>
        <div id="host"></div>
      </body></html>`
    })
  )
  await page.goto('https://example.com/')
}

async function assertBridgeHidden(page: Page, isolated: FirefoxIsolatedPage): Promise<void> {
  const pageGlobals = await page.evaluate((prefix: string) => {
    const globals = globalThis as typeof globalThis & Record<string, unknown>
    return {
      capability: typeof globals.__openpolyfillClosedShadowRootCapability__,
      getter: typeof globals.__openpolyfillClosedShadowRootGetter__,
      access: typeof globals.__openpolyfillClosedShadowRootForPlaywright__,
      temporaryGetter: Object.getOwnPropertyNames(globalThis).some((name) =>
        name.startsWith(prefix)
      ),
      visibleToPageScript: globals.__sawTemporaryClosedShadowGetter
    }
  }, bootstrapGlobalPrefix)
  expect(pageGlobals).toEqual({
    capability: 'undefined',
    getter: 'undefined',
    access: 'undefined',
    temporaryGetter: false,
    visibleToPageScript: false
  })

  const addonGlobals = await isolated.evaluate(() => {
    const globals = globalThis as typeof globalThis & Record<string, unknown>
    return {
      capability: typeof globals.__openpolyfillClosedShadowRootCapability__,
      getter: typeof globals.__openpolyfillClosedShadowRootGetter__,
      access: typeof globals.__openpolyfillClosedShadowRootForPlaywright__
    }
  })
  expect(addonGlobals).toEqual({
    capability: 'undefined',
    getter: 'undefined',
    access: 'undefined'
  })
}

test('Playwright locators pierce a page-created closed root without opening or exposing the bridge', async ({
  page,
  extension
}) => {
  await openHostPage(page)
  await page.evaluate(() => {
    const root = document.querySelector('#host')!.attachShadow({ mode: 'closed' })
    root.innerHTML = '<span>page realm</span><button>Launch</button>'
  })
  await expect(page.locator('#host >> css=span')).toHaveText('page realm')
  await expect(page.getByText('page realm')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Launch' })).toBeVisible()
  expect(await page.locator('#host').evaluate((host) => host.shadowRoot)).toBeNull()
  await assertBridgeHidden(page, extension.isolated)
})

test('Playwright locators pierce a closed root created from the isolated evaluator', async ({
  page,
  extension
}) => {
  await openHostPage(page)
  await extension.isolated.evaluate(() => {
    const root = document.querySelector('#host')!.attachShadow({ mode: 'closed' })
    root.innerHTML = '<span>isolated realm</span><button>Run</button>'
  })
  await expect(page.locator('#host >> css=span')).toHaveText('isolated realm')
  await expect(page.getByText('isolated realm')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Run' })).toBeVisible()
  expect(
    await extension.isolated.evaluate(() => document.querySelector('#host')!.shadowRoot)
  ).toBeNull()
  await assertBridgeHidden(page, extension.isolated)
})
test('Playwright utility bridge is installed in pages created after harness startup', async ({
  page,
  extension
}) => {
  const laterPage = await page.context().newPage()
  await openHostPage(laterPage)
  await laterPage.evaluate(() => {
    const root = document.querySelector('#host')!.attachShadow({ mode: 'closed' })
    root.innerHTML = '<span>later page</span>'
  })
  const isolated = extension.isolatedContexts.get(laterPage)
  await expect(laterPage.locator('#host >> css=span')).toHaveText('later page')
  expect(await laterPage.locator('#host').evaluate((host) => host.shadowRoot)).toBeNull()
  await assertBridgeHidden(laterPage, isolated)
})
