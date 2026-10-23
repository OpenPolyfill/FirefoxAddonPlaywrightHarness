import { createFirefoxFixtures, baseTest, expect } from './fixtures.js'

const test = createFirefoxFixtures(baseTest, {
  extensionPath: new URL('../fixtures/browser-action-extension', import.meta.url).pathname,
  headless: true
})

test('exposes browser.xhtml as a locator, input, and screenshot capable Page', async ({
  chromePage,
  chromePages
}) => {
  expect(await chromePage.evaluate(() => document.documentURI)).toContain('browser.xhtml')
  await expect(chromePage.locator('#PanelUI-menu-button')).toBeVisible()

  const screenshot = await chromePage.screenshot()
  expect(screenshot.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(await chromePages()).toContain(chromePage)
})

test('uses native input to open, operate, and dismiss the Firefox application menu', async ({
  chromePage
}) => {
  const menu = chromePage.locator('#appMenu-popup')
  await chromePage.locator('#PanelUI-menu-button').click()
  await expect(menu).toBeVisible()
  await menu.locator('#appMenu-zoomEnlarge-button2').click()
  await expect(menu.locator('#appMenu-zoomReset-button2')).toHaveAttribute('label', '110%')
  await expect(menu).toBeVisible()
  await chromePage.keyboard.press('Escape')
  await expect(menu).toBeHidden()
})

test('registers and cleans up dynamically embedded browser UI targets', async ({
  context,
  chromePage
}) => {
  const existingPages = new Set(context.pages())
  const browserId = `harness-embedded-${Date.now()}`
  await chromePage.evaluate((id) => {
    const xulDocument = document as Document & {
      createXULElement: (name: string) => HTMLElement
    }
    const browser = xulDocument.createXULElement('browser')
    browser.id = id
    browser.setAttribute('type', 'content')
    browser.setAttribute('remote', 'true')
    browser.style.width = '480px'
    browser.style.height = '320px'
    document.documentElement.appendChild(browser)
    browser.setAttribute('src', 'about:blank')
  }, browserId)

  await expect
    .poll(() => context.pages().filter((candidate) => !existingPages.has(candidate)).length)
    .toBe(1)
  const embeddedPage = context.pages().find((candidate) => !existingPages.has(candidate))
  if (!embeddedPage) throw new Error('Firefox did not expose the embedded browser target')
  await expect.poll(() => embeddedPage.url()).toBe('about:blank')
  expect(
    await embeddedPage.evaluate(
      () =>
        (window as unknown as { __openpolyfillFirefoxUiTarget?: { kind?: string } })
          .__openpolyfillFirefoxUiTarget?.kind
    )
  ).toBe('embedded-browser')
  await embeddedPage.keyboard.press('Tab')

  const closed = embeddedPage.waitForEvent('close')
  await chromePage.evaluate((id) => document.getElementById(id)?.remove(), browserId)
  await closed
  expect(embeddedPage.isClosed()).toBe(true)
  expect(context.pages()).not.toContain(embeddedPage)
})

test('keeps an embedded browser Page across process switches and replaces it with its browser', async ({
  context,
  chromePage
}) => {
  const known = new Set(context.pages())
  const insertBrowser = () =>
    chromePage.evaluate(() => {
      const xulDocument = document as Document & {
        createXULElement: (name: string) => HTMLElement
      }
      const browser = xulDocument.createXULElement('browser')
      browser.id = 'harness-navigating-browser'
      browser.setAttribute('type', 'content')
      browser.setAttribute('remote', 'true')
      browser.setAttribute('maychangeremoteness', 'true')
      browser.style.width = '480px'
      browser.style.height = '320px'
      const previous = document.getElementById(browser.id)
      if (previous) previous.replaceWith(browser)
      else document.documentElement.appendChild(browser)
      browser.setAttribute('src', 'about:blank')
    })
  const nextPage = async () => {
    await expect
      .poll(() => context.pages().filter((candidate) => !known.has(candidate)).length)
      .toBe(1)
    const created = context.pages().find((candidate) => !known.has(candidate))!
    known.add(created)
    return created
  }

  await insertBrowser()
  const embedded = await nextPage()
  // about:robots loads in the parent process, so the browser changes remoteness.
  await embedded.goto('about:robots')
  expect(await embedded.evaluate(() => document.documentURI)).toBe('about:robots')
  await expect(embedded.locator('body')).toHaveCount(1)
  expect(embedded.isClosed()).toBe(false)

  const replaced = embedded.waitForEvent('close')
  await insertBrowser()
  await replaced
  const replacement = await nextPage()
  await expect.poll(() => replacement.url()).toBe('about:blank')

  const removed = replacement.waitForEvent('close')
  await chromePage.evaluate(() => document.getElementById('harness-navigating-browser')?.remove())
  await removed
  expect(context.pages()).not.toContain(replacement)
})

test('retains Playwright evaluation and locators on privileged about pages', async ({ page }) => {
  for (const url of [
    'about:blank',
    'about:addons',
    'about:preferences',
    'about:config',
    'about:debugging'
  ]) {
    await page.goto(url)
    expect(await page.evaluate(() => document.documentURI)).toContain(url)
    await expect(page.locator('body')).toHaveCount(1)
    await page.keyboard.press('Tab')
  }
})

test('discovers and closes multiple browser chrome windows', async ({
  chromePage,
  chromePages
}) => {
  const initialWindows = await chromePages()
  expect(initialWindows).toContain(chromePage)

  await chromePage.keyboard.press('Control+N')
  await expect.poll(async () => (await chromePages()).length).toBe(initialWindows.length + 1)
  const secondWindow = (await chromePages()).find((candidate) => candidate !== chromePage)
  if (!secondWindow) throw new Error('Firefox did not expose the second browser chrome window')
  expect(await secondWindow.evaluate(() => document.documentURI)).toContain('browser.xhtml')

  const closed = secondWindow.waitForEvent('close')
  await secondWindow.close()
  await closed
  await expect.poll(async () => (await chromePages()).length).toBe(initialWindows.length)
})
