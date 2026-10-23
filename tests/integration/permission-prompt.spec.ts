import type { Page } from '@playwright/test'
import { createFirefoxFixtures, baseTest, expect } from './fixtures.js'

const test = createFirefoxFixtures(baseTest, {
  extensionPath: new URL('../fixtures/permission-prompt-extension', import.meta.url).pathname,
  headless: true
})

test('dismisses and denies the WebExtension permission prompt from chromePage', async ({
  page,
  extension,
  chromePage
}) => {
  const prompt = chromePage.locator('#addon-webext-permissions-notification')
  const deny = prompt.locator('.popup-notification-secondary-button')
  const request = async (popup: Page) => {
    await popup.getByRole('button', { name: 'Request notifications' }).click()
    await expect(prompt).toBeVisible()
  }

  // Escape first closes the topmost auto-hiding popup, the extension popup. With focus in
  // the page, the next Escape reaches the persistent prompt and cancels it.
  const escaped = await extension.activateAction(page, 'browserAction')
  await request(escaped)
  const escapedClosed = escaped.waitForEvent('close')
  await chromePage.keyboard.press('Escape')
  await escapedClosed
  await expect(prompt).toBeVisible()
  await page.mouse.click(10, 10)
  await chromePage.keyboard.press('Escape')
  await expect(prompt).toBeHidden()

  const popup = await extension.activateAction(page, 'browserAction')
  const status = popup.getByRole('status')
  await request(popup)
  await deny.press('Enter')
  await expect(prompt).toBeHidden()
  await expect(status).toHaveText('false')

  await status.evaluate((element) => {
    element.textContent = ''
  })
  await request(popup)
  await deny.click()
  await expect(prompt).toBeHidden()
  await expect(status).toHaveText('false')
})
