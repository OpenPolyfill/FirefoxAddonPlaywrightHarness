import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'

const test = createFirefoxFixtures(baseTest, {
  extensionPath: new URL('../fixtures/browser-action-extension', import.meta.url).pathname,
  headless: true
})

test('browserAction popup sees the active Playwright tab and isolated evaluation sees the page', async ({
  page,
  extension,
  rdp
}) => {
  await page.goto('https://example.com/')
  await page.locator('body').evaluate((body) => (body.dataset.pageMarker = 'first'))
  const duplicateUrlPage = await page.context().newPage()
  await duplicateUrlPage.goto('https://example.com/')
  await duplicateUrlPage.locator('body').evaluate((body) => (body.dataset.pageMarker = 'second'))
  expect((await rdp.root.listTabs()).length).toBeGreaterThan(0)
  expect(await extension.isolated.evaluate(() => document.body.dataset.pageMarker)).toBe('first')
  expect(
    await extension.isolatedContexts
      .get(duplicateUrlPage)
      .evaluate(() => document.body.dataset.pageMarker)
  ).toBe('second')
  const popup = await extension.activateAction(page, 'browserAction')
  await popup.waitForSelector('[data-active-tab]')
  expect(await popup.evaluate(() => document.body.dataset.activeTab)).toBeTruthy()
})
