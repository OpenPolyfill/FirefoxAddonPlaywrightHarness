import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'

const test = createFirefoxFixtures(baseTest, {
  extensionPath: new URL('../fixtures/no-background-extension', import.meta.url).pathname,
  headless: true
})

test('installs an extension without a background target', async ({ extension }) => {
  expect(extension.id).toBeTruthy()
  expect(extension.background).toBeUndefined()
})
