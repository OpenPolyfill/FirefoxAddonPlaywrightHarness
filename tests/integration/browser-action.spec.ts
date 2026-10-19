import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'


const test = createFirefoxFixtures(baseTest, {
  extensionPath: new URL('../fixtures/browser-action-extension', import.meta.url).pathname,
  headless: true
})

test('browserAction popup is a Playwright Page with input, screenshot, and panel lifecycle', async ({
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
  expect(popup.url()).toMatch(/^moz-extension:\/\//)
  expect(await popup.opener()).toBe(page)
  expect(page.context().pages()).toContain(popup)
  await expect(popup.getByRole('textbox', { name: 'Message' })).toBeVisible()

  const screenshot = await popup.screenshot()
  expect(screenshot.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(screenshot.readUInt32BE(16)).toBeGreaterThan(0)
  expect(screenshot.readUInt32BE(20)).toBeGreaterThan(0)

  const message = popup.getByRole('textbox', { name: 'Message' })
  await message.fill('typed by Playwright')
  await message.click()
  await popup.keyboard.press('End')
  await popup.keyboard.type('!')
  await expect(message).toHaveValue('typed by Playwright!')
  const confirmButton = popup.getByRole('button', { name: 'Confirm' })
  const buttonBounds = await confirmButton.boundingBox()
  if (!buttonBounds) throw new Error('Confirm button has no bounding box')
  await popup.mouse.click(
    buttonBounds.x + buttonBounds.width / 2,
    buttonBounds.y + buttonBounds.height / 2
  )
  await expect(popup.locator('body')).toHaveAttribute('data-confirmed', 'typed by Playwright!')
  expect(popup.isClosed()).toBe(false)

  const closed = popup.waitForEvent('close')
  await popup.close()
  await closed
  expect(popup.isClosed()).toBe(true)
  expect(page.context().pages()).not.toContain(popup)
})
