import type { BrowserContext, Page } from '@playwright/test'
import type { FirefoxRDP } from '@openpolyfill/firefox-rdp'

export type ActionKind = 'browserAction' | 'pageAction'
export type UrlMatcher = string | RegExp

export interface FirefoxHarnessConfig {
  extensionPath: string
  headless?: boolean
  firefoxUserPrefs?: Record<string, boolean | number | string>
  args?: string[]
  launchOptions?: Record<string, unknown>
  postInstallPages?: UrlMatcher[]
  patchFirefox?: boolean
}

export interface FirefoxLaunchResult {
  context: BrowserContext
  rdp: FirefoxRDP
  extension: FirefoxExtension
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
  installPath: string
  activateAction(page: Page, kind?: ActionKind): Promise<Page>
  waitForPopup(options?: { timeout?: number }): Promise<Page>
  close(): Promise<void>
}

export interface InternalFirefoxContext extends BrowserContext {
  _firefoxHarness?: {
    rdp: FirefoxRDP
    extension: FirefoxExtension
    userDataDir: string
  }
}
