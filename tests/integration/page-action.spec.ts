import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'

const test = createFirefoxFixtures(baseTest, {
  extensionPath: new URL('../fixtures/page-action-extension', import.meta.url).pathname,
  headless: true
})

test('pageAction popup is a Playwright Page bound to the active tab and popup lifecycle', async ({
  page,
  extension
}) => {
  await page.goto('https://example.com/')
  expect(await extension.background.evaluate(() => browser.runtime.id)).toBe(extension.id)

  const pendingPopup = extension.waitForPopup()
  const popup = await extension.activateAction(page, 'pageAction')
  const observedPopup = await pendingPopup
  expect(observedPopup).toBe(popup)
  expect(popup.url()).toMatch(/^moz-extension:\/\//)
  expect(await popup.opener()).toBe(page)
  expect(page.context().pages()).toContain(popup)
  await expect(popup.getByText('https://example.com/')).toBeVisible()

  const closed = popup.waitForEvent('close')
  await popup.close()
  await closed
  expect(popup.isClosed()).toBe(true)
  expect(page.context().pages()).not.toContain(popup)
})
