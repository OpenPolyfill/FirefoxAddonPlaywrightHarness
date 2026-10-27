import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import Module, { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { applyFirefoxPatchesForExecutable } from './patch.js'
type InstallOptions = {
  patchFirefox?: boolean
}

type FirefoxExecutable = {
  directory: string
  executablePath: () => string | undefined
  _install: (force: boolean) => Promise<void>
  _isHermeticInstallation?: boolean
}

type PlaywrightRegistry = {
  findExecutable: (name: string) => FirefoxExecutable | undefined
  install: (
    executables: FirefoxExecutable[],
    options?: { force?: boolean; gc?: boolean }
  ) => Promise<void>
}

type PlaywrightRegistryModule = {
  registry: PlaywrightRegistry
  registryDirectory: string
  browserDirectoryToMarkerFilePath: (browserDirectory: string) => string
}

type InstallationState = {
  executablePath: string
  markerPath: string
  patched: boolean
}

type InMemoryModule = NodeJS.Module & {
  _compile(source: string, filename: string): void
}

const require = createRequire(import.meta.url)
const registryModules = new Map<string, Promise<PlaywrightRegistryModule>>()
const installations = new Map<string, Promise<InstallationState>>()

function defaultCacheDirectory(): string {
  if (process.platform === 'linux') return process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches')
  if (process.platform === 'win32')
    return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  throw new Error(`Unsupported platform for Firefox browser installation: ${process.platform}`)
}

/** Resolve the browser-cache setting using Playwright's environment semantics. */
export function resolveFirefoxBrowsersPath(): string {
  const configuredPath = process.env.OPENPOLYFILL_BROWSERS_PATH
  if (configuredPath === '0') return '0'

  const basePath = configuredPath || join(defaultCacheDirectory(), 'openpolyfill')
  return resolve(process.env.INIT_CWD || process.cwd(), basePath)
}

/** Install and optionally patch Playwright's Firefox revision in the OpenPolyfill cache. */
export function ensureFirefoxInstalled(options: InstallOptions = {}): Promise<string> {
  const browsersPath = resolveFirefoxBrowsersPath()
  const patchFirefox = options.patchFirefox !== false
  const previous = installations.get(browsersPath)
  const operation = previous
    ? previous.then(async (state) => {
        if (!(await installationIsComplete(state)) || (patchFirefox && !state.patched)) {
          return runInstaller(browsersPath, patchFirefox)
        }
        return state
      })
    : runInstaller(browsersPath, patchFirefox)

  const current = operation.catch((error: unknown) => {
    if (installations.get(browsersPath) === current) installations.delete(browsersPath)
    throw error
  })
  installations.set(browsersPath, current)
  return current.then(({ executablePath }) => executablePath)
}

async function installationIsComplete(state: InstallationState): Promise<boolean> {
  try {
    await Promise.all([access(state.executablePath), access(state.markerPath)])
    return true
  } catch {
    return false
  }
}

async function runInstaller(
  browsersPath: string,
  patchFirefox: boolean
): Promise<InstallationState> {
  const playwrightRegistry = await loadPlaywrightRegistry(browsersPath)
  const registry = playwrightRegistry.registry
  const firefox = registry.findExecutable('firefox')
  if (
    !firefox ||
    typeof firefox._install !== 'function' ||
    firefox._isHermeticInstallation !== true
  ) {
    throw new Error(
      'The installed Playwright version does not provide a lock-safe Firefox browser installer'
    )
  }

  const executablePath = firefox.executablePath()
  if (!executablePath) {
    throw new Error(`Playwright Firefox is not supported on ${process.platform}/${process.arch}`)
  }
  const markerPath = playwrightRegistry.browserDirectoryToMarkerFilePath(firefox.directory)
  const originalInstall = firefox._install
  let patchApplied = false
  firefox._install = async (force: boolean) => {
    await originalInstall(force)
    try {
      await access(executablePath)
    } catch (error) {
      throw Object.assign(
        new Error(`Playwright Firefox installation is incomplete: ${executablePath}`, {
          cause: error
        }),
        { code: 'OPENPOLYFILL_INCOMPLETE_FIREFOX_INSTALL' }
      )
    }
    if (patchFirefox) {
      await applyFirefoxPatchesForExecutable(executablePath)
      patchApplied = true
    }
  }

  try {
    try {
      await registry.install([firefox], { gc: false })
    } catch (error) {
      if (!isIncompleteInstall(error)) throw error
      await registry.install([firefox], { force: true, gc: false })
    }
    if (patchFirefox && !patchApplied) {
      throw new Error(
        'Playwright skipped Firefox installation; cannot guarantee the Firefox patches are applied'
      )
    }
    await Promise.all([access(executablePath), access(markerPath)])
    return { executablePath, markerPath, patched: patchApplied }
  } finally {
    firefox._install = originalInstall
  }
}

function isIncompleteInstall(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'OPENPOLYFILL_INCOMPLETE_FIREFOX_INSTALL'
  )
}

function loadPlaywrightRegistry(browsersPath: string): Promise<PlaywrightRegistryModule> {
  let registryModule = registryModules.get(browsersPath)
  if (!registryModule) {
    registryModule = createPlaywrightRegistry(browsersPath).catch((error: unknown) => {
      registryModules.delete(browsersPath)
      throw error
    })
    registryModules.set(browsersPath, registryModule)
  }
  return registryModule
}

/**
 * Clone Playwright's pinned internal bundle so its registry has an independent
 * cache root and its download pipeline runs in this process rather than forking.
 */
async function createPlaywrightRegistry(browsersPath: string): Promise<PlaywrightRegistryModule> {
  const coreBundlePath = require.resolve('playwright-core/lib/coreBundle')
  let source = await readFile(coreBundlePath, 'utf8')
  source = replaceExactlyOnce(
    source,
    'const envDefined = getFromENV("PLAYWRIGHT_BROWSERS_PATH");',
    `const envDefined = ${JSON.stringify(browsersPath)};`,
    'browser cache configuration'
  )

  const installerStart = source.indexOf('async function downloadBrowserWithProgressBar(')
  const downloaderStart = source.indexOf(
    'function downloadBrowserWithProgressBarOutOfProcess(',
    installerStart
  )
  const downloaderEnd = source.indexOf('\nfunction logPolitely(', downloaderStart)
  if (installerStart < 0 || downloaderStart < 0 || downloaderEnd < 0) {
    throw new Error(
      'Unsupported Playwright browser installer internals: cannot locate its Firefox download implementation'
    )
  }

  let installer = source.slice(installerStart, downloaderStart)
  installer = replaceExactlyOnce(
    installer,
    '    process.exitCode = 1;\n',
    '',
    'download failure handling'
  )
  source = `${source.slice(0, installerStart)}${installer}${source.slice(downloaderStart)}`

  const updatedDownloaderStart = source.indexOf(
    'function downloadBrowserWithProgressBarOutOfProcess(',
    installerStart
  )
  const updatedDownloaderEnd = source.indexOf('\nfunction logPolitely(', updatedDownloaderStart)
  if (updatedDownloaderStart < 0 || updatedDownloaderEnd < 0) {
    throw new Error(
      'Unsupported Playwright browser installer internals: cannot locate its out-of-process downloader'
    )
  }
  const inProcessDownloader = `async function downloadBrowserInProcess(title, browserDirectory, url3, zipPath, executablePath, socketTimeout) {
  const options = { title, browserDirectory, url: url3, zipPath, executablePath, socketTimeout, userAgent: getUserAgent() };
  try {
    await main(options);
    return { error: null };
  } catch (error) {
    return { error };
  }
}
`
  source = `${source.slice(0, updatedDownloaderStart)}${inProcessDownloader}${source.slice(updatedDownloaderEnd)}`
  source = replaceExactlyOnce(
    source,
    'downloadBrowserWithProgressBarOutOfProcess(title, browserDirectory, url3, zipPath, executablePath, downloadSocketTimeout)',
    'downloadBrowserInProcess(title, browserDirectory, url3, zipPath, executablePath, downloadSocketTimeout)',
    'in-process downloader call'
  )
  source = replaceFunctionWithNoop(
    source,
    'function log(message) {',
    'function log() {}',
    'download log function'
  )
  source = replaceFunctionWithNoop(
    source,
    'function progress(done, total) {',
    'function progress() {}',
    'download progress function'
  )
  const oopEntryStart = source.indexOf('function runOopDownloadBrowserMain() {')
  const oopEntryEnd = source.indexOf('\nvar import_fs17', oopEntryStart)
  if (oopEntryStart < 0 || oopEntryEnd < 0) {
    throw new Error(
      'Unsupported Playwright browser installer internals: cannot locate its worker entry point'
    )
  }
  source = `${source.slice(0, oopEntryStart)}function runOopDownloadBrowserMain() {}${source.slice(oopEntryEnd)}`

  const suffix = createHash('sha256').update(browsersPath).digest('hex').slice(0, 12)
  const modulePath = join(dirname(coreBundlePath), `coreBundle.openpolyfill-${suffix}.js`)
  const clone = new Module(modulePath) as InMemoryModule
  clone.filename = modulePath
  clone.path = dirname(modulePath)
  clone.paths = (
    Module as unknown as { _nodeModulePaths(directory: string): string[] }
  )._nodeModulePaths(clone.path)
  clone._compile(source, modulePath)

  // coreBundle is an internal Playwright API; validate its exported shape before using it.
  const bundleExports = clone.exports as { registry?: PlaywrightRegistryModule }
  const registryModule = bundleExports.registry
  if (
    !registryModule ||
    typeof registryModule.registry?.findExecutable !== 'function' ||
    typeof registryModule.registry?.install !== 'function'
  ) {
    throw new Error(
      'The installed Playwright version does not expose the browser registry installer required by the Firefox harness'
    )
  }
  return registryModule
}

function replaceExactlyOnce(
  source: string,
  search: string,
  replacement: string,
  description: string
): string {
  const firstIndex = source.indexOf(search)
  if (firstIndex === -1 || source.indexOf(search, firstIndex + search.length) !== -1) {
    throw new Error(`Unsupported Playwright browser installer internals: ${description} changed`)
  }
  return `${source.slice(0, firstIndex)}${replacement}${source.slice(firstIndex + search.length)}`
}

function replaceFunctionWithNoop(
  source: string,
  signature: string,
  replacement: string,
  description: string
): string {
  const start = source.indexOf(signature)
  const end = source.indexOf('\n}', start)
  if (start === -1 || source.indexOf(signature, start + signature.length) !== -1 || end === -1) {
    throw new Error(`Unsupported Playwright browser installer internals: ${description} changed`)
  }
  return `${source.slice(0, start)}${replacement}${source.slice(end + 2)}`
}
