import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'
import type { FirefoxIsolatedPage } from '../../src/types.js'
import type { Page } from '@playwright/test'

const extensionPath = new URL('../fixtures/no-background-browser-action', import.meta.url).pathname
const closedShadowPropertyName = 'openOrClosedShadowRoot'

const test = createFirefoxFixtures(baseTest, { extensionPaths: [extensionPath], headless: true })

async function openHostPage(page: Page): Promise<void> {
  await page.route('https://example.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><div id="host"></div></body></html>'
    })
  )
  await page.goto('https://example.com/')
}

async function assertGetterIsUtilityWorldOnly(
  page: Page,
  isolated: FirefoxIsolatedPage
): Promise<void> {
  const pageGetter = await page.evaluate((name: string) => {
    const globals = globalThis as typeof globalThis & Record<string, unknown>
    return {
      type: typeof globals[name],
      own: Object.prototype.hasOwnProperty.call(globalThis, name)
    }
  }, closedShadowPropertyName)
  expect(pageGetter).toEqual({ type: 'undefined', own: false })

  const pageCanAccessClosedRoot = await page.locator('#host').evaluate((host) => {
    const root = (host as Element & { openOrClosedShadowRoot?: ShadowRoot }).openOrClosedShadowRoot
    return root !== undefined && root !== null
  })
  expect(pageCanAccessClosedRoot).toBe(false)
  const pagePrototypeGetterSource = await page.evaluate((name: string) => {
    const getter = Object.getOwnPropertyDescriptor(Element.prototype, name)?.get
    return typeof getter === 'function' ? Function.prototype.toString.call(getter) : ''
  }, closedShadowPropertyName)
  expect(pagePrototypeGetterSource).not.toContain('getClosedRoot')

  const addonGetter = await isolated.evaluate((name: string) => {
    const globals = globalThis as typeof globalThis & Record<string, unknown>
    const pageGlobal = (window as typeof window & { wrappedJSObject?: Window }).wrappedJSObject
    const pageGlobals = pageGlobal as (Window & Record<string, unknown>) | undefined
    const prototypeGetter = Object.getOwnPropertyDescriptor(Element.prototype, name)?.get
    return {
      addonType: typeof globals[name],
      addonOwn: Object.prototype.hasOwnProperty.call(globalThis, name),
      addonPrototypeGetterSource:
        typeof prototypeGetter === 'function'
          ? Function.prototype.toString.call(prototypeGetter)
          : '',
      pageType: typeof pageGlobals?.[name],
      pageOwn: pageGlobals ? Object.prototype.hasOwnProperty.call(pageGlobals, name) : false
    }
  }, closedShadowPropertyName)
  expect(addonGetter).toEqual({
    addonType: 'undefined',
    addonOwn: false,
    addonPrototypeGetterSource: expect.not.stringContaining('getClosedRoot'),
    pageType: 'undefined',
    pageOwn: false
  })
  const addonCanReadClosedRoot = await isolated.evaluate(() => {
    const host = document.querySelector('#host')!
    return (
      (host as Element & { openOrClosedShadowRoot?: ShadowRoot }).openOrClosedShadowRoot != null
    )
  })
  expect(addonCanReadClosedRoot).toBe(false)
}

test('Playwright locators pierce a page-created closed root without exposing the utility getter', async ({
  page,
  extensions
}) => {
  const extension = extensions.values().next().value!
  await openHostPage(page)
  await page.evaluate(() => {
    const root = document.querySelector('#host')!.attachShadow({ mode: 'closed' })
    root.innerHTML = '<span>page realm</span><button>Launch</button>'
  })
  await expect(page.locator('#host >> css=span')).toHaveText('page realm')
  await expect(page.getByText('page realm')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Launch' })).toBeVisible()
  expect(await page.locator('#host').evaluate((host) => host.shadowRoot)).toBeNull()
  await assertGetterIsUtilityWorldOnly(page, extension.isolated)
})

test('Playwright locators pierce a closed root created from the isolated evaluator', async ({
  page,
  extensions
}) => {
  const extension = extensions.values().next().value!
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
  await assertGetterIsUtilityWorldOnly(page, extension.isolated)
})
test('Juggler installs the getter in pages created after harness startup', async ({
  page,
  extensions
}) => {
  const extension = extensions.values().next().value!
  const laterPage = await page.context().newPage()
  await openHostPage(laterPage)
  await laterPage.evaluate(() => {
    const root = document.querySelector('#host')!.attachShadow({ mode: 'closed' })
    root.innerHTML = '<span>later page</span>'
  })
  const isolated = extension.isolatedContexts.get(laterPage)
  await expect(laterPage.locator('#host >> css=span')).toHaveText('later page')
  expect(await laterPage.locator('#host').evaluate((host) => host.shadowRoot)).toBeNull()
  await assertGetterIsUtilityWorldOnly(laterPage, isolated)
})
