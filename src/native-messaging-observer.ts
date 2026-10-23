import { EventEmitter } from 'node:events'
import { chmod, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { Readable } from 'node:stream'

export type NativeMessagingDirection = 'stdin' | 'stdout'
export type NativeMessagingChannel = NativeMessagingDirection | 'stderr'
export type NativeMessagingProcessState = 'starting' | 'running' | 'exited'

export interface NativeMessagingMessage {
  direction: NativeMessagingDirection
  message: unknown
  /** The complete 4-byte-length-prefixed frame copied from the corresponding raw stream. */
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

interface ProxyStartEvent {
  type: 'start'
  hostName: string
  pid: number | null
  launcherPid: number
}

interface ProxyDataEvent {
  type: 'data'
  channel: NativeMessagingChannel
  bytes: string
}

interface ProxyExitEvent {
  type: 'exit'
  code: number | null
  signal: NodeJS.Signals | null
}

type ProxyEvent =
  ProxyStartEvent | ProxyDataEvent | ProxyExitEvent | { type: 'error'; message: string }

function makeReadable(): Readable {
  return new Readable({ read() {} })
}

function timeoutError(description: string, timeout: number): Error {
  return new Error(`Timed out after ${timeout}ms waiting for ${description}`)
}

/** One Firefox native-host process and copies of the bytes it exchanged with Firefox. */
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
  private readonly messageWaiters: MessageWaiter[] = []
  private readonly frameDecoders: Record<NativeMessagingDirection, NativeMessageFrameDecoder>
  private exitResult?: NativeMessagingExit
  private streamsEnded = false

  constructor(
    readonly hostName: string,
    readonly pid: number | undefined,
    readonly launcherPid: number
  ) {
    super()
    this.frameDecoders = {
      stdin: new NativeMessageFrameDecoder((raw, message) => this._message('stdin', raw, message)),
      stdout: new NativeMessageFrameDecoder((raw, message) => this._message('stdout', raw, message))
    }
  }

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
      return Promise.resolve(this.queuedMessages.splice(queuedIndex, 1)[0]!)
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

  /** Wait until Firefox's native-host process exits. */
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
    const observed: NativeMessagingMessage = { direction, message, raw: Buffer.from(raw) }
    this.messagesHistory.push(observed)
    const waiterIndex = this.messageWaiters.findIndex(
      (waiter) => waiter.direction === undefined || waiter.direction === direction
    )
    if (waiterIndex === -1) {
      this.queuedMessages.push(observed)
    } else {
      const [waiter] = this.messageWaiters.splice(waiterIndex, 1)
      clearTimeout(waiter!.timer)
      waiter!.resolve(observed)
    }
    this.emit('message', observed)
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
      const payload = raw.subarray(4)
      this.pending = this.pending.subarray(frameLength)
      try {
        this.onMessage(raw, JSON.parse(payload.toString('utf8')) as unknown)
      } catch {
        // Invalid frames remain available in the raw stream, but are not decoded as messages.
      }
    }
  }
}

/** Collects isolated native-host sessions for one Firefox context. */
export class NativeMessagingObserver extends EventEmitter {
  readonly socketPath: string
  private readonly server: Server
  private readonly nativeSessions: NativeMessagingSession[] = []
  private readonly sockets = new Set<Socket>()
  private readonly sessionWaiters: SessionWaiter[] = []
  private closed = false
  private closePromise?: Promise<void>

  private constructor(socketPath: string) {
    super()
    this.socketPath = socketPath
    this.server = createServer((socket) => this.accept(socket))
    this.server.on('error', () => undefined)
  }

  static async create(userDataDir: string): Promise<NativeMessagingObserver> {
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\openpolyfill-native-messaging-${basename(userDataDir)}`
        : join(userDataDir, 'native-messaging-observer.sock')
    const observer = new NativeMessagingObserver(socketPath)
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      observer.server.once('error', onError)
      observer.server.listen(observer.socketPath, () => {
        observer.server.off('error', onError)
        resolve()
      })
    })
    if (process.platform !== 'win32') {
      try {
        await chmod(observer.socketPath, 0o600)
      } catch (error) {
        await observer.close()
        throw error
      }
    }
    return observer
  }

  get sessions(): readonly NativeMessagingSession[] {
    return this.nativeSessions
  }

  /** Wait for a newly observed host, or return the most recently observed matching session. */
  waitForSession(
    hostName?: string,
    options: NativeMessagingSessionWaitOptions = {}
  ): Promise<NativeMessagingSession> {
    const existing = this.nativeSessions
      .slice(Math.max(0, options.after ?? 0))
      .reverse()
      .find((session) => hostName === undefined || session.hostName === hostName)
    if (existing) return Promise.resolve(existing)
    if (this.closed) {
      return Promise.reject(new Error('Native messaging observation has been closed'))
    }

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

  private accept(socket: Socket): void {
    if (this.closed) {
      socket.destroy()
      return
    }
    this.sockets.add(socket)
    let pending = Buffer.alloc(0)
    let session: NativeMessagingSession | undefined
    socket.on('error', () => undefined)
    socket.on('data', (chunk: Buffer) => {
      pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk])
      while (pending.length >= 4) {
        const length = pending.readUInt32LE(0)
        if (pending.length < length + 4) return
        const payload = pending.subarray(4, length + 4)
        pending = pending.subarray(length + 4)
        let event: ProxyEvent
        try {
          event = JSON.parse(payload.toString('utf8')) as ProxyEvent
        } catch {
          socket.destroy()
          return
        }
        if (event.type === 'start') {
          if (
            session ||
            typeof event.hostName !== 'string' ||
            typeof event.launcherPid !== 'number'
          ) {
            socket.destroy()
            return
          }
          session = new NativeMessagingSession(
            event.hostName,
            typeof event.pid === 'number' ? event.pid : undefined,
            event.launcherPid
          )
          session._markStarted()
          this.nativeSessions.push(session)
          this.emit('session', session)
          this.resolveSessionWaiters(session)
        } else if (event.type === 'data') {
          if (!session || !['stdin', 'stdout', 'stderr'].includes(event.channel)) {
            socket.destroy()
            return
          }
          session._receive(event.channel, Buffer.from(event.bytes, 'base64'))
        } else if (event.type === 'exit') {
          session?._finish({ code: event.code, signal: event.signal })
        } else if (event.type === 'error') {
          session?.emit('hostError', new Error(event.message))
        } else {
          socket.destroy()
          return
        }
      }
    })
    socket.on('close', () => {
      this.sockets.delete(socket)
      session?._observerClosed()
    })
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
    this.closed = true
    for (const waiter of this.sessionWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Native messaging observation has been closed'))
    }
    await Promise.all(
      this.nativeSessions
        .filter((session) => session.state !== 'exited')
        .map((session) => session.waitForExit({ timeout: 1_000 }).catch(() => undefined))
    )
    for (const socket of this.sockets) socket.destroy()
    for (const session of this.nativeSessions) session._observerClosed()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    await unlink(this.socketPath).catch(() => undefined)
  }
}

/** Source for the per-context launcher used to tee one native host's stdio. */
export function nativeMessagingProxySource(
  hostName: string,
  executable: string,
  socketPath: string
): string {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'

const hostName = __HOST_NAME__
const executable = __HOST_EXECUTABLE__
const socketPath = __OBSERVER_SOCKET__
const observer = createConnection({ path: socketPath })
const queued = []
let observerReady = false
let observerFailed = false
let closeObserverWhenReady = false

function encode(event) {
  const payload = Buffer.from(JSON.stringify(event), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32LE(payload.length, 0)
  return Buffer.concat([length, payload])
}

function flushObserver() {
  if (!observerReady || observerFailed) return
  while (queued.length) observer.write(queued.shift())
  if (closeObserverWhenReady) observer.end()
}

function report(event) {
  if (observerFailed) return
  const record = encode(event)
  if (!observerReady) queued.push(record)
  else observer.write(record)
}

observer.on('connect', () => {
  observerReady = true
  flushObserver()
})
observer.on('error', () => {
  observerFailed = true
  queued.length = 0
})

const child = spawn(executable, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'pipe'] })
child.stdin.on('error', () => undefined)
let announced = false
let childClosed = false
const announceStart = () => {
  if (announced) return
  announced = true
  report({ type: 'start', hostName, pid: child.pid ?? null, launcherPid: process.pid })
}

child.once('spawn', () => {
  announceStart()
  process.stdin.on('data', (chunk) => {
    if (!child.stdin.write(chunk)) process.stdin.pause()
    report({ type: 'data', channel: 'stdin', bytes: chunk.toString('base64') })
  })
  child.stdin.on('drain', () => process.stdin.resume())
  process.stdin.on('end', () => child.stdin.end())
  process.stdin.on('error', () => child.stdin.destroy())
})
child.once('error', (error) => {
  announceStart()
  report({ type: 'error', message: String(error) })
})
child.stdout.on('data', (chunk) => {
  if (!process.stdout.write(chunk)) child.stdout.pause()
  report({ type: 'data', channel: 'stdout', bytes: chunk.toString('base64') })
})
child.stdout.on('error', () => undefined)
child.stderr.on('data', (chunk) => {
  if (!process.stderr.write(chunk)) child.stderr.pause()
  report({ type: 'data', channel: 'stderr', bytes: chunk.toString('base64') })
})
child.stderr.on('error', () => undefined)
process.stdout.on('drain', () => child.stdout.resume())
process.stderr.on('drain', () => child.stderr.resume())
process.stdout.on('error', () => child.kill())
process.stderr.on('error', () => child.kill())
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}
child.on('close', (code, signal) => {
  if (childClosed) return
  childClosed = true
  process.stdin.pause()
  report({ type: 'exit', code, signal })
  if (observerReady) observer.end()
  else closeObserverWhenReady = true
  process.exitCode = code ?? 1
})
`
    .replace('__HOST_NAME__', JSON.stringify(hostName))
    .replace('__HOST_EXECUTABLE__', JSON.stringify(executable))
    .replace('__OBSERVER_SOCKET__', JSON.stringify(socketPath))
}
