import { TargetFront } from '@openpolyfill/firefox-rdp'
import { RdpEvaluation, FirefoxRdpSession, type PacketRecord } from './rdp.js'
import type { FirefoxPopup, EvaluateOptions } from './types.js'

function targetUrl(target: TargetFront): string {
  const url = target.form?.url
  return typeof url === 'string' ? url : ''
}

export class RdpPopup implements FirefoxPopup {
  readonly url: string
  private closed = false
  private readonly evaluation: RdpEvaluation

  constructor(
    private readonly session: FirefoxRdpSession,
    readonly target: TargetFront
  ) {
    this.url = targetUrl(target)
    this.evaluation = new RdpEvaluation(session.rdp, target.console())
    session.rdp.on('packet', (packet: unknown) => {
      const item = packet as PacketRecord
      if (item && item.type === 'target-destroyed-form') {
        const form = item.target as PacketRecord | undefined
        if (form?.actor === target.actorId || item.actor === target.actorId) this.closed = true
      }
    })
  }

  evaluate<R = unknown>(
    pageFunction: string | ((...args: unknown[]) => R | Promise<R>),
    ...args: unknown[]
  ): Promise<R> {
    return this.evaluation.evaluate<R>(
      pageFunction as string | ((...values: unknown[]) => unknown),
      args
    )
  }

  async waitForSelector(selector: string, options: EvaluateOptions = {}): Promise<void> {
    await this.evaluation.evaluate(`(async () => {
      const selector = ${JSON.stringify(selector)};
      const deadline = ${options.timeout ?? 30_000} === 0 ? Infinity : Date.now() + ${options.timeout ?? 30_000};
      while (!document.querySelector(selector)) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for selector: ' + selector);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return true;
    })()`)
  }

  async click(selector: string): Promise<void> {
    const escaped = JSON.stringify(selector)
    await this.evaluation.evaluate(`(() => {
      const element = document.querySelector(${escaped});
      if (!(element instanceof HTMLElement)) throw new Error('Popup element not found: ' + ${escaped});
      element.click();
      return true;
    })()`)
  }

  async waitForClose(options: EvaluateOptions = {}): Promise<void> {
    const timeout = options.timeout ?? 30_000
    const deadline = timeout === 0 ? Infinity : Date.now() + timeout
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for popup ${this.url} to close`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  isClosed(): boolean {
    return this.closed
  }
}
