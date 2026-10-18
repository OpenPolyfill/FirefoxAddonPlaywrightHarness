import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'

const test = createFirefoxFixtures(baseTest, {
  extensionPath: new URL('../fixtures/no-background-browser-action', import.meta.url).pathname,
  headless: true
})

test('activates browserAction without a background context', async ({ page, extension }) => {
  expect(extension.background).toBeUndefined()
  const popup = await extension.activateAction(page, 'browserAction')
  await popup.waitForSelector('[data-ready="true"]')
  expect(await popup.evaluate(() => document.body.textContent)).toContain('Action popup')
})

test('activates pageAction without a background context', async ({ page, extension }) => {
  await page.goto('https://example.com/')
  expect(extension.background).toBeUndefined()
  const popup = await extension.activateAction(page, 'pageAction')
  await popup.waitForSelector('[data-ready="true"]')
  expect(await popup.evaluate(() => document.body.textContent)).toContain('Action popup')
})

