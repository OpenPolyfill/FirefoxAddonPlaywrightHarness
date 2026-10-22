import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { applyUnifiedPatchSet, atomicWrite } from './unified-patch.mjs'

const require = createRequire(import.meta.url)
const scriptDir = dirname(fileURLToPath(import.meta.url))
let coreBundlePath
try {
  coreBundlePath = join(dirname(require.resolve('playwright-core')), 'lib', 'coreBundle.js')
} catch {
  console.warn('Closed-shadow Playwright selector patch skipped: playwright-core is unavailable.')
  process.exit(0)
}

const patchText = await readFile(join(scriptDir, '../patches/playwright-core.patch'), 'utf8')
const source = await readFile(coreBundlePath, 'utf8')
const result = applyUnifiedPatchSet(
  { 'lib/coreBundle.js': source },
  patchText,
  'Playwright core bundle'
)
if (result.state === 'unpatched')
  await atomicWrite(coreBundlePath, result.files['lib/coreBundle.js'])
