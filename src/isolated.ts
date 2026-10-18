import type { Page } from '@playwright/test'
import type { FirefoxIsolatedContexts, FirefoxIsolatedPage, EvaluateOptions } from './types.js'
import { FirefoxRdpSession } from './rdp.js'

export class RdpIsolatedNamespace implements FirefoxIsolatedContexts {
  constructor(
    private readonly session: FirefoxRdpSession,
    private readonly addonId: string
  ) {}

  private queue = Promise.resolve()

  get(page: Page): FirefoxIsolatedPage {
    return new RdpIsolatedPage(page, this)
  }

  evaluate<R>(
    page: Page,
    pageFunction: string | ((...args: unknown[]) => R | Promise<R>),
    args: unknown[]
  ): Promise<R> {
    const run = this.queue.then(async () => {
      await page.bringToFront()
      const tab = (await this.session.rdp.root.listTabs()).find((candidate) => candidate.selected)
      const browsingContextID = tab?.info.browsingContextID
      if (typeof browsingContextID !== 'number')
        throw new Error('Selected Firefox tab did not expose a browsingContextID')
      const pageUrl = page.url()
      const evaluation = await this.session.inspectedWindowEvaluation(
        this.addonId,
        browsingContextID
      )
      return evaluation.evaluate<R>(pageUrl, pageFunction, args)
    })
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
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
    return this.namespace.evaluate(this.page, pageFunction, args)
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
