import { readFile, writeFile, rename } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { firefox } from '@playwright/test'

export const PATCH_MARKER = '// --- Firefox Addon Playwright Harness ---'
const utilityWorldName = '__playwright_utility_world__'
const closedShadowPropertyName = 'openOrClosedShadowRoot'
const closedShadowHelperName = '__openpolyfillClosedShadowRootHelper__'
const legacyClosedShadowGetterName = '__openpolyfillClosedShadowRootForPlaywright__'
const frameTreePath = 'chrome/juggler/content/content/FrameTree.js'
const frameTreeContextCreation = `    const world = this._runtime.createExecutionContext(this.domWindow(), sandbox, {
      frameId: this.id(),
      name,
    });`
const frameTreeGetterPatch = `    if (name === '${utilityWorldName}') {
      const nativeGetter = Object.getOwnPropertyDescriptor(
        this.domWindow().Element.prototype,
        '${closedShadowPropertyName}'
      )?.get;
      if (!nativeGetter)
        throw new Error('Firefox openOrClosedShadowRoot getter is unavailable');
      Cu.exportFunction(
        (host) => nativeGetter.call(host) ?? host.shadowRoot,
        sandbox,
        { defineAs: '${closedShadowHelperName}' }
      );
      Cu.evalInSandbox(
        '(function() {' +
          'const getClosedRoot = globalThis["${closedShadowHelperName}"];' +
          'Object.defineProperty(Element.prototype, "${closedShadowPropertyName}", {' +
            'configurable: true,' +
            'get() { return getClosedRoot(this); }' +
          '});' +
          'if (!delete globalThis["${closedShadowHelperName}"]) throw new Error("Temporary closed-shadow getter leaked");' +
        '})()',
        sandbox
      );
    }
`
const legacyFrameTreeGetterPatch = `    if (name === '${utilityWorldName}') {
      Cu.exportFunction(
        (host) => host.openOrClosedShadowRoot ?? host.shadowRoot,
        sandbox,
        { defineAs: '${legacyClosedShadowGetterName}' }
      );
    }
`
let closedShadowPatchAssertion: Promise<void> | undefined
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

export function assertClosedShadowSelectorPatched(): Promise<void> {
  closedShadowPatchAssertion ??= verifyClosedShadowSupport().catch((error: unknown) => {
    closedShadowPatchAssertion = undefined
    throw error
  })
  return closedShadowPatchAssertion
}

async function verifyClosedShadowSupport(): Promise<void> {
  const coreBundlePath = join(
    dirname(createRequire(import.meta.url).resolve('playwright-core')),
    'lib',
    'coreBundle.js'
  )
  const source = await readFile(coreBundlePath, 'utf8')
  if (
    !source.includes(
      'const shadows = [];\\n    const rootShadow = root.shadowRoot || root.openOrClosedShadowRoot;'
    ) ||
    !source.includes('root.shadowRoot || root.openOrClosedShadowRoot') ||
    !source.includes('element.shadowRoot || element.openOrClosedShadowRoot') ||
    source.includes(legacyClosedShadowGetterName) ||
    !source.includes(`UTILITY_WORLD_NAME2 = "${utilityWorldName}";`) ||
    source.includes('/* @openpolyfill-utility-world */')
  ) {
    throw new Error(
      `Playwright's selector bundle is not patched for closed shadow roots: ${coreBundlePath}. Reinstall dependencies to run the harness postinstall patch.`
    )
  }

  const binDir = dirname(firefox.executablePath())
  const firefoxDir = process.platform === 'darwin' ? join(binDir, '..', 'Resources') : binDir
  const zip = await JSZip.loadAsync(await readFile(join(firefoxDir, 'omni.ja')))
  const frameTree = zip.file(frameTreePath)
  const sourceInFirefox = frameTree ? await frameTree.async('string') : ''
  if (countOccurrences(sourceInFirefox, frameTreeGetterPatch) !== 1) {
    throw new Error(
      `Playwright Firefox's Juggler utility world is not patched for closed shadow roots: omni.ja:${frameTreePath}`
    )
  }
}

function patchFrameTreeGetter(content: string, file: string): string {
  const currentCount = countOccurrences(content, frameTreeGetterPatch)
  const legacyCount = countOccurrences(content, legacyFrameTreeGetterPatch)
  if (currentCount === 1 && legacyCount === 0) return content
  if (currentCount === 0 && legacyCount === 1)
    return replaceExactlyOnce(content, legacyFrameTreeGetterPatch, frameTreeGetterPatch, file)
  if (currentCount === 0 && legacyCount === 0)
    return replaceExactlyOnce(
      content,
      frameTreeContextCreation,
      frameTreeGetterPatch + frameTreeContextCreation,
      file
    )
  throw new Error(`Incompatible partial Juggler utility getter patch in ${file}`)
}

async function writeOmniArchive(zip: JSZip, omniPath: string): Promise<void> {
  const omniTmp = `${omniPath}.tmp-${process.pid}`
  await writeFile(omniTmp, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }))
  await rename(omniTmp, omniPath)
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
  const frameTree = zip.file(frameTreePath)
  if (!addon || !juggler || !frameTree)
    throw new Error(
      `Incompatible Playwright Firefox build: omni.ja is missing ${!addon ? addonPath : !juggler ? jugglerPath : frameTreePath}`
    )
  const addonBefore = await addon.async('string')
  const jugglerBefore = await juggler.async('string')
  const frameTreeBefore = await frameTree.async('string')
  const frameTreeSource = patchFrameTreeGetter(frameTreeBefore, `omni.ja:${frameTreePath}`)
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
    if (frameTreeSource !== frameTreeBefore) {
      zip.file(frameTreePath, frameTreeSource)
      await writeOmniArchive(zip, omniPath)
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
  zip.file(frameTreePath, frameTreeSource)

  const suffix = `\n${PATCH_MARKER}\nlockPref("marionette.running", true);\n// --- End Firefox Addon Playwright Harness ---\n`
  const cfgTmp = `${cfgPath}.tmp-${process.pid}`
  await writeOmniArchive(zip, omniPath)
  await writeFile(cfgTmp, cfg + suffix)
  await rename(cfgTmp, cfgPath)
}

export { replaceExactlyOnce }
