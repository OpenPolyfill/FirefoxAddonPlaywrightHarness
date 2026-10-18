import JSZip from 'jszip'
import { ActorFront, FirefoxRDP, TargetFront, type RDPResponse } from '@openpolyfill/firefox-rdp'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type PacketRecord = Record<string, unknown>

function record(value: unknown): PacketRecord | undefined {
  return value && typeof value === 'object' ? (value as PacketRecord) : undefined
}

function stringField(value: unknown, field: string): string | undefined {
  const item = record(value)?.[field]
  return typeof item === 'string' ? item : undefined
}

function actorId(value: unknown): string {
  const direct = typeof value === 'string' ? value : undefined
  const nested = stringField(value, 'actor')
  if (direct ?? nested) return (direct ?? nested) as string
  throw new Error('RDP response did not contain an actor id')
}

async function resolveValue(rdp: FirefoxRDP, value: unknown): Promise<unknown> {
  const grip = record(value)
  if (!grip || grip.type !== 'longString') return value
  const longString = rdp.longString(grip as { actor: string; length: number; initial: string })
  return typeof longString === 'string' ? longString : longString.text()
}
export class RdpEvaluation {
  private queue = Promise.resolve()
  private readonly results = new Map<string, PacketRecord>()

  constructor(
    private readonly rdp: FirefoxRDP,
    private readonly consoleActor: ActorFront
  ) {
    this.rdp.on('packet', (packet: unknown) => {
      const item = record(packet)
      if (item?.type === 'evaluationResult' && typeof item.resultID === 'string')
        this.results.set(item.resultID, item)
    })
  }

  evaluate<R = unknown>(
    pageFunction: string | ((...args: unknown[]) => unknown),
    args: unknown[] = []
  ): Promise<R> {
    const run = this.queue.then(async () => {
      const body =
        typeof pageFunction === 'string'
          ? pageFunction
          : `(${pageFunction.toString()})(${args.map((arg) => JSON.stringify(arg) ?? 'undefined').join(',')})`
      const expression = `(async()=>{try{const __value__=await (${body});return JSON.stringify({__ok__:true,__value__:__value__})}catch(error){return JSON.stringify({__ok__:false,__error__:String(error&&error.message||error)})}})()`
      const response = await this.consoleActor.call('evaluateJSAsync', {
        text: expression,
        mapped: { await: true }
      })
      const resultId = stringField(response, 'resultID')
      if (!resultId) throw new Error('RDP evaluateJSAsync did not return a resultID')
      const event = await this.waitForEvaluationResult(resultId)
      if (event.hasException) {
        const message = await resolveValue(this.rdp, event.exceptionMessage)
        throw new Error(`Firefox evaluation failed: ${String(message)}`)
      }
      const raw = await resolveValue(this.rdp, event.result)
      if (typeof raw !== 'string')
        throw new Error('Firefox evaluation returned a non-serializable result')
      const parsed = record(JSON.parse(raw))
      if (!parsed?.__ok__)
        throw new Error(
          `Firefox evaluation failed: ${String(parsed?.__error__ ?? 'unknown error')}`
        )
      return parsed.__value__ as R
    })
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async waitForFunction<R = unknown>(
    pageFunction: string | ((...args: unknown[]) => unknown),
    arg?: unknown,
    options: { timeout?: number; polling?: number } = {}
  ): Promise<R> {
    const timeout = options.timeout ?? 30_000
    const deadline = timeout === 0 ? Infinity : Date.now() + timeout
    while (true) {
      const value = await this.evaluate<R>(pageFunction, arg === undefined ? [] : [arg])
      if (value) return value
      if (Date.now() > deadline)
        throw new Error('Timed out waiting for Firefox background function')
      await new Promise((resolve) => setTimeout(resolve, options.polling ?? 100))
    }
  }

  private waitForEvaluationResult(resultId: string): Promise<PacketRecord> {
    const existing = this.results.get(resultId)
    if (existing) {
      this.results.delete(resultId)
      return Promise.resolve(existing)
    }
    const { promise, resolve, reject } = Promise.withResolvers<PacketRecord>()
    const timer = setTimeout(() => {
      this.rdp.off('packet', onPacket)
      reject(new Error(`Timed out waiting for RDP evaluation result ${resultId}`))
    }, this.rdp.requestTimeoutMs)
    const onPacket = (packet: unknown) => {
      const item = record(packet)
      if (item?.type !== 'evaluationResult' || item.resultID !== resultId) return
      clearTimeout(timer)
      this.rdp.off('packet', onPacket)
      this.results.delete(resultId)
      resolve(item)
    }
    this.rdp.on('packet', onPacket)
    return promise
  }
}
export class RdpInspectedWindowEvaluation {
  private queue = Promise.resolve()

  constructor(
    private readonly rdp: FirefoxRDP,
    private readonly actorId: string,
    private readonly addonId: string
  ) {}

  evaluate<R = unknown>(
    pageUrl: string,
    pageFunction: string | ((...args: unknown[]) => unknown),
    args: unknown[] = []
  ): Promise<R> {
    const run = this.queue.then(async () => {
      const body =
        typeof pageFunction === 'string'
          ? pageFunction
          : `(${pageFunction.toString()})(${args.map((arg) => JSON.stringify(arg) ?? 'undefined').join(',')})`
      const token = `__firefoxHarnessEval_${Math.random().toString(36).slice(2)}`
      const tokenLiteral = JSON.stringify(token)
      const expression = `(()=>{try{const __value__=(${body});if(__value__&&typeof __value__.then==='function'){globalThis[${tokenLiteral}]={pending:true};Promise.resolve(__value__).then(value=>globalThis[${tokenLiteral}]={pending:false,ok:true,value},error=>globalThis[${tokenLiteral}]={pending:false,ok:false,error:String(error&&error.message||error)});return JSON.stringify({__pending__:true})}return JSON.stringify({__ok__:true,__value__:__value__})}catch(error){return JSON.stringify({__ok__:false,__error__:String(error&&error.message||error)})}})()`
      let parsed = record(JSON.parse(await this.evaluateSerialized(pageUrl, expression)))
      if (parsed?.__pending__) {
        const deadline = Date.now() + this.rdp.requestTimeoutMs
        while (Date.now() <= deadline) {
          const poll = `(()=>{const state=globalThis[${tokenLiteral}];if(!state||state.pending)return JSON.stringify({__pending__:true});delete globalThis[${tokenLiteral}];return state.ok?JSON.stringify({__ok__:true,__value__:state.value}):JSON.stringify({__ok__:false,__error__:state.error})})()`
          parsed = record(JSON.parse(await this.evaluateSerialized(pageUrl, poll)))
          if (!parsed?.__pending__) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      if (!parsed?.__ok__)
        throw new Error(
          `Firefox isolated evaluation failed: ${String(parsed?.__error__ ?? 'unknown error')}`
        )
      return parsed.__value__ as R
    })
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async evaluateSerialized(pageUrl: string, expression: string): Promise<string> {
    const actor = this.rdp.front(this.actorId, 'webExtensionInspectedWindow')
    const response = await actor.api.eval(
      { url: pageUrl, lineNumber: 1, addonId: this.addonId },
      expression,
      {}
    )
    const result = record(response)
    const exception = record(result?.exceptionInfo)
    if (exception)
      throw new Error(`Firefox isolated evaluation failed: ${JSON.stringify(exception)}`)
    const resolved = await resolveValue(this.rdp, result?.value)
    if (typeof resolved !== 'string')
      throw new Error(
        `Firefox isolated evaluation returned a non-serializable result: ${JSON.stringify(result)}`
      )
    return resolved
  }

  async waitForFunction<R = unknown>(
    getPageUrl: () => string,
    pageFunction: string | ((...args: unknown[]) => unknown),
    arg?: unknown,
    options: { timeout?: number; polling?: number } = {}
  ): Promise<R> {
    const timeout = options.timeout ?? 30_000
    const deadline = timeout === 0 ? Infinity : Date.now() + timeout
    while (true) {
      const value = await this.evaluate<R>(
        getPageUrl(),
        pageFunction,
        arg === undefined ? [] : [arg]
      )
      if (value) return value
      if (Date.now() > deadline) throw new Error('Timed out waiting for Firefox isolated function')
      await new Promise((resolve) => setTimeout(resolve, options.polling ?? 100))
    }
  }
}

export interface InstalledExtension {
  id: string
  addonActor: string
  background?: RdpEvaluation
  watcher: ActorFront
}

export class FirefoxRdpSession {
  readonly targets: TargetFront[] = []
  chromeTarget: TargetFront | undefined
  private readonly targetWaiters = new Set<(target: TargetFront) => void>()
  private constructor(
    readonly rdp: FirefoxRDP,
    readonly addonsActor: string
  ) {
    this.rdp.on('packet', (packet: unknown) => this.handlePacket(packet))
  }

  static async connect(port: number): Promise<FirefoxRdpSession> {
    const rdp = await FirefoxRDP.connect({ host: '127.0.0.1', port, requestTimeoutMs: 30_000 })
    try {
      const root = await rdp.root.getRoot()
      const session = new FirefoxRdpSession(rdp, actorId(root.addonsActor))
      const process = await rdp.root.getProcess(0)
      const processWatcherReply = await process.call('getWatcher')
      const processWatcher = rdp.actor(
        actorId(record(processWatcherReply)?.watcher ?? processWatcherReply)
      )
      session.attachWatcher(processWatcher)
      await processWatcher.call('watchTargets', { targetType: 'frame' })
      const reply = await process.call('getTarget')
      const form = record(reply)?.process ?? reply
      session.chromeTarget = session.targetFromForm(form)
      await session.watchChromeTargets()
      return session
    } catch (error) {
      rdp.close()
      throw error
    }
  }

  private async watchChromeTargets(): Promise<void> {
    const tabs = await this.rdp.root.listTabs()
    if (!tabs.length)
      throw new Error('Firefox RDP exposed no tab from which to observe chrome targets')
    let watched = 0
    for (const tab of tabs) {
      try {
        const watcher = await tab.getWatcher({ isPopupDebuggingEnabled: true })
        this.attachWatcher(watcher)
        await watcher.call('watchTargets', { targetType: 'frame' })
        watched++
      } catch {
        // A tab may disappear while the browser is starting; another tab can still expose chrome.
      }
    }
    if (!watched) throw new Error('Firefox RDP could not attach a watcher for chrome target events')
  }

  async installTemporaryAddon(path: string): Promise<{ id: string; actor: string }> {
    const response = await this.rdp
      .actor(this.addonsActor)
      .call('installTemporaryAddon', { addonPath: path })
    const addon = record(response)?.addon
    const id = stringField(addon, 'id')
    if (!id)
      throw new Error(
        `Temporary addon installation did not return an id: ${JSON.stringify(response)}`
      )
    const installed = (await this.listAddons()).find((item) => item.id === id)
    if (!installed) throw new Error(`Installed addon ${id} was not listed by Firefox`)
    return installed
  }

  async listAddons(): Promise<Array<{ id: string; actor: string; [key: string]: unknown }>> {
    const response = await this.rdp.root.listAddons()
    const addons = record(response)?.addons
    if (!Array.isArray(addons)) throw new Error('Firefox listAddons returned an invalid response')
    return addons.flatMap((item) => {
      const addon = record(item)
      const id = stringField(addon, 'id')
      const actor = stringField(addon, 'actor')
      return id && actor ? [{ ...addon, id, actor }] : []
    })
  }

  async installExtension(path: string): Promise<InstalledExtension> {
    const installed = await this.installTemporaryAddon(path)
    const addon = this.rdp.actor(installed.actor)
    const watcherReply = await addon.call('getWatcher')
    const watcherForm = record(watcherReply)?.watcher ?? watcherReply
    const watcher = this.rdp.actor(actorId(watcherForm))
    this.attachWatcher(watcher)
    await watcher.call('watchTargets', { targetType: 'frame' })
    await watcher.call('watchTargets', { targetType: 'worker' })
    const manifest = await readManifest(path)
    const backgroundTarget = hasBackground(manifest)
      ? await this.waitForTarget(
          (target) => isBackgroundTarget(target, manifest, installed.id),
          15_000
        )
      : undefined
    const targetConsole = backgroundTarget?.console()
    if (targetConsole)
      await targetConsole.call('startListeners', { listeners: ['evaluationResult'] })
    return {
      id: installed.id,
      addonActor: installed.actor,
      background: targetConsole ? new RdpEvaluation(this.rdp, targetConsole) : undefined,
      watcher
    }
  }

  async inspectedWindowEvaluation(
    addonId: string,
    browsingContextID: number
  ): Promise<RdpInspectedWindowEvaluation> {
    const tab = (await this.rdp.root.listTabs()).find(
      (candidate) => candidate.info.browsingContextID === browsingContextID
    )
    if (!tab)
      throw new Error(`Firefox tab for browsingContextID ${browsingContextID} was not found`)
    const target = await tab.getTarget()
    if (target.form?.browsingContextID !== browsingContextID)
      throw new Error('Firefox returned a target for the wrong browsing context')
    const actor = stringField(target.form, 'webExtensionInspectedWindowActor')
    if (!actor)
      throw new Error(
        `Firefox page target did not expose webExtensionInspectedWindowActor: ${JSON.stringify(target.form)}`
      )
    return new RdpInspectedWindowEvaluation(this.rdp, actor, addonId)
  }

  waitForTarget(
    predicate: (target: TargetFront) => boolean,
    timeoutMs = 10_000
  ): Promise<TargetFront> {
    const existing = this.targets.find(predicate)
    if (existing) return Promise.resolve(existing)
    const { promise, resolve, reject } = Promise.withResolvers<TargetFront>()
    const waiter = (target: TargetFront) => {
      if (!predicate(target)) return
      this.targetWaiters.delete(waiter)
      clearTimeout(timer)
      resolve(target)
    }
    const timer = setTimeout(() => {
      this.targetWaiters.delete(waiter)
      reject(new Error(`Timed out waiting for Firefox target after ${timeoutMs}ms`))
    }, timeoutMs)
    this.targetWaiters.add(waiter)
    return promise
  }

  close(): void {
    this.rdp.close()
  }

  private targetFromForm(value: unknown): TargetFront {
    const form = record(value)
    const actor = stringField(form, 'actor')
    if (!form || !actor) throw new Error('Firefox target form did not contain an actor id')
    const current = this.rdp.actor(actor)
    const target =
      current instanceof TargetFront
        ? ((current.form = form), current)
        : this.rdp.track(new TargetFront(this.rdp, actor, form))
    if (!this.targets.some((candidate) => candidate.actorId === actor)) this.targets.push(target)
    return target
  }

  private handlePacket(packet: unknown): void {
    const item = record(packet)
    if (!item || item.type !== 'target-available-form') return
    const form = record(item.target)
    const actor = stringField(form, 'actor')
    if (!form || !actor) return
    const current = this.rdp.actor(actor)
    const target =
      current instanceof TargetFront
        ? ((current.form = form), current)
        : this.rdp.track(new TargetFront(this.rdp, actor, form))
    if (!this.targets.some((candidate) => candidate.actorId === actor)) this.targets.push(target)
    for (const waiter of [...this.targetWaiters]) waiter(target)
  }
  private attachWatcher(watcher: ActorFront): void {
    watcher.registerEvents('target-available-form', 'target-destroyed-form')
    watcher.on('target-available-form', (packet: RDPResponse) => this.handlePacket(packet))
  }
}

async function readManifest(path: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(join(path, 'manifest.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error
    const archive = await JSZip.loadAsync(await readFile(path))
    const manifest = archive.file('manifest.json')
    if (!manifest) throw new Error(`Packed extension ${path} has no manifest.json`)
    raw = await manifest.async('string')
  }
  const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''))
  const manifest = record(parsed)
  if (!manifest) throw new Error('Extension manifest must be a JSON object')
  return manifest
}

function isBackgroundTarget(
  target: TargetFront,
  manifest: Record<string, unknown>,
  addonId: string
): boolean {
  const url = stringField(target.form, 'url') ?? ''
  const consoleActor = stringField(target.form, 'consoleActor')
  if (!consoleActor || stringField(target.form, 'addonId') !== addonId) return false
  if (url.includes('_generated_background_page')) return true
  const page = stringField(record(manifest.background), 'page')?.replace(/^\.\//, '')
  return page ? new URL(url).pathname.endsWith(`/${page}`) : false
}

function hasBackground(manifest: Record<string, unknown>): boolean {
  const background = record(manifest.background)
  return !!(
    stringField(background, 'page') ||
    stringField(background, 'service_worker') ||
    (Array.isArray(background?.scripts) && background.scripts.length > 0)
  )
}
