import type { Page } from '@playwright/test'
import type { FirefoxIsolatedContexts, FirefoxIsolatedPage, EvaluateOptions } from './types.js'
import { FirefoxRdpSession } from './rdp.js'

export class RdpIsolatedNamespace implements FirefoxIsolatedContexts {
  constructor(
    private readonly session: FirefoxRdpSession,
    private readonly addonId: string
  ) {}

  get(page: Page): FirefoxIsolatedPage {
    return new RdpIsolatedPage(page, this)
  }

  async evaluate<R>(
    pageUrl: string,
    pageFunction: string | ((...args: unknown[]) => R | Promise<R>),
    args: unknown[]
  ): Promise<R> {
    const evaluation = await this.session.inspectedWindowEvaluation(this.addonId, pageUrl)
    return evaluation.evaluate(pageUrl, pageFunction, args)
  }
}

class RdpIsolatedPage implements FirefoxIsolatedPage {
  constructor(
    private readonly page: Page,
    private readonly namespace: RdpIsolatedNamespace
  ) {}

  evaluate<R = unknown>(
    pageFunction: string | ((...args: unknown[]) => R | Promise<R>),
    ...args: unknown[]
  ): Promise<R> {
    return this.namespace.evaluate(this.page.url(), pageFunction, args)
  }

  async waitForFunction<R = unknown>(
    pageFunction: string | ((...args: unknown[]) => R | Promise<R>),
    arg?: unknown,
    options: EvaluateOptions = {}
  ): Promise<R> {
    const timeout = options.timeout ?? 30_000
    const deadline = timeout === 0 ? Infinity : Date.now() + timeout
    while (true) {
      const value = await this.evaluate(pageFunction, ...(arg === undefined ? [] : [arg]))
      if (value) return value
      if (Date.now() > deadline) throw new Error('Timed out waiting for Firefox isolated function')
      await new Promise((resolve) => setTimeout(resolve, options.polling ?? 100))
    }
  }
}
