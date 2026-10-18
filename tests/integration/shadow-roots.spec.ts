import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'

const extensionPath = new URL('../fixtures/no-background-browser-action', import.meta.url).pathname

const test = createFirefoxFixtures(baseTest, { extensionPath, headless: true })

test('captures closed roots without opening them', async ({ page }) => {
  await page.goto('data:text/html,<div id="host"></div>')
  await page.evaluate(() => {
    const root = document.querySelector('#host')!.attachShadow({ mode: 'closed' })
    root.innerHTML = '<span>default closed</span>'
  })
  expect(await page.locator('#host').evaluate((host) => host.shadowRoot)).toBeNull()
  await expect(page.locator('#host >> css=span')).toHaveText('default closed')
})

test('Playwright locators pierce a closed root without opening it', async ({ page }) => {
  await page.goto('data:text/html,<div id="host"></div>')
  await page.evaluate(() => {
    const root = document.querySelector('#host')!.attachShadow({ mode: 'closed' })
    root.innerHTML = '<span>page realm</span><button>Launch</button>'
  })
  await expect(page.locator('#host >> css=span')).toHaveText('page realm')
  await expect(page.getByText('page realm')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Launch' })).toBeVisible()
  expect(await page.locator('#host').evaluate((host) => host.shadowRoot)).toBeNull()
})

test('isolated Xray reads a page-created closed root reference', async ({ page, extension }) => {
  await page.goto('data:text/html,<div id="host"></div>')
  await page.evaluate(() => {
    const root = document.querySelector('#host')!.attachShadow({ mode: 'closed' })
    root.innerHTML = '<span>page realm</span><button>Launch</button>'
  })
  expect(
    await extension.isolated.evaluate(() => {
      const host = document.querySelector('#host') as HTMLElement & {
        __playwrightClosedShadowRoot__?: ShadowRoot
        wrappedJSObject?: HTMLElement & { __playwrightClosedShadowRoot__?: ShadowRoot }
      }
      const root =
        host.__playwrightClosedShadowRoot__ ?? host.wrappedJSObject?.__playwrightClosedShadowRoot__
      return {
        nativeShadowRoot: host.shadowRoot,
        content: root?.textContent
      }
    })
  ).toEqual({ nativeShadowRoot: null, content: 'page realmLaunch' })
})

test('Playwright locators pierce roots created through the isolated Xray', async ({
  page,
  extension
}) => {
  await page.goto('data:text/html,<div id="host"></div>')
  await extension.isolated.evaluate(() => {
    const root = document.querySelector('#host')!.attachShadow({ mode: 'closed' })
    root.innerHTML = '<span>isolated realm</span><button>Run</button>'
  })
  await expect(page.locator('#host >> css=span')).toHaveText('isolated realm')
  await expect(page.getByRole('button', { name: 'Run' })).toBeVisible()
  expect(
    await extension.isolated.evaluate(() => {
      const host = document.querySelector('#host') as HTMLElement & {
        __playwrightClosedShadowRoot__?: ShadowRoot
        wrappedJSObject?: HTMLElement & { __playwrightClosedShadowRoot__?: ShadowRoot }
      }
      return (
        host.__playwrightClosedShadowRoot__ ?? host.wrappedJSObject?.__playwrightClosedShadowRoot__
      )?.textContent
    })
  ).toBe('isolated realmRun')
  expect(
    await extension.isolated.evaluate(() => document.querySelector('#host')!.shadowRoot)
  ).toBeNull()
})
