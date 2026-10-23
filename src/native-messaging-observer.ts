import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { FirefoxRDP, TargetFront } from '@openpolyfill/firefox-rdp'
import { RdpEvaluation } from './rdp.js'

export type NativeMessagingDirection = 'stdin' | 'stdout'
export type NativeMessagingChannel = NativeMessagingDirection | 'stderr'
export type NativeMessagingObserverMode = 'non-blocking' | 'blocking'
export type NativeMessagingProcessState = 'starting' | 'running' | 'exited'

export interface NativeMessagingMessage {
  direction: NativeMessagingDirection
  message: unknown
  /** The complete length-prefixed frame observed inside Firefox before optional mutation. */
  raw: Buffer
}

export interface NativeMessagingExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface NativeMessagingWaitOptions {
  timeout?: number
}

export interface NativeMessagingMessageWaitOptions extends NativeMessagingWaitOptions {
  direction?: NativeMessagingDirection
}

export interface NativeMessagingSessionWaitOptions extends NativeMessagingWaitOptions {
  /** Skip this many sessions already present when waiting for a later process. */
  after?: number
}

export interface NativeMessagingStreamEvent {
  hostName: string
  pid: number
  channel: NativeMessagingChannel
  /** Raw bytes observed by Firefox before any blocking-mode mutation. */
  bytes: Buffer
  session: NativeMessagingSession
}

export type NativeMessagingMutation = Uint8Array | void

export interface NativeMessagingObserverConfig {
  mode: NativeMessagingObserverMode
  /** Return replacement framed bytes (or stderr bytes) in blocking mode. */
  onData?: (
    event: NativeMessagingStreamEvent
  ) => NativeMessagingMutation | Promise<NativeMessagingMutation>
}

interface MessageWaiter {
  direction?: NativeMessagingDirection
  resolve: (message: NativeMessagingMessage) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

interface SessionWaiter {
  hostName?: string
  resolve: (session: NativeMessagingSession) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

interface BrowserStartEvent {
  type: 'start'
  sessionId: number
  hostName: string
  pid: number
}

interface BrowserDataEvent {
  type: 'data'
  eventId: number
  sessionId: number
  hostName: string
  pid: number
  channel: NativeMessagingChannel
  bytes: string
}

interface BrowserExitEvent {
  type: 'exit'
  sessionId: number
  hostName: string
  pid: number
  code: number | null
}

type BrowserObserverEvent = BrowserStartEvent | BrowserDataEvent | BrowserExitEvent

const maxRetainedMessages = 256
const maxRetainedMessageBytes = 4 * 1024 * 1024
const nativeMessagingModule = 'resource://gre/modules/NativeMessaging.sys.mjs'
const browserObserverProperty = '__openpolyfillHarnessNativeMessagingObserver'

function makeReadable(): Readable {
  return new Readable({ read() {} })
}

function timeoutError(description: string, timeout: number): Error {
  return new Error(`Timed out after ${timeout}ms waiting for ${description}`)
}

function buildObserverBootstrap(modes: Record<string, NativeMessagingObserverMode>): string {
  return `(() => {
    const { NativeApp } = ChromeUtils.importESModule(${JSON.stringify(nativeMessagingModule)})
    let observer = NativeApp[${JSON.stringify(browserObserverProperty)}]
    if (!observer) {
      observer = {
        modes: new Map(),
        sessions: new Map(),
        pending: new Map(),
        events: [],
        nextSessionId: 1,
        nextEventId: 1,
        asBytes(value) {
          if (ArrayBuffer.isView(value))
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          if (Object.prototype.toString.call(value) === '[object ArrayBuffer]')
            return new Uint8Array(value)
          return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        },
        makeFrame(payload) {
          const bytes = this.asBytes(payload)
          const frame = new Uint8Array(bytes.byteLength + 4)
          new DataView(frame.buffer).setUint32(0, bytes.byteLength, true)
          frame.set(bytes, 4)
          return frame
        },
        framePayload(frame, maxLength) {
          const bytes = this.asBytes(frame)
          if (bytes.byteLength < 4) throw new Error('Native Messaging frame is shorter than its header')
          const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
          if (length > maxLength || length + 4 !== bytes.byteLength)
            throw new Error('Invalid mutated Native Messaging frame length')
          return bytes.subarray(4)
        },
        encode(bytes) {
          const data = this.asBytes(bytes)
          let binary = ''
          for (let offset = 0; offset < data.length; offset += 0x8000)
            binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000))
          return btoa(binary)
        },
        decode(encoded) {
          const binary = atob(encoded)
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
          return bytes
        },
        configure(config) {
          this.close()
          this.events.length = 0
          this.modes = new Map(Object.entries(config))
        },
        start(app) {
          const hostName = app.name
          const pid = app.proc.pid
          const mode = this.modes.get(hostName)
          if (!mode) return null
          const sessionId = this.nextSessionId++
          this.sessions.set(sessionId, { hostName, pid, mode, app, observed: 0 })
          this.events.push({ type: 'start', sessionId, hostName, pid })
          return sessionId
        },
        inspect(sessionId, channel, value) {
          const session = this.sessions.get(sessionId)
          const bytes = this.asBytes(value)
          if (!session) return Promise.resolve(bytes)
          session.observed++
          const eventId = this.nextEventId++
          this.events.push({
            type: 'data',
            eventId,
            sessionId,
            hostName: session.hostName,
            pid: session.pid,
            channel,
            bytes: this.encode(bytes)
          })
          if (session.mode !== 'blocking') return Promise.resolve(bytes)
          return new Promise(resolve => this.pending.set(eventId, { sessionId, resolve, original: bytes }))
        },
        takeEvents() {
          return this.events.splice(0)
        },
        respond(eventId, encoded) {
          const pending = this.pending.get(eventId)
          if (!pending) return false
          this.pending.delete(eventId)
          try {
            pending.resolve(this.decode(encoded))
          } catch (_) {
            pending.resolve(pending.original)
          }
          return true
        },
        finish(sessionId, code) {
          const session = this.sessions.get(sessionId)
          if (!session) return
          this.events.push({
            type: 'exit',
            sessionId,
            hostName: session.hostName,
            pid: session.pid,
            code
          })
          this.sessions.delete(sessionId)
          for (const [eventId, pending] of this.pending) {
            if (pending.sessionId === sessionId) {
              this.pending.delete(eventId)
              pending.resolve(pending.original)
            }
          }
        },
        close() {
          for (const pending of this.pending.values()) pending.resolve(pending.original)
          this.pending.clear()
          this.modes.clear()
          for (const session of this.sessions.values()) session.mode = 'non-blocking'
        },
        unblock() {
          for (const pending of this.pending.values()) pending.resolve(pending.original)
          this.pending.clear()
          for (const session of this.sessions.values()) session.mode = 'non-blocking'
        },
        async stopHosts() {
          const sessions = [...this.sessions.values()]
          const processes = sessions.map(session => session.app.proc).filter(Boolean)
          for (const session of sessions) session.app.close()
          let timeout
          await Promise.race([
            Promise.all(processes.map(proc => proc.wait().catch(() => undefined))),
            new Promise(resolve => {
              timeout = setTimeout(resolve, 13000)
            })
          ])
          clearTimeout(timeout)
        },
        attach(app) {
          if (Object.prototype.hasOwnProperty.call(app, '__openpolyfillHarnessNativeSession')) return
          const mode = this.modes.get(app.name)
          if (!mode || !app.proc) {
            app.__openpolyfillHarnessNativeSession = null
            return
          }
          const sessionId = this.start(app)
          if (sessionId === null) return
          app.__openpolyfillHarnessNativeSession = sessionId
          const observer = this
          app._startWrite = function() {
            if (!this.sendQueue.length) return
            if (this.writePromise)
              throw new Error('Entered _startWrite() while writePromise is non-null')
            const buffer = this.sendQueue.shift()
            const frame = observer.makeFrame(observer.asBytes(buffer))
            this.writePromise = observer
              .inspect(sessionId, 'stdin', frame)
              .then(forwarded => {
                const complete = observer.asBytes(forwarded)
                const payload = observer.framePayload(complete, 0xffffffff)
                return proc.stdin
                  .write(complete.slice(0, 4).buffer)
                  .then(() => proc.stdin.write(payload.slice().buffer))
              })
              .then(() => {
                this.writePromise = null
                this._startWrite()
              })
              .catch(error => {
                Cu.reportError(error.message)
                this._cleanup(error)
              })
          }
          const proc = app.proc
          proc.wait().then(
            ({ exitCode }) => observer.finish(sessionId, exitCode),
            () => observer.finish(sessionId, null)
          )
          const stdout = proc.stdout
          const readStdout = stdout.read.bind(stdout)
          stdout.readJSON = function(length) {
            return readStdout(length).then(async buffer => {
              const frame = observer.makeFrame(new Uint8Array(buffer))
              const forwarded = await observer.inspect(sessionId, 'stdout', frame)
              const payload = observer.framePayload(forwarded, 1024 * 1024)
              return JSON.parse(new TextDecoder().decode(payload))
            })
          }
          if (proc.stderr) {
            const stderr = proc.stderr
            const readStderr = stderr.read.bind(stderr)
            const decoder = stderr.decoder || new TextDecoder()
            stderr.readString = function(length = null, options = { stream: length === null }) {
              return readStderr(length).then(async buffer => {
                let bytes = observer.asBytes(buffer)
                if (bytes.byteLength)
                  bytes = await observer.inspect(sessionId, 'stderr', bytes)
                return decoder.decode(bytes, options)
              })
            }
          }
        }
      }
      NativeApp[${JSON.stringify(browserObserverProperty)}] = observer
      const originalStartRead = NativeApp.prototype._startRead
      NativeApp.prototype._startRead = function() {
        observer.attach(this)
        return originalStartRead.call(this)
      }
    }
    observer.configure(${JSON.stringify(modes)})
    return true
  })()`
}

function createObserverEvaluation(expression: string): string {
  return `ChromeUtils.importESModule(${JSON.stringify(nativeMessagingModule)}).NativeApp[${JSON.stringify(browserObserverProperty)}].${expression}`
}

/** A single Firefox Native Messaging native-host process. */
export class NativeMessagingSession extends EventEmitter {
  readonly stdin = makeReadable()
  readonly stdout = makeReadable()
  readonly stderr = makeReadable()
  readonly createdAt = Date.now()
  startedAt?: number
  exitedAt?: number
  private currentState: NativeMessagingProcessState = 'starting'
  private readonly streams: Record<NativeMessagingChannel, Readable> = {
    stdin: this.stdin,
    stdout: this.stdout,
    stderr: this.stderr
  }
  private readonly messagesHistory: NativeMessagingMessage[] = []
  private queuedMessages: NativeMessagingMessage[] = []
  private historyBytes = 0
  private queuedMessageBytes = 0
  private readonly messageWaiters: MessageWaiter[] = []
  private readonly frameDecoders: Record<NativeMessagingDirection, NativeMessageFrameDecoder>
  private exitResult?: NativeMessagingExit
  private streamsEnded = false

  constructor(
    readonly hostName: string,
    readonly pid: number
  ) {
    super()
    this.frameDecoders = {
      stdin: new NativeMessageFrameDecoder((raw, message) => this._message('stdin', raw, message)),
      stdout: new NativeMessageFrameDecoder((raw, message) => this._message('stdout', raw, message))
    }
  }

  /** Recent decoded frames retained for inspection, within a bounded history. */
  get messages(): readonly NativeMessagingMessage[] {
    return this.messagesHistory
  }

  get state(): NativeMessagingProcessState {
    return this.currentState
  }

  get exitCode(): number | null {
    return this.exitResult?.code ?? null
  }

  get signal(): NodeJS.Signals | null {
    return this.exitResult?.signal ?? null
  }

  /** Wait for a decoded inbound or outbound Native Messaging frame. */
  waitForMessage(options: NativeMessagingMessageWaitOptions = {}): Promise<NativeMessagingMessage> {
    const queuedIndex = this.queuedMessages.findIndex(
      (message) => options.direction === undefined || message.direction === options.direction
    )
    if (queuedIndex !== -1) {
      const [queued] = this.queuedMessages.splice(queuedIndex, 1)
      this.queuedMessageBytes -= queued!.raw.length
      return Promise.resolve(queued!)
    }
    if (this.state === 'exited') {
      return Promise.reject(
        new Error(`Native messaging host ${this.hostName} exited before a message`)
      )
    }
    return new Promise((resolve, reject) => {
      const waiter: MessageWaiter = { direction: options.direction, resolve, reject }
      if (options.timeout !== undefined && options.timeout > 0) {
        waiter.timer = setTimeout(() => {
          this.removeMessageWaiter(waiter)
          reject(timeoutError(`a message from native host ${this.hostName}`, options.timeout!))
        }, options.timeout)
      }
      this.messageWaiters.push(waiter)
    })
  }

  /** Wait until the native-host process exits. */
  waitForExit(options: NativeMessagingWaitOptions = {}): Promise<NativeMessagingExit> {
    if (this.exitResult) return Promise.resolve(this.exitResult)
    return new Promise((resolve, reject) => {
      const onExit = (exit: NativeMessagingExit) => {
        cleanup()
        resolve(exit)
      }
      const onObserverClosed = () => {
        cleanup()
        reject(
          new Error(`Observation for native host ${this.hostName} was closed before process exit`)
        )
      }
      const cleanup = () => {
        this.off('exit', onExit)
        this.off('observerClosed', onObserverClosed)
        clearTimeout(timer)
      }
      const timer =
        options.timeout !== undefined && options.timeout > 0
          ? setTimeout(() => {
              cleanup()
              reject(timeoutError(`native host ${this.hostName} to exit`, options.timeout!))
            }, options.timeout)
          : undefined
      this.on('exit', onExit)
      this.on('observerClosed', onObserverClosed)
      if (this.exitResult) onExit(this.exitResult)
    })
  }

  _markStarted(): void {
    this.currentState = 'running'
    this.startedAt = Date.now()
    this.emit('start', this)
  }

  _receive(channel: NativeMessagingChannel, bytes: Buffer): void {
    if (this.streamsEnded) return
    const copy = Buffer.from(bytes)
    this.streams[channel].push(copy)
    if (channel !== 'stderr') this.frameDecoders[channel].push(copy)
  }

  _finish(exit: NativeMessagingExit): void {
    if (this.exitResult) return
    this.exitResult = exit
    this.currentState = 'exited'
    this.exitedAt = Date.now()
    this._endStreams()
    for (const waiter of this.messageWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`Native messaging host ${this.hostName} exited before a message`))
    }
    this.emit('exit', exit)
  }

  _observerClosed(): void {
    this._endStreams()
    this.emit('observerClosed')
    for (const waiter of this.messageWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`Observation for native host ${this.hostName} was closed`))
    }
  }

  private _message(direction: NativeMessagingDirection, raw: Buffer, message: unknown): void {
    const observed: NativeMessagingMessage = { direction, message, raw }
    this.retainHistory(observed)
    const waiterIndex = this.messageWaiters.findIndex(
      (waiter) => waiter.direction === undefined || waiter.direction === direction
    )
    if (waiterIndex === -1) {
      this.retainQueuedMessage(observed)
    } else {
      const [waiter] = this.messageWaiters.splice(waiterIndex, 1)
      clearTimeout(waiter!.timer)
      waiter!.resolve(observed)
    }
    this.emit('message', observed)
  }

  private retainHistory(message: NativeMessagingMessage): void {
    if (message.raw.length > maxRetainedMessageBytes) return
    this.messagesHistory.push(message)
    this.historyBytes += message.raw.length
    while (
      this.messagesHistory.length > maxRetainedMessages ||
      this.historyBytes > maxRetainedMessageBytes
    ) {
      const removed = this.messagesHistory.shift()
      if (!removed) break
      this.historyBytes -= removed.raw.length
    }
  }

  private retainQueuedMessage(message: NativeMessagingMessage): void {
    if (message.raw.length > maxRetainedMessageBytes) return
    this.queuedMessages.push(message)
    this.queuedMessageBytes += message.raw.length
    while (
      this.queuedMessages.length > maxRetainedMessages ||
      this.queuedMessageBytes > maxRetainedMessageBytes
    ) {
      const removed = this.queuedMessages.shift()
      if (!removed) break
      this.queuedMessageBytes -= removed.raw.length
    }
  }

  private removeMessageWaiter(waiter: MessageWaiter): void {
    const index = this.messageWaiters.indexOf(waiter)
    if (index !== -1) this.messageWaiters.splice(index, 1)
  }

  private _endStreams(): void {
    if (this.streamsEnded) return
    this.streamsEnded = true
    for (const stream of Object.values(this.streams)) stream.push(null)
  }
}

class NativeMessageFrameDecoder {
  private pending = Buffer.alloc(0)

  constructor(private readonly onMessage: (raw: Buffer, message: unknown) => void) {}

  push(bytes: Buffer): void {
    this.pending =
      this.pending.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.pending, bytes])
    while (this.pending.length >= 4) {
      const payloadLength = this.pending.readUInt32LE(0)
      const frameLength = payloadLength + 4
      if (this.pending.length < frameLength) return
      const raw = Buffer.from(this.pending.subarray(0, frameLength))
      this.pending = this.pending.subarray(frameLength)
      try {
        this.onMessage(raw, JSON.parse(raw.subarray(4).toString('utf8')) as unknown)
      } catch {
        // Invalid frames remain available in the raw stream, but are not decoded as messages.
      }
    }
  }
}

export class NativeMessagingObserver extends EventEmitter {
  private readonly sessionsByBrowserId = new Map<number, NativeMessagingSession>()
  private readonly nativeSessions: NativeMessagingSession[] = []
  private readonly sessionWaiters: SessionWaiter[] = []
  private readonly configurations: Record<string, NativeMessagingObserverConfig>
  private evaluation?: RdpEvaluation
  private pollTimer?: ReturnType<typeof setInterval>
  private polling?: Promise<void>
  private stopping = false
  private closed = false
  private closePromise?: Promise<void>

  constructor(configurations: Record<string, NativeMessagingObserverConfig> = {}) {
    super()
    this.configurations = { ...configurations }
    for (const [hostName, config] of Object.entries(this.configurations)) {
      if (config.mode !== 'non-blocking' && config.mode !== 'blocking') {
        throw new Error(`nativeMessagingObservers['${hostName}'].mode is invalid`)
      }
      if (config.onData !== undefined && typeof config.onData !== 'function') {
        throw new Error(`nativeMessagingObservers['${hostName}'].onData must be a function`)
      }
    }
  }

  get enabled(): boolean {
    return Object.keys(this.configurations).length > 0
  }

  get sessions(): readonly NativeMessagingSession[] {
    return this.nativeSessions
  }

  async start(rdp: FirefoxRDP, chromeTarget: TargetFront): Promise<void> {
    if (!this.enabled || this.evaluation) return
    if (this.closed || this.stopping) {
      throw new Error('Native messaging observation has been closed')
    }
    const consoleActor = chromeTarget.console()
    await consoleActor.call('startListeners', { listeners: ['evaluationResult'] })
    this.evaluation = new RdpEvaluation(rdp, consoleActor)
    const modes = Object.fromEntries(
      Object.entries(this.configurations).map(([hostName, config]) => [hostName, config.mode])
    ) as Record<string, NativeMessagingObserverMode>
    try {
      await this.evaluation.evaluate(buildObserverBootstrap(modes))
    } catch (error) {
      this.evaluation.dispose()
      this.evaluation = undefined
      throw error
    }
    this.pollTimer = setInterval(() => {
      void this.poll().catch((error) => {
        if (!this.closed) this.emit('observerError', error)
      })
    }, 20)
  }

  waitForSession(
    hostName?: string,
    options: NativeMessagingSessionWaitOptions = {}
  ): Promise<NativeMessagingSession> {
    if (!this.enabled) {
      return Promise.reject(new Error('No Native Messaging host observers are configured'))
    }
    if (hostName !== undefined && !this.configurations[hostName]) {
      return Promise.reject(new Error(`Native Messaging observer is not enabled for ${hostName}`))
    }
    if (this.closed || this.stopping) {
      return Promise.reject(new Error('Native messaging observation is closing'))
    }
    const existing = this.nativeSessions
      .slice(Math.max(0, options.after ?? 0))
      .reverse()
      .find((session) => hostName === undefined || session.hostName === hostName)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const waiter: SessionWaiter = { hostName, resolve, reject }
      if (options.timeout !== undefined && options.timeout > 0) {
        waiter.timer = setTimeout(() => {
          this.removeSessionWaiter(waiter)
          reject(
            timeoutError(
              `a native messaging session${hostName ? ` for ${hostName}` : ''}`,
              options.timeout!
            )
          )
        }, options.timeout)
      }
      this.sessionWaiters.push(waiter)
    })
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.shutdown()
    return this.closePromise
  }

  private poll(): Promise<void> {
    if (this.closed || this.stopping || !this.evaluation) return Promise.resolve()
    if (this.polling) return this.polling
    this.polling = this.drainEvents().finally(() => {
      this.polling = undefined
    })
    return this.polling
  }

  private async drainEvents(closing = false): Promise<void> {
    if (!this.evaluation) return
    const events = await this.evaluation.evaluate<BrowserObserverEvent[]>(
      createObserverEvaluation('takeEvents()')
    )
    for (const event of events) this.handleBrowserEvent(event, closing)
  }

  private handleBrowserEvent(event: BrowserObserverEvent, closing = false): void {
    if (event.type === 'start') {
      const session = new NativeMessagingSession(event.hostName, event.pid)
      session._markStarted()
      this.nativeSessions.push(session)
      this.sessionsByBrowserId.set(event.sessionId, session)
      this.emit('session', session)
      this.resolveSessionWaiters(session)
      return
    }

    const session = this.sessionsByBrowserId.get(event.sessionId)
    if (event.type === 'exit') {
      session?._finish({ code: event.code, signal: null })
      this.sessionsByBrowserId.delete(event.sessionId)
      return
    }

    const bytes = Buffer.from(event.bytes, 'base64')
    if (!session) {
      if (this.configurations[event.hostName]?.mode === 'blocking' && !closing) {
        void this.respond(event.eventId, bytes).catch(() => undefined)
      }
      return
    }
    session._receive(event.channel, bytes)
    const streamEvent: NativeMessagingStreamEvent = {
      hostName: event.hostName,
      pid: event.pid,
      channel: event.channel,
      bytes,
      session
    }
    this.emit('data', streamEvent)
    const config = this.configurations[event.hostName]
    if (closing || this.stopping || !config?.onData) {
      if (config?.mode === 'blocking' && !closing && !this.stopping) {
        void this.respond(event.eventId, bytes).catch((error) => this.emit('observerError', error))
      }
      return
    }
    if (config.mode === 'blocking') {
      void this.handleBlockingData(config, event, streamEvent).catch((error) => {
        this.emit('observerError', error)
        void this.respond(event.eventId, bytes).catch(() => undefined)
      })
      return
    }
    try {
      void Promise.resolve(config.onData(streamEvent)).catch((error) => {
        this.emit('observerError', error)
      })
    } catch (error) {
      this.emit('observerError', error)
    }
  }

  private async handleBlockingData(
    config: NativeMessagingObserverConfig,
    event: BrowserDataEvent,
    streamEvent: NativeMessagingStreamEvent
  ): Promise<void> {
    let replacement: NativeMessagingMutation = undefined
    try {
      replacement = await config.onData?.(streamEvent)
    } catch (error) {
      this.emit('observerError', error)
    }
    const bytes =
      replacement instanceof Uint8Array
        ? Buffer.from(replacement.buffer, replacement.byteOffset, replacement.byteLength)
        : streamEvent.bytes
    await this.respond(event.eventId, bytes)
  }

  private async respond(eventId: number, bytes: Buffer): Promise<void> {
    if (!this.evaluation || this.closed) return
    await this.evaluation.evaluate(
      createObserverEvaluation(`respond(${eventId}, ${JSON.stringify(bytes.toString('base64'))})`)
    )
  }

  private resolveSessionWaiters(session: NativeMessagingSession): void {
    for (const waiter of [...this.sessionWaiters]) {
      if (waiter.hostName !== undefined && waiter.hostName !== session.hostName) continue
      this.removeSessionWaiter(waiter)
      waiter.resolve(session)
    }
  }

  private removeSessionWaiter(waiter: SessionWaiter): void {
    const index = this.sessionWaiters.indexOf(waiter)
    if (index !== -1) this.sessionWaiters.splice(index, 1)
    clearTimeout(waiter.timer)
  }

  private async shutdown(): Promise<void> {
    this.stopping = true
    clearInterval(this.pollTimer)
    for (const waiter of this.sessionWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Native messaging observation is closing'))
    }
    await this.polling?.catch(() => undefined)
    if (this.evaluation) {
      try {
        await this.evaluation.evaluate(createObserverEvaluation('unblock()'))
        await this.evaluation.evaluate(createObserverEvaluation('stopHosts()'))
        await this.drainEvents(true)
        await this.evaluation.evaluate(createObserverEvaluation('close()'))
        await this.drainEvents(true)
      } catch {
        // Firefox may already be closing when the observer is torn down.
      }
      this.evaluation.dispose()
      this.evaluation = undefined
    }
    this.closed = true
    for (const session of this.nativeSessions) {
      if (session.state !== 'exited') session._observerClosed()
    }
  }
}
