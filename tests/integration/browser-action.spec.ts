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
  expect((await rdp.root.listTabs()).length).toBeGreaterThan(0)
  expect(await extension.isolated.evaluate(() => location.hostname)).toBe('example.com')
  expect(
    await extension.isolatedContexts
      .get(page)
      .evaluate(async () => await Promise.resolve(location.hostname))
  ).toBe('example.com')
  const popup = await extension.activateAction(page, 'browserAction')
  await popup.waitForSelector('[data-active-tab]')
  expect(await popup.evaluate(() => document.body.dataset.activeTab)).toBeTruthy()
})
