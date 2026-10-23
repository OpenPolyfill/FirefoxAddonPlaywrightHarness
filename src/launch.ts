import { firefox, type BrowserContext, type Frame, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireRdpPort } from './port.js'
import { trackTempDir, removeTempDir, bounded } from './cleanup.js'
import { ensureFirefoxPatched, assertClosedShadowSelectorPatched } from './patch.js'
import { FirefoxRdpSession, RdpEvaluation } from './rdp.js'
import { FirefoxErrorDiagnostics } from './diagnostics.js'
import {
  configureNativeMessagingDirectory,
  prepareNativeMessagingHosts
} from './native-messaging.js'
import { NativeMessagingObserver } from './native-messaging-observer.js'
import {
  attachFirefoxLocalMappings,
  resolveLocalMappings,
  type FirefoxLocalModeController
} from './local-mode.js'
import { RdpIsolatedNamespace } from './isolated.js'

import type {
  FirefoxExtension,
  FirefoxHarnessConfig,
  FirefoxIsolatedPage,
  FirefoxLaunchResult,
  ActionKind,
  InternalFirefoxContext
} from './types.js'

const requiredPrefs: Record<string, boolean | number> = {
  'xpinstall.signatures.required': false,
  'extensions.autoDisableScopes': 0,
  'extensions.enabledScopes': 15,
  'devtools.debugger.remote-enabled': true,
  'devtools.debugger.prompt-connection': false,
  'dom.ipc.processCount': 8
}

type LaunchOptions = Parameters<typeof firefox.launchPersistentContext>[1]

function launchOptions(config: FirefoxHarnessConfig, port: number): LaunchOptions {
  const userOptions = config.launchOptions ?? {}
  const suppliedPrefs =
    typeof userOptions.firefoxUserPrefs === 'object' && userOptions.firefoxUserPrefs
      ? (userOptions.firefoxUserPrefs as Record<string, boolean | number | string>)
      : {}
  const suppliedArgs = Array.isArray(userOptions.args)
    ? userOptions.args.filter((arg): arg is string => typeof arg === 'string')
    : []
  return {
    ...userOptions,
    headless: config.headless,
    firefoxUserPrefs: { ...suppliedPrefs, ...config.firefoxUserPrefs, ...requiredPrefs },
    args: [...suppliedArgs, ...(config.args ?? []), `-start-debugger-server=${port}`],
    executablePath: firefox.executablePath()
  } as LaunchOptions
}
export async function launchFirefoxExtension(
  config: FirefoxHarnessConfig
): Promise<FirefoxLaunchResult> {
  if (!config.extensionPath) throw new Error('extensionPath is required')
  const extensionPath = resolve(config.extensionPath)
  const localMappings = await resolveLocalMappings(config.localMappings)
  const releasePort = await acquireRdpPort()
  const userDataDir = trackTempDir(await mkdtemp(join(tmpdir(), 'firefox-addon-test-')))
  let context: BrowserContext | undefined
  let session: FirefoxRdpSession | undefined
  let extension: FirefoxExtension | undefined
  let diagnostics: FirefoxErrorDiagnostics | undefined
  let localMode: FirefoxLocalModeController | undefined
  let nativeMessaging: NativeMessagingObserver | undefined
  let nativeManifestBaseDir: string | undefined
  try {
    const hasNativeMessagingHosts = Object.keys(config.nativeMessagingHosts ?? {}).length > 0
    nativeMessaging = await NativeMessagingObserver.create(userDataDir, hasNativeMessagingHosts)
    nativeManifestBaseDir = await prepareNativeMessagingHosts(
      userDataDir,
      config.nativeMessagingHosts,
      nativeMessaging.socketPath
    )
    if (config.patchFirefox !== false) await ensureFirefoxPatched()
    await assertClosedShadowSelectorPatched()
    context = await firefox.launchPersistentContext(
      userDataDir,
      launchOptions(config, releasePort.port)
    )
    context.once('close', () => {
      void nativeMessaging?.close()
    })
    session = await FirefoxRdpSession.connect(releasePort.port)
    diagnostics = new FirefoxErrorDiagnostics(session)
    await diagnostics.start()
    ;(context as InternalFirefoxContext)._firefoxHarnessDiagnostics = diagnostics
    if (nativeManifestBaseDir) {
      const chromeTarget = session.chromeTarget
      if (!chromeTarget)
        throw new Error('Firefox RDP did not expose the chrome target for native manifest setup')
      await configureNativeMessagingDirectory(session.rdp, chromeTarget, nativeManifestBaseDir)
    }
    const installed = await session.installExtension(extensionPath)
    diagnostics.setExtensionId(installed.id)
    extension = new FirefoxExtensionHandle(
      session,
      context,
      installed.id,
      extensionPath,
      installed.background,
      diagnostics
    )
    localMode = await attachFirefoxLocalMappings(context, session.rdp, localMappings)

    const result: FirefoxLaunchResult = {
      context,
      rdp: session.rdp,
      extension,
      nativeMessaging,
      userDataDir,
      rdpPort: releasePort.port,
      close: async () => {
        try {
          await localMode?.close()
        } finally {
          try {
            await extension?.close()
          } finally {
            try {
              await bounded(context?.close() ?? Promise.resolve(), 10_000, undefined)
            } finally {
              try {
                await nativeMessaging?.close()
              } finally {
                try {
                  await removeTempDir(userDataDir)
                } finally {
                  await releasePort.release()
                }
              }
            }
          }
        }
      }
    }
    return result
  } catch (error) {
    await localMode?.close().catch(() => {})
    if (extension) {
      await extension.close().catch(() => {})
    } else {
      await diagnostics?.close().catch(() => undefined)
      session?.close()
    }
    await bounded(context?.close() ?? Promise.resolve(), 10_000, undefined).catch(() => undefined)
    await nativeMessaging?.close().catch(() => undefined)
    await removeTempDir(userDataDir).finally(() => releasePort.release())
    throw error
  }
}

class FirefoxExtensionHandle implements FirefoxExtension {
  readonly background?: RdpEvaluation
  readonly isolatedContexts: RdpIsolatedNamespace
  private isolatedPage?: Page
  private extensionBaseUrl?: string
  private closed = false

  constructor(
    private readonly session: FirefoxRdpSession,
    private readonly browserContext: BrowserContext,
    readonly id: string,
    readonly installPath: string,
    background: RdpEvaluation | undefined,
    private readonly diagnostics: FirefoxErrorDiagnostics
  ) {
    this.background = background
    this.isolatedContexts = new RdpIsolatedNamespace(session, id)
  }

  get isolated(): FirefoxIsolatedPage {
    if (!this.isolatedPage)
      throw new Error('Firefox extension isolated evaluation is not bound to a Playwright page')
    return this.isolatedContexts.get(this.isolatedPage)
  }

  bindIsolatedPage(page: Page): void {
    this.isolatedPage = page
  }

  private async getExtensionBaseUrl(): Promise<string> {
    if (this.extensionBaseUrl) return this.extensionBaseUrl
    const chrome = this.session.chromeTarget
    if (!chrome)
      throw new Error('Firefox RDP did not expose the parent chrome target for extension lookup')
    const evaluation = new RdpEvaluation(this.session.rdp, chrome.console())
    try {
      const baseUrl = await evaluation.evaluate(`(() => {
        const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs')
        const extension = ExtensionParent.GlobalManager.extensionMap.get(${JSON.stringify(this.id)})
        if (!extension) throw new Error('Firefox extension is not registered')
        return extension.baseURI.spec
      })()`)
      if (typeof baseUrl !== 'string' || !baseUrl.startsWith('moz-extension://'))
        throw new Error('Firefox extension did not expose a moz-extension base URL')
      this.extensionBaseUrl = baseUrl
      return baseUrl
    } finally {
      evaluation.dispose()
    }
  }
  private async waitForExtensionPage(
    kind: 'extension-popup' | 'extension-sidebar',
    timeout: number,
    opener?: Page,
    targetId?: string,
    includeExisting = false
  ): Promise<Page> {
    let promise: Promise<Page>
    let resolve!: (page: Page | PromiseLike<Page>) => void
    let reject!: (reason?: unknown) => void
    if (Promise.withResolvers) {
      const resolvers = Promise.withResolvers<Page>()
      promise = resolvers.promise
      resolve = resolvers.resolve
      reject = resolvers.reject
    } else {
      promise = new Promise<Page>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
      })
    }
    const existingPages = new Set(this.browserContext.pages())
    const pendingPages = new Map<Page, (frame: Frame) => void>()
    const checkingPages = new Set<Page>()
    let settled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      clearTimeout(timeoutId)
      clearInterval(pollId)
      this.browserContext.off('page', onPage)
      this.browserContext.off('close', onContextClose)
      for (const [page, listener] of pendingPages) page.off('framenavigated', listener)
      pendingPages.clear()
    }
    const finish = (page: Page) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(page)
    }
    const onContextClose = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Browser context closed while waiting for extension page'))
    }
    const matchPage = async (page: Page) => {
      if (settled || (!includeExisting && existingPages.has(page)) || checkingPages.has(page))
        return
      checkingPages.add(page)
      try {
        const identity = await page
          .evaluate(() => {
            const value = (
              window as unknown as {
                __openpolyfillFirefoxUiTarget?: { targetId?: string; kind?: string }
              }
            ).__openpolyfillFirefoxUiTarget
            return value && typeof value === 'object' ? value : null
          })
          .catch(() => null)
        if (identity?.kind !== kind || (targetId && identity.targetId !== targetId)) return
        if (opener) {
          try {
            if ((await page.opener()) !== opener) return
          } catch {
            return
          }
        }
        finish(page)
      } finally {
        checkingPages.delete(page)
      }
    }
    const onPage = (page: Page) => {
      if (settled || pendingPages.has(page)) return
      const onFrameNavigated = (frame: Frame) => {
        if (frame === page.mainFrame()) void matchPage(page)
      }
      pendingPages.set(page, onFrameNavigated)
      page.on('framenavigated', onFrameNavigated)
      void matchPage(page)
    }
    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        settled = true
        cleanup()
        reject(new Error(`Timeout ${timeout}ms exceeded while waiting for extension page`))
      }, timeout)
    }
    this.browserContext.on('page', onPage)
    this.browserContext.on('close', onContextClose)
    const pollId = setInterval(() => {
      for (const page of this.browserContext.pages()) {
        onPage(page)
        void matchPage(page)
      }
    }, 50)
    if (includeExisting) {
      for (const page of existingPages) onPage(page)
    }
    return promise
  }

  activateAction(page: Page, kind?: ActionKind): Promise<Page>
  activateAction(page: Page, kind: ActionKind, options: { waitForPopup: false }): Promise<void>
  async activateAction(
    page: Page,
    kind: ActionKind = 'browserAction',
    options: { waitForPopup?: boolean } = {}
  ): Promise<Page | void> {
    if (this.closed) throw new Error('Extension harness is closed')
    const popup =
      options.waitForPopup === false
        ? undefined
        : this.waitForExtensionPage('extension-popup', 15_000)
    popup?.catch(() => undefined)
    await page.bringToFront()
    const chrome = this.session.chromeTarget
    if (!chrome)
      throw new Error(
        'Firefox RDP did not expose the parent chrome target for extension action activation'
      )
    const chromeEvaluation = new RdpEvaluation(this.session.rdp, chrome.console())
    try {
      if (kind === 'pageAction') {
        await chromeEvaluation.evaluate(`(async () => {
          const action = PageActions.actions.find(action => action.extensionID === ${JSON.stringify(this.id)})
          if (!action) throw new Error('Firefox pageAction is not registered in the chrome action list')
          let node
          for (let attempt = 0; attempt < 200 && !node; attempt++) {
            node = document.getElementById('pageAction-urlbar-' + action.id)
            if (!node) await new Promise(resolve => setTimeout(resolve, 25))
          }
          if (!node) throw new Error('Firefox pageAction has no active-tab URL-bar control')
          BrowserPageActions.doCommandForAction(action, { button: 0, modifiers: [], target: node }, node)
        })()`)
      } else {
        await chromeEvaluation.evaluate(`(async () => {
          const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs')
          const extension = ExtensionParent.GlobalManager.extensionMap.get(${JSON.stringify(this.id)})
          if (!extension) throw new Error('Firefox extension is not registered')
          const action = ExtensionParent.apiManager.global.browserActionFor?.(extension)
          if (!action) throw new Error('Firefox browserAction is not registered')
          action.triggerAction(window)
        })()`)
      }
    } finally {
      chromeEvaluation.dispose()
    }
    if (popup) return popup
  }

  async activateSidebar(page: Page): Promise<Page> {
    if (this.closed) throw new Error('Extension harness is closed')
    const baseUrl = await this.getExtensionBaseUrl()
    await page.bringToFront()
    const chrome = this.session.chromeTarget
    if (!chrome)
      throw new Error(
        'Firefox RDP did not expose the parent chrome target for extension sidebar activation'
      )
    const chromeEvaluation = new RdpEvaluation(this.session.rdp, chrome.console())
    let sidebarTargetId: string
    try {
      sidebarTargetId = await chromeEvaluation.evaluate<string>(`(async () => {
        const extensionId = ${JSON.stringify(this.id)}
        const baseUrl = ${JSON.stringify(baseUrl)}
        const controller = window.SidebarController
        if (!controller) throw new Error('Firefox SidebarController is unavailable')
        let entry
        for (let attempt = 0; attempt < 200 && !entry; attempt++) {
          if (controller._inited)
            entry = [...controller.sidebars.entries()].find(([, sidebar]) => sidebar.extensionId === extensionId)
          if (!entry) await new Promise(resolve => setTimeout(resolve, 25))
        }
        if (!entry) throw new Error('Firefox extension sidebar is not registered')
        const [commandId] = entry
        if (!(await controller.show(commandId)))
          throw new Error('Firefox could not activate the extension sidebar')
        let browser
        for (let attempt = 0; attempt < 600; attempt++) {
          browser = controller.browser.contentDocument?.getElementById('webext-panels-browser')
          if (browser?.currentURI?.spec.startsWith(baseUrl)) break
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        if (!browser?.browsingContext || !browser.currentURI.spec.startsWith(baseUrl))
          throw new Error('Firefox extension sidebar inner browser did not load')
        const { TargetRegistry } = ChromeUtils.importESModule('chrome://juggler/content/TargetRegistry.js')
        const registry = TargetRegistry.instance()
        if (!registry || typeof registry.registerExtensionSidebar !== 'function')
          throw new Error('Firefox Juggler sidebar target support is unavailable')
        const targetId = registry.registerExtensionSidebar(window, extensionId)
        if (!targetId) throw new Error('Firefox Juggler did not register the extension sidebar target')
        return targetId
      })()`)
    } finally {
      chromeEvaluation.dispose()
    }
    if (!sidebarTargetId)
      throw new Error('Firefox Juggler returned no target identity for the extension sidebar')
    const sidebarPage = await this.waitForExtensionPage(
      'extension-sidebar',
      15_000,
      page,
      sidebarTargetId,
      true
    )
    await sidebarPage.waitForLoadState('load')
    return sidebarPage
  }

  async waitForPopup(options: { timeout?: number } = {}): Promise<Page> {
    if (this.closed) throw new Error('Extension harness is closed')
    return this.waitForExtensionPage('extension-popup', options.timeout ?? 15_000)
  }

  async close(): Promise<void> {
    this.closed = true
    try {
      await this.diagnostics.close()
    } finally {
      this.background?.dispose()
      this.session.close()
    }
  }
}

export function bindFirefoxExtensionPage(extension: FirefoxExtension, page: Page): void {
  if (!(extension instanceof FirefoxExtensionHandle))
    throw new Error('Firefox extension is not a harness extension handle')
  extension.bindIsolatedPage(page)
}
