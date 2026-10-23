import type { BrowserContext, Page } from '@playwright/test'
import { createFirefoxFixtures, baseTest, expect } from './fixtures.js'

const test = createFirefoxFixtures(baseTest, {
  extensionPath: new URL('../fixtures/browser-action-extension', import.meta.url).pathname,
  headless: true
})

type ChromeWindow = Window & {
  gBrowser: { tabs: unknown[]; multiSelectedTabsCount: number; selectedBrowser: Element }
  PlacesUtils: { bookmarks: { fetch(query: { url: string }): Promise<{ title: string } | null> } }
  Services: {
    prompt: {
      confirm(window: Window, title: string, text: string): boolean
      prompt(
        window: Window,
        title: string,
        text: string,
        value: { value: string },
        checkMessage: null,
        checkState: { value: boolean }
      ): boolean
    }
  }
  __dialogResult?: unknown
}
const tabCount = (chromePage: Page) =>
  chromePage.evaluate(() => (window as unknown as ChromeWindow).gBrowser.tabs.length)
const dialogResult = (chromePage: Page) =>
  chromePage.evaluate(() => (window as unknown as ChromeWindow).__dialogResult)

async function commonDialogPage(context: BrowserContext): Promise<Page> {
  const isDialog = (candidate: Page) =>
    candidate.url() === 'chrome://global/content/commonDialog.xhtml'
  await expect.poll(() => context.pages().some(isDialog)).toBe(true)
  return context.pages().find(isDialog)!
}

test('opens and operates tab, page, and toolbar context menus', async ({ page, chromePage }) => {
  const tabMenu = chromePage.locator('#tabContextMenu')
  const selectedTab = chromePage.locator('.tabbrowser-tab[selected]')
  await selectedTab.click({ button: 'right' })
  await expect(tabMenu).toBeVisible()
  await chromePage.keyboard.press('Escape')
  await expect(tabMenu).toBeHidden()
  const tabsBefore = await tabCount(chromePage)
  await selectedTab.click({ button: 'right' })
  await tabMenu.locator('#context_duplicateTab').click()
  await expect.poll(() => tabCount(chromePage)).toBe(tabsBefore + 1)

  await page.bringToFront()
  const contentMenu = chromePage.locator('#contentAreaContextMenu')
  await page.setContent('<p style="font-size: 40px">context target</p>')
  const paragraph = await page.locator('p').boundingBox()
  const browserBounds = await chromePage.evaluate(() => {
    const bounds = (
      window as unknown as ChromeWindow
    ).gBrowser.selectedBrowser.getBoundingClientRect()
    return { x: bounds.x, y: bounds.y }
  })
  await chromePage.mouse.click(
    browserBounds.x + paragraph!.x + paragraph!.width / 2,
    browserBounds.y + paragraph!.y + paragraph!.height / 2,
    { button: 'right' }
  )
  await expect(contentMenu).toBeVisible()
  await contentMenu.locator('#context-selectall').click()
  await expect(contentMenu).toBeHidden()
  expect(await page.evaluate(() => String(getSelection()))).toBe('context target')

  const toolbarMenu = chromePage.locator('#toolbar-context-menu')
  await chromePage.locator('#PanelUI-menu-button').click({ button: 'right' })
  await expect(toolbarMenu).toBeVisible()
  await chromePage.keyboard.press('Escape')
  await expect(toolbarMenu).toBeHidden()
})

test('hovers, multi-selects, and middle-clicks tabs in the tab strip', async ({ chromePage }) => {
  const menuButton = chromePage.locator('#PanelUI-menu-button')
  await menuButton.hover()
  expect(await menuButton.evaluate((element) => element.matches(':hover'))).toBe(true)
  await chromePage.locator('#back-button').hover()
  await expect
    .poll(() =>
      chromePage.evaluate(
        () => (document.getElementById('back-button-tooltip') as unknown as { state: string }).state
      )
    )
    .toBe('open')

  const newTab = chromePage.locator('#tabs-newtab-button')
  await newTab.click()
  await newTab.click()
  await expect.poll(() => tabCount(chromePage)).toBe(3)
  const tabs = chromePage.locator('.tabbrowser-tab')
  const multiSelected = () =>
    chromePage.evaluate(() => (window as unknown as ChromeWindow).gBrowser.multiSelectedTabsCount)
  await tabs.nth(0).click()
  await tabs.nth(2).click({ modifiers: ['Shift'] })
  await expect.poll(multiSelected).toBe(3)
  await tabs.nth(1).click({ modifiers: ['ControlOrMeta'] })
  await expect.poll(multiSelected).toBe(2)

  await tabs.nth(0).click()
  await tabs.last().click({ button: 'middle' })
  await expect.poll(() => tabCount(chromePage)).toBe(2)
})

test('drives a second browser window with mouse and keyboard', async ({
  chromePage,
  chromePages
}) => {
  await chromePage.keyboard.press('Control+N')
  await expect.poll(async () => (await chromePages()).length).toBe(2)
  const second = (await chromePages()).find((candidate) => candidate !== chromePage)!

  const menu = second.locator('#appMenu-popup')
  await second.locator('#PanelUI-menu-button').click()
  await expect(menu).toBeVisible()
  await second.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  const urlbar = second.locator('#urlbar-input')
  await urlbar.click()
  await second.keyboard.type('second window text')
  await expect(urlbar).toHaveValue('second window text')
  await expect(chromePage.locator('#urlbar-input')).toHaveValue('')
})

test('operates window-modal browser dialogs through their own Pages', async ({
  context,
  chromePage
}) => {
  await chromePage.evaluate(() => {
    const chromeWindow = window as unknown as ChromeWindow
    delete chromeWindow.__dialogResult
    setTimeout(() => {
      chromeWindow.__dialogResult = chromeWindow.Services.prompt.confirm(
        window,
        'Harness',
        'Continue?'
      )
    }, 0)
  })
  const confirmDialog = await commonDialogPage(context)
  await expect(confirmDialog.locator('#infoBody')).toHaveText('Continue?')
  const confirmClosed = confirmDialog.waitForEvent('close')
  await confirmDialog.locator('button[dlgtype="accept"]').click()
  await confirmClosed
  await expect.poll(() => dialogResult(chromePage)).toBe(true)

  await chromePage.evaluate(() => {
    const chromeWindow = window as unknown as ChromeWindow
    delete chromeWindow.__dialogResult
    setTimeout(() => {
      const value = { value: '' }
      const prompt = chromeWindow.Services.prompt
      const accepted = prompt.prompt(window, 'Harness', 'Name?', value, null, { value: false })
      chromeWindow.__dialogResult = accepted ? value.value : null
    }, 0)
  })
  const promptDialog = await commonDialogPage(context)
  await promptDialog.locator('#loginTextbox').fill('typed in a dialog')
  const promptClosed = promptDialog.waitForEvent('close')
  await promptDialog.keyboard.press('Enter')
  await promptClosed
  await expect.poll(() => dialogResult(chromePage)).toBe('typed in a dialog')

  await chromePage.evaluate(() => {
    const chromeWindow = window as unknown as ChromeWindow
    delete chromeWindow.__dialogResult
    setTimeout(() => {
      chromeWindow.__dialogResult = chromeWindow.Services.prompt.confirm(
        window,
        'Harness',
        'Cancel me'
      )
    }, 0)
  })
  const cancelledDialog = await commonDialogPage(context)
  const cancelledClosed = cancelledDialog.waitForEvent('close')
  await cancelledDialog.keyboard.press('Escape')
  await cancelledClosed
  await expect.poll(() => dialogResult(chromePage)).toBe(false)
})

test('edits a bookmark from the bookmark doorhanger', async ({ context, page, chromePage }) => {
  const url = 'https://harness.example/bookmark'
  await context.route('https://harness.example/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<title>Harness page</title><p>bookmark me</p>'
    })
  )
  await page.goto(url)
  const panel = chromePage.locator('#editBookmarkPanel')
  await chromePage.locator('#star-button-box').click()
  await expect(panel).toBeVisible()
  await chromePage.locator('#editBMPanel_namePicker').fill('Harness bookmark')
  await chromePage.locator('#editBookmarkPanelDoneButton').click()
  await expect(panel).toBeHidden()
  await expect
    .poll(() =>
      chromePage.evaluate(
        async (bookmarkUrl) =>
          (
            await (window as unknown as ChromeWindow).PlacesUtils.bookmarks.fetch({
              url: bookmarkUrl
            })
          )?.title,
        url
      )
    )
    .toBe('Harness bookmark')
})

test('keeps iframes as Frames of their Page', async ({ context, page }) => {
  const pageCount = context.pages().length
  await page.setContent('<iframe srcdoc="<p>inner</p>"></iframe>')
  await expect(page.frameLocator('iframe').locator('p')).toHaveText('inner')
  expect(page.frames()).toHaveLength(2)
  expect(context.pages()).toHaveLength(pageCount)
})

test('exposes privileged page subdialogs as Pages of their tab', async ({ context, page }) => {
  const connectionUrl = 'chrome://browser/content/preferences/dialogs/connection.xhtml'
  await page.goto('about:preferences')
  const opened = context.waitForEvent('page')
  await page.evaluate(
    (url) =>
      (window as unknown as { gSubDialog: { open(url: string): void } }).gSubDialog.open(url),
    connectionUrl
  )
  const subdialog = await opened
  await subdialog.waitForURL(connectionUrl)

  const httpProxy = subdialog.locator('#networkProxyHTTP')
  await subdialog.locator('#networkProxyType radio[value="1"]').click()
  await expect(httpProxy).toBeEnabled()
  await httpProxy.fill('proxy.harness.example')
  await expect(httpProxy).toHaveValue('proxy.harness.example')

  // Escape cancels the dialog without saving the proxy settings.
  const closed = subdialog.waitForEvent('close')
  await subdialog.keyboard.press('Escape')
  await closed
  expect(page.frames()).toHaveLength(1)
})

test('keeps content prompts as Playwright dialogs of their page', async ({ context, page }) => {
  const pageCount = context.pages().length
  const dialogs: string[] = []
  page.on('dialog', (dialog) => {
    dialogs.push(`${dialog.type()}:${dialog.message()}`)
    if (dialog.type() === 'prompt') void dialog.accept('typed')
    else if (dialog.type() === 'confirm') void dialog.dismiss()
    else void dialog.accept()
  })
  await page.evaluate(() => alert('hello'))
  expect(await page.evaluate(() => confirm('continue?'))).toBe(false)
  expect(await page.evaluate(() => prompt('name?'))).toBe('typed')
  expect(dialogs).toEqual(['alert:hello', 'confirm:continue?', 'prompt:name?'])
  expect(context.pages()).toHaveLength(pageCount)
})
