import { firefox, type BrowserContext, type Frame, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireRdpPort } from './port.js'
import { trackTempDir, removeTempDir, bounded } from './cleanup.js'
import { ensureFirefoxPatched, assertClosedShadowSelectorPatched } from './patch.js'
import { FirefoxRdpSession, RdpEvaluation, type InstalledExtension } from './rdp.js'
import { FirefoxErrorDiagnostics } from './diagnostics.js'
import { readExtensionManifest } from './extension-package.js'
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
  FirefoxExtensions,
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
function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function manifestGeckoId(manifest: Record<string, unknown>): string | undefined {
  const gecko =
    objectRecord(objectRecord(manifest.browser_specific_settings)?.gecko) ??
    objectRecord(objectRecord(manifest.applications)?.gecko)
  return typeof gecko?.id === 'string' && gecko.id ? gecko.id : undefined
}
export async function launchFirefoxExtension(
  config: FirefoxHarnessConfig
): Promise<FirefoxLaunchResult> {
  if (!Array.isArray(config.extensionPaths))
    throw new Error('extensionPaths must be an array of extension directories or XPI files')
  const extensionPaths = config.extensionPaths.map((path) => resolve(path))
  const localMappings = await resolveLocalMappings(config.localMappings)
  const releasePort = await acquireRdpPort()
  const userDataDir = trackTempDir(await mkdtemp(join(tmpdir(), 'firefox-addon-test-')))
  let context: BrowserContext | undefined
  let session: FirefoxRdpSession | undefined
  let extensions: FirefoxExtensionCollection | undefined
  let diagnostics: FirefoxErrorDiagnostics | undefined
  let localMode: FirefoxLocalModeController | undefined
  let nativeMessaging: NativeMessagingObserver | undefined
  let nativeManifestBaseDir: string | undefined
  try {
    nativeMessaging = new NativeMessagingObserver(config.nativeMessagingObservers)
    for (const hostName of Object.keys(config.nativeMessagingObservers ?? {})) {
      if (!config.nativeMessagingHosts?.[hostName]) {
        throw new Error(
          `nativeMessagingObservers['${hostName}'] requires a matching nativeMessagingHosts entry`
        )
      }
    }
    nativeManifestBaseDir = await prepareNativeMessagingHosts(
      userDataDir,
      config.nativeMessagingHosts
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
    const chromeTarget = session.chromeTarget
    if (nativeManifestBaseDir) {
      if (!chromeTarget)
        throw new Error('Firefox RDP did not expose the chrome target for native manifest setup')
      await configureNativeMessagingDirectory(session.rdp, chromeTarget, nativeManifestBaseDir)
    }
    if (nativeMessaging.enabled) {
      if (!chromeTarget) {
        throw new Error(
          'Firefox RDP did not expose a chrome target for native messaging observation'
        )
      }
      await nativeMessaging.start(session.rdp, chromeTarget)
    }
    extensions = new FirefoxExtensionCollection(session, context, diagnostics)
    for (const extensionPath of extensionPaths) await extensions.install(extensionPath)
    localMode = await attachFirefoxLocalMappings(context, session.rdp, localMappings)

    return {
      context,
      rdp: session.rdp,
      extensions,
      nativeMessaging,
      userDataDir,
      rdpPort: releasePort.port,
      close: async () => {
        try {
          await localMode?.close()
        } finally {
          try {
            await nativeMessaging?.close()
          } finally {
            try {
              await extensions?.dispose()
            } finally {
              try {
                await diagnostics?.close()
              } finally {
                session?.close()
                try {
                  await bounded(context?.close() ?? Promise.resolve(), 10_000, undefined)
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
    }
  } catch (error) {
    await localMode?.close().catch(() => undefined)
    await nativeMessaging?.close().catch(() => undefined)
    await extensions?.dispose().catch(() => undefined)
    await diagnostics?.close().catch(() => undefined)
    session?.close()
    await bounded(context?.close() ?? Promise.resolve(), 10_000, undefined).catch(() => undefined)
    await removeTempDir(userDataDir).finally(() => releasePort.release())
    throw error
  }
}

class FirefoxExtensionCollection implements FirefoxExtensions {
  private readonly handles = new Map<string, FirefoxExtensionHandle>()
  private installQueue = Promise.resolve()
  private isolatedPage?: Page

  constructor(
    private readonly session: FirefoxRdpSession,
    private readonly browserContext: BrowserContext,
    private readonly diagnostics: FirefoxErrorDiagnostics
  ) {}

  get size(): number {
    return this.handles.size
  }

  get(id: string): FirefoxExtension | undefined {
    return this.handles.get(id)
  }

  has(id: string): boolean {
    return this.handles.has(id)
  }

  entries(): MapIterator<[string, FirefoxExtension]> {
    return this.handles.entries()
  }

  keys(): MapIterator<string> {
    return this.handles.keys()
  }

  values(): MapIterator<FirefoxExtension> {
    return this.handles.values()
  }

  forEach(
    callbackfn: (
      value: FirefoxExtension,
      key: string,
      map: ReadonlyMap<string, FirefoxExtension>
    ) => void,
    thisArg?: unknown
  ): void {
    for (const [id, extension] of this.handles) callbackfn.call(thisArg, extension, id, this)
  }

  [Symbol.iterator](): MapIterator<[string, FirefoxExtension]> {
    return this.entries()
  }

  get [Symbol.toStringTag](): string {
    return 'FirefoxExtensions'
  }

  install(path: string): Promise<FirefoxExtension> {
    const run = this.installQueue.then(() => this.installOne(resolve(path)))
    this.installQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  bindIsolatedPage(page: Page): void {
    this.isolatedPage = page
    for (const extension of this.handles.values()) extension.bindIsolatedPage(page)
  }

  async dispose(): Promise<void> {
    await this.installQueue
    await Promise.all([...this.handles.values()].map((extension) => extension.disposeForHarness()))
    this.handles.clear()
    this.isolatedPage = undefined
  }

  private async installOne(path: string): Promise<FirefoxExtension> {
    const samePathHandle = [...this.handles.values()].find(
      (extension) => extension.installPath === path
    )
    if (samePathHandle) return samePathHandle.replaceFromPath(path)
    const declaredId = manifestGeckoId(await readExtensionManifest(path))
    const declaredHandle = declaredId ? this.handles.get(declaredId) : undefined
    if (declaredHandle) return declaredHandle.replaceFromPath(path)

    let registeredId: string | undefined
    let existingHandle: FirefoxExtensionHandle | undefined
    let installed: InstalledExtension
    try {
      installed = await this.session.installExtension(path, (extensionId) => {
        registeredId = extensionId
        this.diagnostics.addExtensionId(extensionId)
        existingHandle = this.handles.get(extensionId)
        return existingHandle !== undefined
      })
    } catch (error) {
      if (registeredId && !existingHandle) this.diagnostics.removeExtensionId(registeredId)
      throw error
    }
    const handle = existingHandle ?? this.handles.get(installed.id)
    if (handle) return handle.replaceInstalled(installed, path)
    const extension = new FirefoxExtensionHandle(
      this.session,
      this.browserContext,
      installed,
      path,
      () => {
        if (this.handles.get(installed.id) !== extension) return
        this.handles.delete(installed.id)
        this.diagnostics.removeExtensionId(installed.id)
      }
    )
    this.handles.set(installed.id, extension)
    this.diagnostics.addExtensionId(installed.id)
    if (this.isolatedPage) extension.bindIsolatedPage(this.isolatedPage)
    return extension
  }
}

class FirefoxExtensionHandle implements FirefoxExtension {
  readonly id: string
  installPath: string
  readonly isolatedContexts: RdpIsolatedNamespace
  private manifest: Record<string, unknown>
  private readonly onUninstalled: () => void
  private backgroundEvaluator?: RdpEvaluation
  private backgroundConsoleActor?: string
  private isolatedPage?: Page
  private extensionBaseUrl?: string
  private lifecycleQueue = Promise.resolve()
  private readonly pendingPageWaiters = new Set<() => void>()
  private readonly extensionPages = new Set<Page>()
  private state: 'enabled' | 'disabled' | 'uninstalled' = 'enabled'
  private disposed = false
  private lifecycleChanging = false

  constructor(
    private readonly session: FirefoxRdpSession,
    private readonly browserContext: BrowserContext,
    installed: InstalledExtension,
    installPath: string,
    onUninstalled: () => void
  ) {
    this.id = installed.id
    this.installPath = installPath
    this.manifest = installed.manifest
    this.backgroundEvaluator = installed.background
    const backgroundConsoleActor = installed.backgroundTarget?.form?.consoleActor
    this.backgroundConsoleActor =
      typeof backgroundConsoleActor === 'string' ? backgroundConsoleActor : undefined
    this.state = installed.enabled ? 'enabled' : 'disabled'
    this.onUninstalled = onUninstalled
    this.isolatedContexts = new RdpIsolatedNamespace(session, this.id)
  }
  get background(): RdpEvaluation | undefined {
    return this.backgroundEvaluator
  }

  get isolated(): FirefoxIsolatedPage {
    this.assertActive()
    if (!this.isolatedPage)
      throw new Error('Firefox extension isolated evaluation is not bound to a Playwright page')
    return this.isolatedContexts.get(this.isolatedPage)
  }

  bindIsolatedPage(page: Page): void {
    this.isolatedPage = page
  }

  private assertInstalled(): void {
    if (this.disposed) throw new Error('Firefox extension harness is closed')
    if (this.state === 'uninstalled') throw new Error('Firefox extension is uninstalled')
  }

  private assertActive(): void {
    this.assertInstalled()
    if (this.lifecycleChanging) throw new Error('Firefox extension lifecycle is changing')
    if (this.state !== 'enabled') throw new Error('Firefox extension is disabled')
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleQueue.then(async () => {
      this.lifecycleChanging = true
      try {
        return await operation()
      } finally {
        this.lifecycleChanging = false
      }
    })
    this.lifecycleQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
  replaceFromPath(path: string): Promise<FirefoxExtension> {
    return this.enqueueLifecycle(async () => {
      this.assertInstalled()
      await this.prepareLifecycleChange()
      const installed = await this.session.installExtension(path, undefined, true)
      if (installed.id !== this.id) {
        await this.session.uninstallAddon(installed.id).catch(() => undefined)
        throw new Error(`Firefox installed ${installed.id} while replacing extension ${this.id}`)
      }
      this.updateInstalled(installed, path)
      return this
    })
  }

  replaceInstalled(installed: InstalledExtension, path: string): Promise<FirefoxExtension> {
    return this.enqueueLifecycle(async () => {
      this.assertInstalled()
      await this.prepareLifecycleChange()
      if (installed.id !== this.id)
        throw new Error(`Cannot replace extension ${this.id} with ${installed.id}`)
      this.updateInstalled(installed, path)
      return this
    })
  }

  private updateInstalled(installed: InstalledExtension, path: string): void {
    this.installPath = path
    this.manifest = installed.manifest
    this.backgroundEvaluator = installed.background
    const consoleActor = installed.backgroundTarget?.form?.consoleActor
    this.backgroundConsoleActor = typeof consoleActor === 'string' ? consoleActor : undefined
    this.extensionBaseUrl = undefined
    this.state = installed.enabled ? 'enabled' : 'disabled'
  }

  private trackExtensionPage(page: Page): Page {
    this.extensionPages.add(page)
    page.once('close', () => this.extensionPages.delete(page))
    return page
  }

  private async getExtensionBaseUrl(): Promise<string> {
    this.assertInstalled()
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
    extensionBaseUrl: string,
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
    let cancelWait = () => {}
    const cleanup = () => {
      clearTimeout(timeoutId)
      clearInterval(pollId)
      this.browserContext.off('page', onPage)
      this.browserContext.off('close', onContextClose)
      for (const [page, listener] of pendingPages) page.off('framenavigated', listener)
      pendingPages.clear()
      this.pendingPageWaiters.delete(cancelWait)
    }
    cancelWait = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Firefox extension lifecycle changed while waiting for its page'))
    }
    this.pendingPageWaiters.add(cancelWait)
    const finish = (page: Page) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(this.trackExtensionPage(page))
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
        if (!page.url().startsWith(extensionBaseUrl)) return
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

  private async prepareLifecycleChange(): Promise<void> {
    let baseUrl = this.extensionBaseUrl
    if (!baseUrl && this.state === 'enabled')
      baseUrl = await this.getExtensionBaseUrl().catch(() => undefined)
    this.isolatedContexts.invalidate()
    this.backgroundEvaluator?.dispose()
    this.backgroundEvaluator = undefined
    for (const cancelWait of [...this.pendingPageWaiters]) cancelWait()
    const pages = new Set(this.extensionPages)
    if (baseUrl) {
      for (const page of this.browserContext.pages()) {
        if (page.url().startsWith(baseUrl)) pages.add(page)
      }
    }
    await Promise.all(
      [...pages].map((page) => (page.isClosed() ? Promise.resolve() : page.close().catch(() => {})))
    )
    this.extensionPages.clear()
  }

  private async refreshBackground(excludePrevious = true): Promise<void> {
    const background = await this.session.waitForExtensionBackground(
      this.id,
      this.manifest,
      excludePrevious ? this.backgroundConsoleActor : undefined
    )
    this.backgroundEvaluator = background?.evaluator
    const consoleActor = background?.target.form?.consoleActor
    this.backgroundConsoleActor = typeof consoleActor === 'string' ? consoleActor : undefined
  }

  reload(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      this.assertInstalled()
      const wasEnabled = this.state === 'enabled'
      const previousConsoleActor = this.backgroundConsoleActor
      await this.prepareLifecycleChange()
      const installed = await this.session.reloadExtension(
        this.id,
        this.installPath,
        wasEnabled,
        previousConsoleActor
      )
      this.updateInstalled(installed, this.installPath)
    })
  }

  enable(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      this.assertInstalled()
      if (this.state === 'enabled') return
      await this.prepareLifecycleChange()
      await this.session.setAddonEnabled(this.id, true, this.backgroundConsoleActor !== undefined)
      this.state = 'enabled'
      await this.session.refreshExtensionTargets(this.id)
      await this.refreshBackground()
    })
  }

  disable(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      this.assertInstalled()
      if (this.state === 'disabled') return
      const hasBackground = this.backgroundConsoleActor !== undefined
      await this.prepareLifecycleChange()
      try {
        await this.session.setAddonEnabled(this.id, false, hasBackground)
        this.state = 'disabled'
      } catch (error) {
        await this.refreshBackground(false).catch(() => undefined)
        throw error
      }
    })
  }

  uninstall(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      if (this.state === 'uninstalled') return
      this.assertInstalled()
      await this.prepareLifecycleChange()
      try {
        await this.session.uninstallAddon(this.id)
        this.state = 'uninstalled'
        this.onUninstalled()
      } catch (error) {
        if (this.state !== 'uninstalled') await this.refreshBackground(false).catch(() => undefined)
        throw error
      }
    })
  }

  async close(): Promise<void> {
    await this.uninstall()
  }

  async disposeForHarness(): Promise<void> {
    await this.lifecycleQueue
    if (this.disposed) return
    this.disposed = true
    this.isolatedContexts.invalidate()
    this.backgroundEvaluator?.dispose()
    this.backgroundEvaluator = undefined
    for (const cancelWait of [...this.pendingPageWaiters]) cancelWait()
  }

  private assertActionAvailable(): void {
    this.assertActive()
  }
  activateAction(page: Page, kind?: ActionKind): Promise<Page>
  activateAction(page: Page, kind: ActionKind, options: { waitForPopup: false }): Promise<void>
  async activateAction(
    page: Page,
    kind: ActionKind = 'browserAction',
    options: { waitForPopup?: boolean } = {}
  ): Promise<Page | void> {
    this.assertActionAvailable()
    const extensionBaseUrl = await this.getExtensionBaseUrl()
    const popup =
      options.waitForPopup === false
        ? undefined
        : this.waitForExtensionPage('extension-popup', 15_000, extensionBaseUrl)
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
    this.assertActionAvailable()
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
      baseUrl,
      page,
      sidebarTargetId,
      true
    )
    await sidebarPage.waitForLoadState('load')
    return sidebarPage
  }

  async waitForPopup(options: { timeout?: number } = {}): Promise<Page> {
    this.assertActionAvailable()
    const extensionBaseUrl = await this.getExtensionBaseUrl()
    return this.waitForExtensionPage('extension-popup', options.timeout ?? 15_000, extensionBaseUrl)
  }
}

export function bindFirefoxExtensionsPage(extensions: FirefoxExtensions, page: Page): void {
  if (!(extensions instanceof FirefoxExtensionCollection))
    throw new Error('Firefox extension collection is not a harness collection')
  extensions.bindIsolatedPage(page)
}
