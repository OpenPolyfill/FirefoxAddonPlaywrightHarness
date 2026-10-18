import { firefox, type BrowserContext, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireRdpPort } from './port.js'
import { trackTempDir, removeTempDir, bounded } from './cleanup.js'
import { ensureFirefoxPatched } from './patch.js'
import { FirefoxRdpSession, RdpEvaluation } from './rdp.js'
import { RdpIsolatedNamespace } from './isolated.js'
import { RdpPopup } from './popup.js'
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
    context = await firefox.launchPersistentContext(
      userDataDir,
      launchOptions(config, releasePort.port)
    )
    session = await FirefoxRdpSession.connect(releasePort.port)
    const installed = await session.installExtension(extensionPath)
    extension = new FirefoxExtensionHandle(
      session,
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
  private isolatedPage?: FirefoxIsolatedPage
  private closed = false
  constructor(
    private readonly session: FirefoxRdpSession,
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
    return this.isolatedPage
  }

  bindIsolatedPage(page: Page): void {
    this.isolatedPage = this.isolatedContexts.get(page)
  }

  async activateAction(page: Page, kind: ActionKind = 'browserAction'): Promise<RdpPopup> {
    if (this.closed) throw new Error('Extension harness is closed')
    await page.bringToFront()
    const popupTarget = this.session.waitForTarget((target) => {
      const url = typeof target.form?.url === 'string' ? target.form.url : ''
      return (
        target.form?.addonId === this.id &&
        url.startsWith('moz-extension://') &&
        !url.includes('_generated_background_page')
      )
    }, 15_000)
    popupTarget.catch(() => undefined)
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
    return new RdpPopup(this.session, await popupTarget)
  }

  waitForPopup(options: { timeout?: number } = {}): Promise<RdpPopup> {
    const target = this.session.waitForTarget((candidate) => {
      const url = typeof candidate.form?.url === 'string' ? candidate.form.url : ''
      return (
        candidate.form?.addonId === this.id &&
        url.startsWith('moz-extension://') &&
        !url.includes('_generated_background_page')
      )
    }, options.timeout ?? 15_000)
    return target.then((value) => new RdpPopup(this.session, value))
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
