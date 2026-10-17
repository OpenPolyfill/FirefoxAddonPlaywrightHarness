import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'

const test = createFirefoxFixtures(baseTest, {
  extensionPath: new URL('../fixtures/page-action-extension', import.meta.url).pathname,
  headless: true
})

test('pageAction popup opens for the specified active tab', async ({ page, extension }) => {
  await page.goto('https://example.com/')
  expect(await extension.background.evaluate(() => browser.runtime.id)).toBe(extension.id)
  const popup = await extension.activateAction(page, 'pageAction')
  await popup.waitForSelector('body')
  expect(popup.url).toMatch(/^moz-extension:\/\//)
})
