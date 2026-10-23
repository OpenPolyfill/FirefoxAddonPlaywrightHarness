import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'

const test = createFirefoxFixtures(baseTest, {
  extensionPaths: [new URL('../fixtures/no-popup-browser-action', import.meta.url).pathname],
  headless: true
})

test('activates a popupless browser action without bypassing its disabled state', async ({
  page,
  extensions
}) => {
  const extension = extensions.values().next().value!
  const background = extension.background
  if (!background) throw new Error('Browser action fixture has no background context')

  const tabId = await background.evaluate(async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
    if (typeof tab?.id !== 'number') throw new Error('No active browser tab')
    return tab.id
  })
  const isEnabled = () =>
    background.evaluate(`browser.browserAction.isEnabled({ tabId: ${tabId} })`)
  const clickCount = () =>
    background.evaluate(
      () =>
        (globalThis as typeof globalThis & { harnessActionClickCount: number })
          .harnessActionClickCount
    )

  await background.evaluate(`browser.browserAction.disable(${tabId})`)
  expect(await isEnabled()).toBe(false)
  await expect(
    extension.activateAction(page, 'browserAction', { waitForPopup: false })
  ).resolves.toBeUndefined()

  await background.evaluate(`browser.browserAction.enable(${tabId})`)
  expect(await isEnabled()).toBe(true)
  await extension.activateAction(page, 'browserAction', { waitForPopup: false })
  await background.waitForFunction(
    () =>
      (globalThis as typeof globalThis & { harnessActionClickCount: number })
        .harnessActionClickCount === 1,
    undefined,
    { timeout: 5_000 }
  )
  expect(await clickCount()).toBe(1)
})
