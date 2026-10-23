import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'

const test = createFirefoxFixtures(baseTest, {
  extensionPaths: [new URL('../fixtures/sidebar-action-extension', import.meta.url).pathname],
  headless: true
})

test('sidebar action is a Playwright Page with interaction and close lifecycle', async ({
  page,
  extensions
}) => {
  const extension = extensions.values().next().value!
  const sidebar = await extension.activateSidebar(page)
  expect(sidebar.url()).toMatch(/^moz-extension:\/\//)
  expect(await sidebar.opener()).toBe(page)
  expect(page.context().pages()).toContain(sidebar)

  const message = sidebar.getByRole('textbox', { name: 'Message' })
  const confirmButton = sidebar.getByRole('button', { name: 'Confirm' })
  const confirmed = sidebar.locator('#confirmed')
  await expect(message).toBeVisible()
  await message.fill('typed by Playwright')
  await message.press('End')
  await sidebar.keyboard.type('!')
  await expect(message).toHaveValue('typed by Playwright!')

  const screenshot = await sidebar.screenshot()
  expect(screenshot.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(screenshot.readUInt32BE(16)).toBeGreaterThan(0)
  expect(screenshot.readUInt32BE(20)).toBeGreaterThan(0)

  await confirmButton.click({ modifiers: ['Alt', 'Control', 'Shift', 'Meta'] })
  await expect(confirmed).toHaveText('typed by Playwright!')
  await expect(confirmed).toHaveAttribute('data-click-modifiers', 'true,true,true,true')
  await expect(confirmed).toHaveAttribute('data-trusted-click', 'true')

  const closed = sidebar.waitForEvent('close')
  await sidebar.close()
  await closed
  expect(sidebar.isClosed()).toBe(true)
  expect(page.context().pages()).not.toContain(sidebar)

  const reopened = await extension.activateSidebar(page)
  expect(reopened).not.toBe(sidebar)
  await expect(reopened.getByRole('textbox', { name: 'Message' })).toBeVisible()
  const reopenedClosed = reopened.waitForEvent('close')
  await reopened.close()
  await reopenedClosed
})

test('waitForPopup returns the popup instead of an already-open sidebar', async ({
  page,
  extensions
}) => {
  const extension = extensions.values().next().value!
  const sidebar = await extension.activateSidebar(page)
  expect(page.context().pages()).toContain(sidebar)
  const message = sidebar.getByRole('textbox', { name: 'Message' })
  await message.fill('typed by Playwright')
  await message.press('End')
  await sidebar.keyboard.type('!')
  await sidebar.getByRole('button', { name: 'Confirm' }).click({
    modifiers: ['Alt', 'Control', 'Shift', 'Meta']
  })
  await expect(sidebar.locator('#confirmed')).toHaveAttribute('data-trusted-click', 'true')

  const pendingPopup = extension.waitForPopup()
  const popup = await extension.activateAction(page, 'browserAction')
  expect(await pendingPopup).toBe(popup)
  expect(popup).not.toBe(sidebar)
  expect(popup.url()).toMatch(/\/popup\.html$/)
  expect(sidebar.isClosed()).toBe(false)

  const popupClosed = popup.waitForEvent('close')
  await popup.close()
  await popupClosed
  expect(sidebar.isClosed()).toBe(false)
  expect(page.context().pages()).toContain(sidebar)
})

test('closes the sidebar from browser chrome and drives the bookmarks sidebar Page', async ({
  context,
  page,
  extensions,
  chromePage
}) => {
  const extension = extensions.values().next().value!
  const sidebar = await extension.activateSidebar(page)
  const sidebarClosed = sidebar.waitForEvent('close')
  await chromePage.locator('#sidebar-button').click()
  await sidebarClosed

  const bookmarksOpened = context.waitForEvent('page')
  await chromePage.evaluate(() =>
    (
      window as unknown as { SidebarController: { show(id: string): Promise<boolean> } }
    ).SidebarController.show('viewBookmarksSidebar')
  )
  const bookmarks = await bookmarksOpened
  await expect
    .poll(() => bookmarks.url())
    .toBe('chrome://browser/content/places/bookmarksSidebar.xhtml')
  const search = bookmarks.getByRole('searchbox')
  await search.fill('Harness')
  await expect(search).toHaveValue('Harness')

  const bookmarksClosed = bookmarks.waitForEvent('close')
  await bookmarks.locator('#sidebar-panel-close').click()
  await bookmarksClosed
  expect(
    await chromePage.evaluate(
      () =>
        (window as unknown as { SidebarController: { isOpen: boolean } }).SidebarController.isOpen
    )
  ).toBe(false)
})
