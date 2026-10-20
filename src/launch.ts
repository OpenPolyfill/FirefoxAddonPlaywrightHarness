import { firefox, type BrowserContext, type Frame, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireRdpPort } from './port.js'
import { trackTempDir, removeTempDir, bounded } from './cleanup.js'
import { ensureFirefoxPatched, assertClosedShadowSelectorPatched } from './patch.js'
import { FirefoxRdpSession, RdpEvaluation } from './rdp.js'
import { RdpIsolatedNamespace } from './isolated.js'

import type {
  FirefoxExtension,
  FirefoxHarnessConfig,
  FirefoxIsolatedPage,
  FirefoxLaunchResult,
  ActionKind
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
  const releasePort = await acquireRdpPort()
  const userDataDir = trackTempDir(await mkdtemp(join(tmpdir(), 'firefox-addon-test-')))
  let context: BrowserContext | undefined
  let session: FirefoxRdpSession | undefined
  let extension: FirefoxExtension | undefined
  try {
    if (config.patchFirefox !== false) await ensureFirefoxPatched()
    await assertClosedShadowSelectorPatched()
    context = await firefox.launchPersistentContext(
      userDataDir,
      launchOptions(config, releasePort.port)
    )
    session = await FirefoxRdpSession.connect(releasePort.port)
    const installed = await session.installExtension(extensionPath)
    extension = new FirefoxExtensionHandle(
      session,
      context,
      installed.id,
      extensionPath,
      installed.background
    )
    const result: FirefoxLaunchResult = {
      context,
      rdp: session.rdp,
      extension,
      userDataDir,
      rdpPort: releasePort.port,
      close: async () => {
        await extension?.close()
        await bounded(context?.close() ?? Promise.resolve(), 10_000, undefined)
        await removeTempDir(userDataDir)
        await releasePort.release()
      }
    }
    return result
  } catch (error) {
    session?.close()
    await bounded(context?.close() ?? Promise.resolve(), 10_000, undefined)
    await removeTempDir(userDataDir)
    await releasePort.release()
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
    background: RdpEvaluation | undefined
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
  }
  private async waitForPopupPage(baseUrl: string, timeout: number): Promise<Page> {
    return new Promise((resolve, reject) => {
      const pendingPages = new Map<Page, (frame: Frame) => void>()
      let settled = false
      const timeoutId =
        timeout > 0
          ? setTimeout(() => {
              settled = true
              cleanup()
              reject(new Error(`Timeout ${timeout}ms exceeded while waiting for popup page`))
            }, timeout)
          : undefined
      const cleanup = () => {
        clearTimeout(timeoutId)
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
        reject(new Error('Browser context closed while waiting for popup page'))
      }
      const onPage = (page: Page) => {
        if (page.url().startsWith(baseUrl)) {
          finish(page)
          return
        }
        const onFrameNavigated = (frame: Frame) => {
          if (frame === page.mainFrame() && frame.url().startsWith(baseUrl)) finish(page)
        }
        pendingPages.set(page, onFrameNavigated)
        page.on('framenavigated', onFrameNavigated)
        if (page.url().startsWith(baseUrl)) finish(page)
      }
      this.browserContext.on('page', onPage)
      this.browserContext.on('close', onContextClose)
    })
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
        : this.waitForPopupPage(await this.getExtensionBaseUrl(), 15_000)
    popup?.catch(() => undefined)
    await page.bringToFront()
    const chrome = this.session.chromeTarget
    if (!chrome)
      throw new Error(
        'Firefox RDP did not expose the parent chrome target for extension action activation'
      )
    const chromeEvaluation = new RdpEvaluation(this.session.rdp, chrome.console())
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
    if (popup) return popup
  }

  async waitForPopup(options: { timeout?: number } = {}): Promise<Page> {
    if (this.closed) throw new Error('Extension harness is closed')
    const baseUrl = await this.getExtensionBaseUrl()
    return this.waitForPopupPage(baseUrl, options.timeout ?? 15_000)
  }

  async close(): Promise<void> {
    this.closed = true
    this.session.close()
  }
}

export function bindFirefoxExtensionPage(extension: FirefoxExtension, page: Page): void {
  if (!(extension instanceof FirefoxExtensionHandle))
    throw new Error('Firefox extension is not a harness extension handle')
  extension.bindIsolatedPage(page)
}
