import type { BrowserContext, Page } from '@playwright/test'
import type { FirefoxRDP } from '@openpolyfill/firefox-rdp'
import type { FirefoxErrorDiagnostics } from './diagnostics.js'
import type {
  NativeMessagingObserver,
  NativeMessagingObserverConfig
} from './native-messaging-observer.js'
export type ActionKind = 'browserAction' | 'pageAction'
export type UrlMatcher = string | RegExp

export interface FirefoxHarnessProjectOptions {
  headless?: boolean
  launchOptions?: Record<string, unknown>
}

export interface NativeMessagingHostConfig {
  /** Host executable path recorded in the manifest; the harness does not preflight it. */
  executable: string
  /** Firefox extension IDs allowed to connect to the host. */
  allowedExtensions: string[]
  description?: string
}

export interface FirefoxHarnessConfig {
  /** Initial extension directories or XPIs; use an empty array for runtime-only installs. */
  extensionPaths: string[]
  headless?: boolean
  firefoxUserPrefs?: Record<string, boolean | number | string>
  args?: string[]
  launchOptions?: Record<string, unknown>
  postInstallPages?: UrlMatcher[]
  /** Native messaging hosts isolated to this Firefox instance on Linux/macOS. */
  nativeMessagingHosts?: Record<string, NativeMessagingHostConfig>
  /** Per-host opt-in for observing and optionally blocking/mutating native stdio. */
  nativeMessagingObservers?: Record<string, NativeMessagingObserverConfig>
  /** Hostname-to-directory mappings served by Firefox 153+ DevTools Local Mode. */
  localMappings?: Record<string, string>
  patchFirefox?: boolean
  /** Context lifetime. The default is one Firefox context per test. */
  contextScope?: 'test' | 'worker'
  /**
   * Maps Playwright project settings to Firefox launch options.
   * Called once per context, within the selected fixture scope.
   */
  resolveProjectOptions?: (projectUse: Record<string, unknown>) => FirefoxHarnessProjectOptions
}

export interface FirefoxLaunchResult {
  context: BrowserContext
  rdp: FirefoxRDP
  extensions: FirefoxExtensions
  nativeMessaging: NativeMessagingObserver
  userDataDir: string
  rdpPort: number
  close: () => Promise<void>
}

export interface EvaluateOptions {
  timeout?: number
  polling?: number
}

export interface FirefoxBackground {
  evaluate<R = unknown>(
    pageFunction: string | ((...args: unknown[]) => R | Promise<R>),
    ...args: unknown[]
  ): Promise<R>
  waitForFunction<R = unknown>(
    pageFunction: string | ((...args: unknown[]) => R | Promise<R>),
    arg?: unknown,
    options?: EvaluateOptions
  ): Promise<R>
}

export interface FirefoxIsolatedPage {
  evaluate<R = unknown>(
    pageFunction: string | ((...args: unknown[]) => R | Promise<R>),
    ...args: unknown[]
  ): Promise<R>
  waitForFunction<R = unknown>(
    pageFunction: string | ((...args: unknown[]) => R | Promise<R>),
    arg?: unknown,
    options?: EvaluateOptions
  ): Promise<R>
}

export interface FirefoxIsolatedContexts {
  get(page: Page): FirefoxIsolatedPage
}

export type FirefoxIsolated = FirefoxIsolatedPage

export interface FirefoxExtension {
  readonly id: string
  readonly background?: FirefoxBackground
  readonly isolated: FirefoxIsolated
  readonly isolatedContexts: FirefoxIsolatedContexts
  /** Current directory or XPI source path; updated when the extension is replaced. */
  installPath: string
  activateAction(page: Page, kind?: ActionKind): Promise<Page>
  activateAction(page: Page, kind: ActionKind, options: { waitForPopup: false }): Promise<void>
  activateSidebar(page: Page): Promise<Page>
  waitForPopup(options?: { timeout?: number }): Promise<Page>
  /** Reload the extension while preserving this handle's identity. */
  reload(): Promise<void>
  /** Enable this extension and refresh its background context, if any. */
  enable(): Promise<void>
  /** Disable this extension and invalidate its background and UI contexts. */
  disable(): Promise<void>
  /** Uninstall this extension and remove it from the collection. */
  uninstall(): Promise<void>
  /** Alias for uninstalling this extension. */
  close(): Promise<void>
}

/** Read-only Map-like view of installed extensions, keyed by Gecko extension ID. */
export interface FirefoxExtensions extends ReadonlyMap<string, FirefoxExtension> {
  /** Install a directory or XPI into the running Firefox instance. */
  install(path: string): Promise<FirefoxExtension>
}

export interface InternalFirefoxContext extends BrowserContext {
  _firefoxHarnessDiagnostics?: FirefoxErrorDiagnostics
  _firefoxHarness?: {
    rdp: FirefoxRDP
    extensions: FirefoxExtensions
    nativeMessaging: NativeMessagingObserver
    userDataDir: string
  }
}
