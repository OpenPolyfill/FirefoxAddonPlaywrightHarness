import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { firefox } from '@playwright/test'
import {
  applyUnifiedPatchSet,
  atomicWrite,
  getPatchPaths,
  type UnifiedPatchResult
} from '../scripts/unified-patch.mjs'

const packageDir = dirname(fileURLToPath(import.meta.url))
const firefoxPatchPath = join(packageDir, '../patches/firefox.patch')
const firefoxLocalModePatchPath = join(packageDir, '../patches/firefox-local-mode.patch')
const firefoxWebRequestPatchPath = join(packageDir, '../patches/firefox-webrequest.patch')
const playwrightPatchPath = join(packageDir, '../patches/playwright-core.patch')
let patchPromise: Promise<void> | undefined
let patchAssertion: Promise<void> | undefined
let localModePatchAssertion: Promise<void> | undefined

function firefoxDirectory(): string {
  const binDir = dirname(firefox.executablePath())
  return process.platform === 'darwin' ? join(binDir, '..', 'Resources') : binDir
}

function playwrightCoreBundlePath(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('playwright-core')), 'lib', 'coreBundle.js')
}
interface FirefoxLocalModePatchTarget {
  patchText: string
  patchPaths: string[]
  archivePath: string
  memberPaths: Record<string, string>
  zip: JSZip
  sources: Record<string, string>
}

interface FirefoxPatchTargets {
  patchText: string
  webRequestPatchText: string
  patchPaths: string[]
  omniPath: string
  cfgPath: string
  zip: JSZip
  sources: Record<string, string>
}
async function loadFirefoxLocalModePatchTarget(): Promise<FirefoxLocalModePatchTarget | undefined> {
  const patchText = await readFile(firefoxLocalModePatchPath, 'utf8')
  const patchPaths = getPatchPaths(patchText, 'Firefox Local Mode')
  if (!patchPaths.length || patchPaths.some((path) => !path.startsWith('browser/omni.ja/'))) {
    throw new Error('Firefox Local Mode patch must target browser/omni.ja members')
  }
  const archivePath = join(firefoxDirectory(), 'browser', 'omni.ja')
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(await readFile(archivePath))
  } catch (error) {
    throw new Error(`Cannot load Firefox Browser archive ${archivePath}`, { cause: error })
  }
  const memberPaths: Record<string, string> = Object.create(null)
  const sources: Record<string, string> = Object.create(null)
  for (const patchPath of patchPaths) {
    const memberPath = patchPath.slice('browser/omni.ja/'.length)
    const entry = zip.file(memberPath)
    if (!entry) return undefined
    memberPaths[patchPath] = memberPath
    sources[patchPath] = await entry.async('string')
  }
  return { patchText, patchPaths, archivePath, memberPaths, zip, sources }
}

async function loadFirefoxPatchTargets(): Promise<FirefoxPatchTargets> {
  const firefoxDir = firefoxDirectory()
  const omniPath = join(firefoxDir, 'omni.ja')
  const cfgPath = join(firefoxDir, 'playwright.cfg')
  const patchText = await readFile(firefoxPatchPath, 'utf8')
  const webRequestPatchText = await readFile(firefoxWebRequestPatchPath, 'utf8')
  const patchPaths = [
    ...new Set([
      ...getPatchPaths(patchText, 'Playwright Firefox'),
      ...getPatchPaths(webRequestPatchText, 'Playwright Firefox WebRequest')
    ])
  ]
  if (
    !patchPaths.includes('playwright.cfg') ||
    !patchPaths.some((path) => path.startsWith('omni.ja/'))
  )
    throw new Error('Playwright Firefox patch must cover both playwright.cfg and omni.ja')
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(await readFile(omniPath))
  } catch (error) {
    throw new Error(`Cannot load Playwright Firefox archive ${omniPath}`, { cause: error })
  }
  const sources: Record<string, string> = Object.create(null)

  for (const path of patchPaths) {
    if (path === 'playwright.cfg') {
      try {
        sources[path] = await readFile(cfgPath, 'utf8')
      } catch (error) {
        throw new Error(`Cannot patch Playwright Firefox: missing ${cfgPath}`, { cause: error })
      }
      continue
    }
    if (!path.startsWith('omni.ja/'))
      throw new Error(`Unexpected Playwright Firefox patch target: ${path}`)
    const memberPath = path.slice('omni.ja/'.length)
    const entry = zip.file(memberPath)
    if (!entry)
      throw new Error(`Incompatible Playwright Firefox build: omni.ja is missing ${memberPath}`)
    sources[path] = await entry.async('string')
  }

  return { patchText, webRequestPatchText, patchPaths, omniPath, cfgPath, zip, sources }
}

function applyFirefoxPatchTargets(target: FirefoxPatchTargets): UnifiedPatchResult {
  const baseResult = applyUnifiedPatchSet(target.sources, target.patchText, 'Playwright Firefox')
  const webRequestSources = { ...target.sources, ...baseResult.files }
  const webRequestResult = applyUnifiedPatchSet(
    webRequestSources,
    target.webRequestPatchText,
    'Playwright Firefox WebRequest'
  )
  if (baseResult.state === 'unpatched' && webRequestResult.state === 'patched') {
    throw new Error(
      'Partially applied Playwright Firefox patch set: WebRequest patch is installed without the base patch'
    )
  }
  return {
    state:
      baseResult.state === 'patched' && webRequestResult.state === 'patched'
        ? 'patched'
        : 'unpatched',
    files: { ...baseResult.files, ...webRequestResult.files }
  }
}

async function firefoxPatchState(): Promise<'unpatched' | 'patched'> {
  const target = await loadFirefoxPatchTargets()
  return applyFirefoxPatchTargets(target).state
}

export async function ensureFirefoxPatched(): Promise<void> {
  patchPromise ??= patchFirefoxInstallation().catch((error: unknown) => {
    patchPromise = undefined
    throw error
  })
  return patchPromise
}
export function assertFirefoxLocalModePatchApplied(version?: string): Promise<void> {
  localModePatchAssertion ??= verifyFirefoxLocalModePatchApplied(version).catch(
    (error: unknown) => {
      localModePatchAssertion = undefined
      throw error
    }
  )
  return localModePatchAssertion
}

async function verifyFirefoxLocalModePatchApplied(version?: string): Promise<void> {
  const target = await loadFirefoxLocalModePatchTarget()
  if (!target) {
    throw new Error(
      `Firefox localMappings requires Firefox 153+ DevTools Local Mode; the Local Mode module is unavailable${version ? ` in Firefox ${version}` : ''}`
    )
  }
  const state = applyUnifiedPatchSet(target.sources, target.patchText, 'Firefox Local Mode').state
  if (state !== 'patched') {
    throw new Error(
      `Firefox Local Mode compatibility patch is not applied${version ? ` (Firefox ${version})` : ''}; run the harness global setup and do not set patchFirefox: false`
    )
  }
}

export function assertClosedShadowSelectorPatched(): Promise<void> {
  patchAssertion ??= verifyPatchesApplied().catch((error: unknown) => {
    patchAssertion = undefined
    throw error
  })
  return patchAssertion
}

async function verifyPatchesApplied(): Promise<void> {
  const coreBundlePath = playwrightCoreBundlePath()
  const corePatchText = await readFile(playwrightPatchPath, 'utf8')
  const coreSources = { 'lib/coreBundle.js': await readFile(coreBundlePath, 'utf8') }
  const coreState = applyUnifiedPatchSet(coreSources, corePatchText, 'Playwright core bundle').state
  if (coreState !== 'patched') {
    throw new Error(
      `Playwright's selector bundle is not patched for closed shadow roots: ${coreBundlePath}. Reinstall dependencies to run the package postinstall patch.`
    )
  }

  if ((await firefoxPatchState()) !== 'patched') {
    throw new Error(
      `Playwright Firefox is not patched for extension popup and sidebar Pages. Run the package global setup before the test suite.`
    )
  }
}

async function patchFirefoxInstallation(): Promise<void> {
  const target = await loadFirefoxPatchTargets()
  const result = applyFirefoxPatchTargets(target)
  const localModeTarget = await loadFirefoxLocalModePatchTarget()
  const localModeResult = localModeTarget
    ? applyUnifiedPatchSet(localModeTarget.sources, localModeTarget.patchText, 'Firefox Local Mode')
    : undefined

  if (result.state === 'unpatched') {
    for (const path of target.patchPaths) {
      if (path === 'playwright.cfg') continue
      const contents = result.files[path]
      if (contents === undefined) throw new Error(`Missing patched Firefox archive member: ${path}`)
      target.zip.file(path.slice('omni.ja/'.length), contents)
    }

    const archive = await target.zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
    const patchedConfig = result.files['playwright.cfg']
    if (patchedConfig === undefined) throw new Error('Missing patched playwright.cfg')
    await atomicWrite(target.omniPath, archive)
    await atomicWrite(target.cfgPath, patchedConfig)
  }

  if (localModeTarget && localModeResult?.state === 'unpatched') {
    for (const path of localModeTarget.patchPaths) {
      const contents = localModeResult.files[path]
      const memberPath = localModeTarget.memberPaths[path]
      if (contents === undefined || memberPath === undefined)
        throw new Error(`Missing patched Firefox Local Mode member: ${path}`)
      localModeTarget.zip.file(memberPath, contents)
    }
    const archive = await localModeTarget.zip.generateAsync({
      type: 'nodebuffer',
      compression: 'STORE'
    })
    await atomicWrite(localModeTarget.archivePath, archive)
  }
}
