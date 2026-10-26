import { fork } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type InstallOptions = {
  patchFirefox?: boolean
}

type InstallerMessage =
  { type: 'complete'; executablePath: string } | { type: 'error'; message: string; stack?: string }

const installerPath = fileURLToPath(new URL('../scripts/install-firefox.mjs', import.meta.url))
const installPromises = new Map<string, Promise<string>>()

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

/** Install and optionally patch the pinned Playwright Firefox revision. */
export function ensureFirefoxInstalled(options: InstallOptions = {}): Promise<string> {
  const browsersPath = resolveFirefoxBrowsersPath()
  const patchFirefox = options.patchFirefox !== false
  const key = `${browsersPath}\0${patchFirefox}`
  let installation = installPromises.get(key)
  if (!installation) {
    installation = runInstaller(browsersPath, patchFirefox).catch((error: unknown) => {
      installPromises.delete(key)
      throw error
    })
    installPromises.set(key, installation)
  }
  return installation
}

function runInstaller(browsersPath: string, patchFirefox: boolean): Promise<string> {
  return new Promise((resolveInstall, rejectInstall) => {
    const child = fork(installerPath, [], {
      execArgv: [],
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: browsersPath,
        OPENPOLYFILL_INSTALL_PATCH_FIREFOX: patchFirefox ? '1' : '0'
      },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc']
    })
    let result: InstallerMessage | undefined
    let settled = false

    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return
      const candidate = message as InstallerMessage
      if (candidate.type === 'complete' || candidate.type === 'error') result = candidate
    })
    child.once('error', (error: Error) => {
      if (settled) return
      settled = true
      rejectInstall(error)
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      if (code === 0 && result?.type === 'complete') {
        resolveInstall(result.executablePath)
        return
      }
      if (result?.type === 'error') {
        rejectInstall(
          new Error(result.message, { cause: result.stack ? new Error(result.stack) : undefined })
        )
        return
      }
      rejectInstall(
        new Error(
          `Playwright Firefox installation process exited ${code === null ? `with signal ${signal}` : `with code ${code}`}`
        )
      )
    })
  })
}
