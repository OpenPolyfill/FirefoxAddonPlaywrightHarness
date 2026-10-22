import { test as base } from '@playwright/test'
import { createFirefoxFixtures, withSharedPage } from '../../src/fixtures.js'

export { base as baseTest }
export { createFirefoxFixtures, withSharedPage }
export { expect } from '@playwright/test'
