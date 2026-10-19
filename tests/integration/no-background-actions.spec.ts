import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'

const test = createFirefoxFixtures(baseTest, {
  extensionPath: new URL('../fixtures/no-background-browser-action', import.meta.url).pathname,
  headless: true
})

test('activates browserAction without a background context', async ({ page, extension }) => {
  expect(extension.background).toBeUndefined()
  const popup = await extension.activateAction(page, 'browserAction')
  await expect(popup.locator('[data-ready="true"]')).toBeVisible()
  expect(await popup.locator('body').textContent()).toContain('Action popup')
  await popup.close()
  expect(popup.isClosed()).toBe(true)
})

test('activates pageAction without a background context', async ({ page, extension }) => {
  await page.goto('https://example.com/')
  expect(extension.background).toBeUndefined()
  const popup = await extension.activateAction(page, 'pageAction')
  await expect(popup.locator('[data-ready="true"]')).toBeVisible()
  expect(await popup.locator('body').textContent()).toContain('Action popup')
  await popup.close()
  expect(popup.isClosed()).toBe(true)
})
