import { expect, baseTest, createFirefoxFixtures, withSharedPage } from './fixtures.js'

const test = withSharedPage(
  createFirefoxFixtures(baseTest, {
    extensionPath: new URL('../fixtures/browser-action-extension', import.meta.url).pathname,
    headless: true,
    contextScope: 'worker'
  })
)

test.describe.configure({ mode: 'serial' })

test('retains browser context, content page, and chrome target state across tests', async ({
  context,
  page,
  chromePage
}) => {
  await context.addCookies([
    { name: 'worker-context-state', value: 'persisted', url: 'http://localhost/' }
  ])
  await page.setContent('<body>worker page state</body>')
  await chromePage.evaluate(() => {
    document.documentElement.setAttribute('data-worker-fixture-state', 'retained')
  })
})

test('reuses worker context, Page objects, and chrome window target', async ({
  context,
  page,
  chromePage,
  chromePages
}) => {
  const cookies = await context.cookies('http://localhost/')
  expect(cookies).toContainEqual(
    expect.objectContaining({ name: 'worker-context-state', value: 'persisted' })
  )
  await expect(page.locator('body')).toHaveText('worker page state')
  expect(
    await chromePage.evaluate(() =>
      document.documentElement.getAttribute('data-worker-fixture-state')
    )
  ).toBe('retained')
  expect(await chromePages()).toContain(chromePage)
})
