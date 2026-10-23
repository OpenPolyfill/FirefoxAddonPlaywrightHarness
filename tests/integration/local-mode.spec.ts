import { launchFirefoxExtension } from '../../src/launch.js'
import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'

const extensionPath = new URL('../fixtures/browser-action-extension', import.meta.url).pathname
const localOne = new URL('../fixtures/local-mode-one', import.meta.url).pathname
const localTwo = new URL('../fixtures/local-mode-two', import.meta.url).pathname

const test = createFirefoxFixtures(baseTest, {
  extensionPaths: [extensionPath],
  headless: true,
  localMappings: {
    'local-one.localhost': localOne,
    'local-two.localhost': localTwo
  }
})

test('serves multiple static origins and prepares each page before navigation', async ({
  context,
  page
}) => {
  await page.goto('https://local-one.localhost/')
  await expect(page.locator('body')).toHaveAttribute('data-fixture', 'local-mode-one')
  await expect(page.getByRole('heading')).toHaveText('Local fixture one')

  await page.goto('https://local-two.localhost/')
  await expect(page.locator('body')).toHaveAttribute('data-fixture', 'local-mode-two')
  await expect(page.getByRole('heading')).toHaveText('Local fixture two')

  const extraPage = await context.newPage()
  await extraPage.goto('https://local-one.localhost/')
  await expect(extraPage.locator('body')).toHaveAttribute('data-fixture', 'local-mode-one')
  await extraPage.close()

  await page.goto('https://local-one.localhost/?after-extra-page-close')
  await expect(page.locator('body')).toHaveAttribute('data-fixture', 'local-mode-one')

  const replacementPage = await context.newPage()
  await replacementPage.goto('https://local-two.localhost/')
  await expect(replacementPage.locator('body')).toHaveAttribute('data-fixture', 'local-mode-two')
})

baseTest('keeps identical origins isolated across concurrent Firefox contexts', async () => {
  const launches = await Promise.allSettled([
    launchFirefoxExtension({
      extensionPaths: [extensionPath],
      headless: true,
      localMappings: { 'shared.localhost': localOne }
    }),
    launchFirefoxExtension({
      extensionPaths: [extensionPath],
      headless: true,
      localMappings: { 'shared.localhost': localTwo }
    })
  ])
  const [firstResult, secondResult] = launches
  if (firstResult.status === 'rejected' || secondResult.status === 'rejected') {
    await Promise.allSettled(
      [firstResult, secondResult].flatMap((result) =>
        result.status === 'fulfilled' ? [result.value.close()] : []
      )
    )
    if (firstResult.status === 'rejected') throw firstResult.reason
    if (secondResult.status === 'rejected') throw secondResult.reason
  }
  const first = firstResult.value
  const second = secondResult.value
  let firstClosed = false

  try {
    const [firstPage, secondPage] = await Promise.all([
      first.context.newPage(),
      second.context.newPage()
    ])
    await Promise.all([
      firstPage.goto('https://shared.localhost/'),
      secondPage.goto('https://shared.localhost/')
    ])
    await expect(firstPage.locator('body')).toHaveAttribute('data-fixture', 'local-mode-one')
    await expect(secondPage.locator('body')).toHaveAttribute('data-fixture', 'local-mode-two')

    await first.close()
    firstClosed = true
    await secondPage.goto('https://shared.localhost/?after-first-context-close')
    await expect(secondPage.locator('body')).toHaveAttribute('data-fixture', 'local-mode-two')
  } finally {
    await Promise.allSettled([firstClosed ? Promise.resolve() : first.close(), second.close()])
  }
})
