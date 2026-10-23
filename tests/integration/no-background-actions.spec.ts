import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'

const test = createFirefoxFixtures(baseTest, {
  extensionPaths: [new URL('../fixtures/no-background-browser-action', import.meta.url).pathname],
  headless: true
})

test('activates browserAction without a background context', async ({ page, extensions }) => {
  const extension = extensions.values().next().value!
  expect(extension.background).toBeUndefined()
  const popup = await extension.activateAction(page, 'browserAction')
  expect(await popup.locator('body').textContent()).toContain('Action popup')
  await popup.close()
  expect(popup.isClosed()).toBe(true)
})

test('activates pageAction without a background context', async ({ page, extensions }) => {
  const extension = extensions.values().next().value!
  await page.goto('https://example.com/')
  expect(extension.background).toBeUndefined()
  const popup = await extension.activateAction(page, 'pageAction')
  expect(await popup.locator('body').textContent()).toContain('Action popup')
  await popup.close()
  expect(popup.isClosed()).toBe(true)
})
