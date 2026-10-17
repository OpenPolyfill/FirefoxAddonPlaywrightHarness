import { ensureFirefoxPatched } from './patch.js'

export default async function globalSetup(): Promise<void> {
  await ensureFirefoxPatched()
}
