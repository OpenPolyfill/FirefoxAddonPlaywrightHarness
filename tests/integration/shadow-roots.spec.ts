import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'
import type { Page } from '@playwright/test'

const extensionPath = new URL('../fixtures/no-background-browser-action', import.meta.url).pathname

const test = createFirefoxFixtures(baseTest, { extensionPath, headless: true })

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

test('Playwright locators pierce a page-created closed root without opening it', async ({
  page
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
})
