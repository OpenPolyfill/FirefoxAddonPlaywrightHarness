import { readFile, writeFile, rename } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { firefox } from '@playwright/test'

export const PATCH_MARKER = '// --- Firefox Addon Playwright Harness ---'
let patchPromise: Promise<void> | undefined

function countOccurrences(content: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while (true) {
    const index = content.indexOf(needle, offset)
    if (index < 0) return count
    count++
    offset = index + needle.length
  }
}

function replaceExactlyOnce(
  content: string,
  needle: string,
  replacement: string,
  file: string
): string {
  if (countOccurrences(content, needle) !== 1)
    throw new Error(
      `Incompatible Playwright Firefox build: patch needle must occur exactly once in ${file}: ${needle}`
    )
  return content.replace(needle, replacement)
}

function patchOrVerify(content: string, original: string, patched: string, file: string): string {
  const originalCount = countOccurrences(content, original)
  const patchedCount = countOccurrences(content, patched)
  if (patchedCount === 1 && originalCount === 0) return content
  if (patchedCount === 0 && originalCount === 1)
    return replaceExactlyOnce(content, original, patched, file)
  throw new Error(
    `Incompatible Playwright Firefox patch state in ${file}: expected exactly one original or patched needle`
  )
}

export async function ensureFirefoxPatched(): Promise<void> {
  patchPromise ??= patchFirefoxInstallation()
  return patchPromise
}

export async function assertClosedShadowSelectorPatched(): Promise<void> {
  const coreBundlePath = join(
    dirname(createRequire(import.meta.url).resolve('playwright-core')),
    'lib',
    'coreBundle.js'
  )
  const source = await readFile(coreBundlePath, 'utf8')
  if (
    !source.includes(
      'const shadows = [];\\n    const rootShadow = root.shadowRoot || window.wrappedJSObject?.__openpolyfillPlaywrightClosedShadowRoot__?.(root);'
    ) ||
    !source.includes(
      'const rootShadow = root.shadowRoot || window.wrappedJSObject?.__openpolyfillPlaywrightClosedShadowRoot__?.(root)'
    ) ||
    !source.includes(
      'window.wrappedJSObject?.__openpolyfillPlaywrightClosedShadowRoot__?.(element)'
    )
  )
    throw new Error(
      `Playwright's selector bundle is not patched for closed shadow roots: ${coreBundlePath}. Reinstall dependencies to run the harness postinstall patch.`
    )
}

async function patchFirefoxInstallation(): Promise<void> {
  const binDir = dirname(firefox.executablePath())
  const firefoxDir = process.platform === 'darwin' ? join(binDir, '..', 'Resources') : binDir
  const cfgPath = join(firefoxDir, 'playwright.cfg')
  const omniPath = join(firefoxDir, 'omni.ja')
  let cfg: string
  try {
    cfg = await readFile(cfgPath, 'utf8')
  } catch (error) {
    throw new Error(`Cannot patch Playwright Firefox: missing ${cfgPath}`, { cause: error })
  }
  const zip = await JSZip.loadAsync(await readFile(omniPath))
  const addonPath = 'modules/addons/AddonSettings.sys.mjs'
  const jugglerPath = 'chrome/juggler/content/content/JugglerFrameChild.jsm'
  const addon = zip.file(addonPath)
  const juggler = zip.file(jugglerPath)
  if (!addon || !juggler)
    throw new Error(
      `Incompatible Playwright Firefox build: omni.ja is missing ${!addon ? addonPath : jugglerPath}`
    )
  const addonBefore = await addon.async('string')
  const jugglerBefore = await juggler.async('string')
  const markerCount = countOccurrences(cfg, PATCH_MARKER)
  const prefNeedle = 'lockPref("marionette.running", true);'
  const prefCount = countOccurrences(cfg, prefNeedle)
  if (
    markerCount > 1 ||
    (markerCount === 0 && prefCount !== 0) ||
    (markerCount === 1 && prefCount !== 1)
  ) {
    throw new Error(`Incompatible Firefox configuration patch state: ${cfgPath}`)
  }
  if (markerCount === 1) {
    if (
      !addonBefore.includes('makeConstant("EXPERIMENTS_ENABLED", true)') ||
      !jugglerBefore.includes('moz-extension-DISABLED://')
    ) {
      throw new Error(
        `Incompatible partially patched Playwright Firefox installation: ${firefoxDir}`
      )
    }
    return
  }
  const addonSource = patchOrVerify(
    addonBefore,
    'makeConstant("EXPERIMENTS_ENABLED", false)',
    'makeConstant("EXPERIMENTS_ENABLED", true)',
    `omni.ja:${addonPath}`
  )
  const jugglerSource = patchOrVerify(
    jugglerBefore,
    'moz-extension://',
    'moz-extension-DISABLED://',
    `omni.ja:${jugglerPath}`
  )
  zip.file(addonPath, addonSource)
  zip.file(jugglerPath, jugglerSource)

  const suffix = `\n${PATCH_MARKER}\nlockPref("marionette.running", true);\n// --- End Firefox Addon Playwright Harness ---\n`
  const omniTmp = `${omniPath}.tmp-${process.pid}`
  const cfgTmp = `${cfgPath}.tmp-${process.pid}`
  await writeFile(omniTmp, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }))
  await rename(omniTmp, omniPath)
  await writeFile(cfgTmp, cfg + suffix)
  await rename(cfgTmp, cfgPath)
}

export { replaceExactlyOnce }
