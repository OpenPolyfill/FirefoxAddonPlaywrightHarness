import { expect, baseTest, createFirefoxFixtures, withSharedPage } from './fixtures.js'

const test = withSharedPage(
  createFirefoxFixtures(baseTest, {
    extensionPath: new URL('../fixtures/browser-action-extension', import.meta.url).pathname,
    headless: true,
    contextScope: 'worker'
  })
)

test.describe.configure({ mode: 'serial' })

test('retains browser context and page state across tests', async ({ context, page }) => {
  await context.addCookies([
    { name: 'worker-context-state', value: 'persisted', url: 'http://localhost/' }
  ])
  await page.setContent('<body>worker page state</body>')
})

test('reuses the same context and Page object', async ({ context, page }) => {
  const cookies = await context.cookies('http://localhost/')
  expect(cookies).toContainEqual(
    expect.objectContaining({ name: 'worker-context-state', value: 'persisted' })
  )
  await expect(page.locator('body')).toHaveText('worker page state')
})
