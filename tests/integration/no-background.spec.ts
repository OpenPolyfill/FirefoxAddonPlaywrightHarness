import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'

const test = createFirefoxFixtures(baseTest, {
  extensionPaths: [new URL('../fixtures/no-background-extension', import.meta.url).pathname],
  headless: true
})

test('installs an extension without a background target', async ({ extensions }) => {
  const extension = extensions.values().next().value!
  expect(extension.id).toBeTruthy()
  expect(extension.background).toBeUndefined()
})
