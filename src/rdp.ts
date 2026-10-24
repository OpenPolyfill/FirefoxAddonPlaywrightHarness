import { ActorFront, FirefoxRDP, TargetFront } from '@openpolyfill/firefox-rdp'
import { readExtensionManifest } from './extension-package.js'

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
  private readonly pending = new Map<
    string,
    { resolve: (packet: PacketRecord) => void; reject: (error: Error) => void }
  >()
  private readonly shutdown = Promise.withResolvers<never>()
  private disposed = false
  private evaluating = false
  private readonly onPacket = (packet: unknown) => {
    const item = record(packet)
    if (
      !this.evaluating ||
      item?.from !== this.consoleActor.actorId ||
      item.type !== 'evaluationResult' ||
      typeof item.resultID !== 'string'
    )
      return
    const waiter = this.pending.get(item.resultID)
    if (waiter) waiter.resolve(item)
    else this.results.set(item.resultID, item)
  }
  private readonly onClose = () => this.dispose()

  constructor(
    private readonly rdp: FirefoxRDP,
    private readonly consoleActor: ActorFront
  ) {
    this.shutdown.promise.catch(() => undefined)
    this.rdp.on('packet', this.onPacket)
    this.rdp.on('close', this.onClose)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.rdp.off('packet', this.onPacket)
    this.rdp.off('close', this.onClose)
    this.results.clear()
    const error = new Error('Firefox RDP evaluator is disposed')
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.shutdown.reject(error)
  }

  evaluate<R = unknown>(
    pageFunction: string | ((...args: unknown[]) => unknown),
    args: unknown[] = []
  ): Promise<R> {
    const run = this.queue.then(async () => {
      if (this.disposed) throw new Error('Firefox RDP evaluator is disposed')
      this.evaluating = true
      try {
        const body =
          typeof pageFunction === 'string'
            ? pageFunction
            : `(${pageFunction.toString()})(${args.map((arg) => JSON.stringify(arg) ?? 'undefined').join(',')})`
        const expression = `(async()=>{try{const __value__=await (${body});return JSON.stringify({__ok__:true,__value__:__value__})}catch(error){return JSON.stringify({__ok__:false,__error__:String(error&&error.message||error)})}})()`
        const response = await Promise.race([
          this.consoleActor.call('evaluateJSAsync', { text: expression, mapped: { await: true } }),
          this.shutdown.promise
        ])
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
      } finally {
        this.evaluating = false
        this.results.clear()
      }
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

  private async waitForEvaluationResult(resultId: string): Promise<PacketRecord> {
    if (this.disposed) throw new Error('Firefox RDP evaluator is disposed')
    const existing = this.results.get(resultId)
    if (existing) {
      this.results.delete(resultId)
      return existing
    }
    const { promise, resolve, reject } = Promise.withResolvers<PacketRecord>()
    this.pending.set(resultId, { resolve, reject })
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for RDP evaluation result ${resultId}`))
    }, this.rdp.requestTimeoutMs)
    try {
      return await promise
    } finally {
      clearTimeout(timer)
      this.pending.delete(resultId)
    }
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
  manifest: Record<string, unknown>
  enabled: boolean
  backgroundTarget?: TargetFront
  background?: RdpEvaluation
  watcher: ActorFront
}

export class FirefoxRdpSession {
  readonly targets: TargetFront[] = []
  chromeTarget: TargetFront | undefined
  private readonly targetWaiters = new Map<(target: TargetFront) => void, () => void>()
  private readonly addonActors = new Map<string, string>()
  private closed = false
  private readonly onPacket = (packet: unknown) => this.handlePacket(packet)
  private readonly onClose = () => this.dispose()
  private constructor(
    readonly rdp: FirefoxRDP,
    readonly addonsActor: string
  ) {
    this.rdp.on('packet', this.onPacket)
    this.rdp.on('close', this.onClose)
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
  private async watchAddonActor(extensionId: string, addonActorId: string): Promise<ActorFront> {
    const addon = this.rdp.actor(addonActorId)
    const watcherReply = await addon.call('getWatcher')
    const watcherForm = record(watcherReply)?.watcher ?? watcherReply
    const watcher = this.rdp.actor(actorId(watcherForm))
    this.attachWatcher(watcher)
    await watcher.call('watchTargets', { targetType: 'frame' })
    await watcher.call('watchTargets', { targetType: 'worker' })
    this.addonActors.set(extensionId, addonActorId)
    return watcher
  }

  async installExtension(
    path: string,
    onInstalled?: (extensionId: string) => boolean | void,
    preserveExistingOnFailure = false
  ): Promise<InstalledExtension> {
    const manifest = await readExtensionManifest(path)
    const installed = await this.installTemporaryAddon(path)
    let preserveExisting = preserveExistingOnFailure
    try {
      preserveExisting = onInstalled?.(installed.id) === true || preserveExisting
      const enabled = await this.isAddonEnabled(installed.id)
      const watcher = await this.watchAddonActor(installed.id, installed.actor)
      const background = enabled
        ? await this.waitForExtensionBackground(installed.id, manifest)
        : undefined
      return {
        id: installed.id,
        addonActor: installed.actor,
        manifest,
        enabled,
        backgroundTarget: background?.target,
        background: background?.evaluator,
        watcher
      }
    } catch (error) {
      if (!preserveExisting) await this.uninstallAddon(installed.id).catch(() => undefined)
      throw error
    }
  }

  private async evaluateChrome<R = unknown>(expression: string): Promise<R> {
    const chrome = this.chromeTarget
    if (!chrome) throw new Error('Firefox RDP did not expose the parent chrome target')
    const evaluation = new RdpEvaluation(this.rdp, chrome.console())
    try {
      return await evaluation.evaluate<R>(expression)
    } finally {
      evaluation.dispose()
    }
  }

  async setAddonEnabled(addonId: string, enabled: boolean, hasBackground = false): Promise<void> {
    const method = enabled ? 'enable' : 'disable'
    await this.evaluateChrome(`(async () => {
      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs')
      const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs')
      const id = ${JSON.stringify(addonId)}
      const previousBackground = ExtensionParent.GlobalManager.extensionMap.get(id)?.backgroundContext
      const previousInnerWindowId = previousBackground?.innerWindowID
      const previousBrowsingContextId = previousBackground?.browsingContext?.id
      const addon = await AddonManager.getAddonByID(id)
      if (!addon) throw new Error('Firefox add-on is not registered: ' + id)
      await addon.${method}()
      if (addon.isActive !== ${JSON.stringify(enabled)})
        throw new Error('Firefox add-on state did not become ${enabled ? 'enabled' : 'disabled'}')
      if (${JSON.stringify(enabled && hasBackground)}) {
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
          const currentBackground = ExtensionParent.GlobalManager.extensionMap.get(id)?.backgroundContext
          if (
            currentBackground &&
            (currentBackground !== previousBackground ||
              currentBackground.innerWindowID !== previousInnerWindowId ||
              currentBackground.browsingContext?.id !== previousBrowsingContextId)
          ) return
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        throw new Error('Timed out waiting for the Firefox extension background context to enable')
      }
      if (${JSON.stringify(!enabled && hasBackground)} && previousBackground) {
        const deadline = Date.now() + 15_000
        while (Date.now() < deadline) {
          const currentBackground = ExtensionParent.GlobalManager.extensionMap.get(id)?.backgroundContext
          if (!currentBackground || currentBackground !== previousBackground || previousBackground.unloaded)
            return
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        throw new Error('Timed out waiting for the Firefox extension background context to stop')
      }
    })()`)
  }
  async isAddonEnabled(addonId: string): Promise<boolean> {
    return this.evaluateChrome<boolean>(`(async () => {
      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs')
      const addon = await AddonManager.getAddonByID(${JSON.stringify(addonId)})
      return addon?.isActive === true
    })()`)
  }

  async reloadExtension(
    addonId: string,
    path: string,
    wasEnabled: boolean,
    previousConsoleActor?: string
  ): Promise<InstalledExtension> {
    const addon = (await this.listAddons()).find((candidate) => candidate.id === addonId)
    if (!addon) throw new Error(`Firefox extension ${addonId} is not installed`)
    await this.rdp.front(addon.actor, 'webExtensionDescriptor').api.reload()
    const manifest = await readExtensionManifest(path)
    const hasBackgroundPage = hasBackground(manifest)
    let enabled = await this.isAddonEnabled(addonId)
    if (enabled !== wasEnabled) {
      await this.setAddonEnabled(addonId, wasEnabled, hasBackgroundPage)
      enabled = await this.isAddonEnabled(addonId)
    }
    if (enabled !== wasEnabled)
      throw new Error(
        `Firefox extension ${addonId} did not preserve its enabled state during reload`
      )
    const refreshedAddon = (await this.listAddons()).find((candidate) => candidate.id === addonId)
    if (!refreshedAddon) throw new Error(`Firefox extension ${addonId} disappeared during reload`)
    const watcher = await this.watchAddonActor(addonId, refreshedAddon.actor)
    const background =
      enabled && hasBackgroundPage
        ? await this.waitForExtensionBackground(addonId, manifest, previousConsoleActor)
        : undefined
    return {
      id: addonId,
      addonActor: refreshedAddon.actor,
      manifest,
      enabled,
      backgroundTarget: background?.target,
      background: background?.evaluator,
      watcher
    }
  }

  async uninstallAddon(addonId: string): Promise<void> {
    await this.rdp.actor(this.addonsActor).call('uninstallAddon', { addonId })
    const deadline = Date.now() + 15_000
    while ((await this.listAddons()).some((addon) => addon.id === addonId)) {
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for Firefox to uninstall extension ${addonId}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    this.addonActors.delete(addonId)
  }

  async refreshExtensionTargets(addonId: string, force = false): Promise<void> {
    const installed = (await this.listAddons()).find((addon) => addon.id === addonId)
    if (!installed) throw new Error(`Firefox extension ${addonId} is not installed`)
    if (!force && this.addonActors.get(addonId) === installed.actor) return
    await this.watchAddonActor(addonId, installed.actor)
  }
  private async backgroundBrowsingContextId(addonId: string): Promise<number | undefined> {
    const browsingContextId = await this.evaluateChrome<number | null>(`(() => {
      const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs')
      const extension = ExtensionParent.GlobalManager.extensionMap.get(${JSON.stringify(addonId)})
      return extension?.backgroundContext?.browsingContext?.id ?? null
    })()`)
    return typeof browsingContextId === 'number' ? browsingContextId : undefined
  }

  async waitForExtensionBackground(
    addonId: string,
    manifest: Record<string, unknown>,
    excludedConsoleActor?: string
  ): Promise<{ target: TargetFront; evaluator: RdpEvaluation } | undefined> {
    if (!hasBackground(manifest)) return undefined
    const browsingContextId = await this.backgroundBrowsingContextId(addonId)
    const target = await this.waitForTarget(
      (candidate) =>
        isBackgroundTarget(candidate, manifest, addonId) &&
        stringField(candidate.form, 'consoleActor') !== excludedConsoleActor &&
        (browsingContextId === undefined ||
          candidate.form?.browsingContextID === browsingContextId),
      15_000
    )
    const targetConsole = target.console()
    await targetConsole.call('startListeners', { listeners: ['evaluationResult'] })
    return { target, evaluator: new RdpEvaluation(this.rdp, targetConsole) }
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
    if (this.closed) return Promise.reject(new Error('Firefox RDP session is closed'))
    const existing = this.targets.find(predicate)
    if (existing) return Promise.resolve(existing)
    const { promise, resolve, reject } = Promise.withResolvers<TargetFront>()
    const cleanup = () => {
      this.targetWaiters.delete(waiter)
      clearTimeout(timer)
    }
    const waiter = (target: TargetFront) => {
      try {
        if (!predicate(target)) return
        cleanup()
        resolve(target)
      } catch (error) {
        cleanup()
        reject(error)
      }
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for Firefox target after ${timeoutMs}ms`))
    }, timeoutMs)
    this.targetWaiters.set(waiter, () => {
      cleanup()
      reject(new Error('Firefox RDP session is closed'))
    })
    return promise
  }

  close(): void {
    this.dispose()
    this.rdp.close()
  }

  private dispose(): void {
    if (this.closed) return
    this.closed = true
    this.rdp.off('packet', this.onPacket)
    this.rdp.off('close', this.onClose)
    for (const cancel of [...this.targetWaiters.values()]) cancel()
    this.targets.length = 0
    this.chromeTarget = undefined
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
    const actor = stringField(item?.target, 'actor')
    if (!item || !actor) return
    if (item.type === 'target-destroyed-form') {
      this.removeTarget(actor)
    } else if (item.type === 'target-available-form') {
      const target = this.targetFromForm(item.target)
      for (const waiter of [...this.targetWaiters.keys()]) waiter(target)
    }
  }
  private removeTarget(actorId: string): void {
    const index = this.targets.findIndex((target) => target.actorId === actorId)
    if (index !== -1) this.targets.splice(index, 1)
    if (this.chromeTarget?.actorId === actorId) this.chromeTarget = undefined
  }

  private attachWatcher(watcher: ActorFront): void {
    watcher.registerEvents('target-available-form', 'target-destroyed-form')
  }
}
const isolatedEvaluationQueues = new WeakMap<FirefoxRdpSession, Promise<void>>()

export function serializeIsolatedEvaluation<T>(
  session: FirefoxRdpSession,
  operation: () => Promise<T>
): Promise<T> {
  const queue = isolatedEvaluationQueues.get(session) ?? Promise.resolve()
  const run = queue.then(operation)
  isolatedEvaluationQueues.set(
    session,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
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
  const background = record(manifest.background)
  const files = [
    stringField(background, 'page'),
    stringField(background, 'service_worker'),
    ...(Array.isArray(background?.scripts)
      ? background.scripts.filter((file): file is string => typeof file === 'string')
      : [])
  ]
    .filter((file): file is string => !!file)
    .map((file) => file.replace(/^\.\//, ''))
  if (!files.length) return false
  try {
    const pathname = new URL(url).pathname
    return files.some((file) => pathname.endsWith(`/${file}`))
  } catch {
    return false
  }
}

function hasBackground(manifest: Record<string, unknown>): boolean {
  const background = record(manifest.background)
  return !!(
    stringField(background, 'page') ||
    stringField(background, 'service_worker') ||
    (Array.isArray(background?.scripts) && background.scripts.length > 0)
  )
}
