import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'
import type { FirefoxRDP, WatcherFront } from '@openpolyfill/firefox-rdp'
import { assertFirefoxLocalModePatchApplied } from './patch.js'

const networkEventResource = 'network-event'

type NetworkParentFront = {
  api: {
    setLocalModeMappings?: (mappings: Record<string, string>) => Promise<unknown>
  }
}

type LocalModePage = {
  watcher: WatcherFront
  networkParent: NetworkParentFront
}

type PageRegistration = {
  ready: Promise<LocalModePage>
  cleanup?: Promise<void>
}

export interface FirefoxLocalModeController {
  close(): Promise<void>
}

export async function resolveLocalMappings(
  mappings: Record<string, string> | undefined
): Promise<Record<string, string> | undefined> {
  if (!mappings || Object.keys(mappings).length === 0) return undefined

  const normalized: Record<string, string> = Object.create(null)
  for (const [host, directory] of Object.entries(mappings)) {
    let url: URL
    try {
      url = new URL(`https://${host}`)
    } catch (error) {
      throw new Error(`Invalid Firefox Local Mode hostname: ${host}`, { cause: error })
    }
    if (
      !url.hostname ||
      url.port ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error(
        `localMappings keys must be hostnames without a scheme, port, or path: ${host}`
      )
    }
    const normalizedHost = url.hostname
    if (Object.hasOwn(normalized, normalizedHost))
      throw new Error(
        `Duplicate Firefox Local Mode hostname after normalization: ${normalizedHost}`
      )
    if (!directory || typeof directory !== 'string')
      throw new Error(`localMappings['${host}'] must be a local directory path`)

    const absoluteDirectory = resolve(directory)
    let directoryInfo
    try {
      directoryInfo = await stat(absoluteDirectory)
    } catch (error) {
      throw new Error(`Firefox Local Mode directory does not exist: ${absoluteDirectory}`, {
        cause: error
      })
    }
    if (!directoryInfo.isDirectory())
      throw new Error(`Firefox Local Mode mapping target is not a directory: ${absoluteDirectory}`)
    normalized[normalizedHost] = absoluteDirectory
  }
  return normalized
}

export async function attachFirefoxLocalMappings(
  context: BrowserContext,
  rdp: FirefoxRDP,
  mappings: Record<string, string> | undefined
): Promise<FirefoxLocalModeController | undefined> {
  if (!mappings || Object.keys(mappings).length === 0) return undefined

  const registrations = new Map<Page, PageRegistration>()
  let setupQueue = Promise.resolve()
  let closing = false
  let closePromise: Promise<void> | undefined

  const registerPage = (page: Page): Promise<LocalModePage> => {
    if (closing) return Promise.reject(new Error('Firefox Local Mode controller is closed'))
    const existing = registrations.get(page)
    if (existing) return existing.ready

    const ready = setupQueue.then(() => setupPage(page, rdp, mappings))
    setupQueue = ready.then(
      () => undefined,
      () => undefined
    )
    const registration: PageRegistration = { ready }
    registrations.set(page, registration)
    page.once('close', () => {
      void cleanupPage(page, registration).catch(() => {})
    })
    return ready
  }

  const onPage = (page: Page): void => {
    void registerPage(page).catch(() => {})
  }
  context.on('page', onPage)

  const originalNewPage = context.newPage
  const originalContextClose = context.close
  const wrappedNewPage = async (): Promise<Page> => {
    const page = await originalNewPage.call(context)
    await registerPage(page)
    return page
  }
  const wrappedContextClose = async (...args: Parameters<BrowserContext['close']>) => {
    let cleanupError: unknown
    try {
      await close()
    } catch (error) {
      cleanupError = error
    }
    await originalContextClose.apply(context, args)
    if (cleanupError) throw cleanupError
  }
  try {
    context.newPage = wrappedNewPage
    context.close = wrappedContextClose
  } catch (error) {
    if (context.newPage === wrappedNewPage) context.newPage = originalNewPage
    context.off('page', onPage)
    throw new Error('Cannot enable per-page Firefox Local Mode mapping lifecycle', { cause: error })
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closing = true
    context.off('page', onPage)
    context.off('close', onContextClose)
    if (context.newPage === wrappedNewPage) context.newPage = originalNewPage
    if (context.close === wrappedContextClose) context.close = originalContextClose

    closePromise = (async () => {
      const results = await Promise.allSettled(
        [...registrations].map(([page, registration]) => cleanupPage(page, registration))
      )
      registrations.clear()
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') {
        throw new Error('Failed to clear Firefox Local Mode mappings during context cleanup', {
          cause: failure.reason
        })
      }
    })()
    return closePromise
  }

  const onContextClose = (): void => {
    void close().catch(() => {})
  }
  context.once('close', onContextClose)

  const pages = context.pages()
  try {
    await Promise.all(pages.map(registerPage))
  } catch (error) {
    await close().catch(() => {})
    throw error
  }

  return { close }

  async function cleanupPage(page: Page, registration: PageRegistration): Promise<void> {
    if (registration.cleanup) return registration.cleanup
    registration.cleanup = (async () => {
      try {
        const localModePage = await registration.ready
        const setLocalModeMappings = localModePage.networkParent.api.setLocalModeMappings
        try {
          if (setLocalModeMappings) await setLocalModeMappings({})
        } finally {
          await localModePage.watcher.unwatchResources([networkEventResource])
        }
      } catch (error) {
        if (!page.isClosed()) throw error
      } finally {
        registrations.delete(page)
      }
    })()
    return registration.cleanup
  }
}

async function setupPage(
  page: Page,
  rdp: FirefoxRDP,
  mappings: Record<string, string>
): Promise<LocalModePage> {
  if (page.isClosed()) throw new Error('Cannot configure Firefox Local Mode on a closed page')

  const userAgent = await page.evaluate(() => navigator.userAgent)
  const versionMatch = /Firefox\/(\d+(?:\.\d+)?)/.exec(userAgent)
  const version = versionMatch?.[1]
  const majorVersion = version === undefined ? undefined : Number(version.split('.')[0])
  if (majorVersion !== undefined && majorVersion < 153) {
    throw new Error(
      `Firefox localMappings require Firefox 153 or newer with DevTools Local Mode; found Firefox ${version}`
    )
  }
  await assertFirefoxLocalModePatchApplied(version)

  await page.bringToFront()
  const tab = (await rdp.root.listTabs()).find((candidate) => candidate.selected)
  if (!tab) throw new Error('Firefox RDP did not expose the selected tab for localMappings')
  if (typeof tab.getWatcher !== 'function') {
    throw missingCapability(version, 'TabDescriptorActor.getWatcher')
  }

  let watcher: WatcherFront | undefined
  let networkParent: NetworkParentFront | undefined
  try {
    watcher = await tab.getWatcher()
    if (typeof watcher.watchResources !== 'function') {
      throw missingCapability(version, 'WatcherActor.watchResources')
    }
    await watcher.watchResources([networkEventResource])

    const getNetworkParentActor = watcher.api.getNetworkParentActor
    if (typeof getNetworkParentActor !== 'function') {
      throw missingCapability(version, 'WatcherActor.getNetworkParentActor')
    }
    networkParent = (await getNetworkParentActor()) as NetworkParentFront
    const setLocalModeMappings = networkParent?.api?.setLocalModeMappings
    if (typeof setLocalModeMappings !== 'function') {
      throw missingCapability(version, 'NetworkParentActor.setLocalModeMappings')
    }
    await setLocalModeMappings(mappings)
    return { watcher, networkParent }
  } catch (error) {
    const clearMappings = networkParent?.api?.setLocalModeMappings
    if (clearMappings) await clearMappings({}).catch(() => {})
    if (error instanceof Error && error.message.includes('Firefox 153+ DevTools Local Mode'))
      throw error
    throw new Error(
      `Firefox localMappings requires Firefox 153+ DevTools Local Mode RDP capabilities${version ? ` (detected Firefox ${version})` : ''}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
}

function missingCapability(version: string | undefined, capability: string): Error {
  return new Error(
    `Firefox localMappings requires Firefox 153+ DevTools Local Mode; ${capability} is unavailable${version ? ` in Firefox ${version}` : ''}`
  )
}
