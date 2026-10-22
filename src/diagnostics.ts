import type { RDPResponse, TargetFront, WebConsoleFront } from '@openpolyfill/firefox-rdp'
import type { FirefoxRdpSession } from './rdp.js'

export interface FirefoxErrorDiagnostic {
  timestamp: string
  executionContext: 'extension background' | 'content script' | 'browser chrome'
  extensionId?: string
  sourceURL?: string
  message: string
  stackTrace?: string
}

interface ConsoleRegistration {
  console: WebConsoleFront
  onPageError: (packet: RDPResponse) => void
  onConsoleApiCall: (packet: RDPResponse) => void
  startedListeners: string[]
  ready: Promise<void>
}

const maxDiagnostics = 500
const maxMessageLength = 16_384
const maxStackLength = 32_768
const consoleListeners = ['PageError', 'ConsoleAPI']

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringField(value: unknown, ...fields: string[]): string | undefined {
  const item = record(value)
  for (const field of fields) {
    const candidate = item?.[field]
    if (typeof candidate === 'string' && candidate.length) return candidate
  }
  return undefined
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}… [truncated]` : value
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function formatArgument(value: unknown): string {
  if (typeof value === 'string') return value
  const grip = record(value)
  const preview = record(grip?.preview)
  const previewMessage = stringField(preview, 'message')
  const previewName = stringField(preview, 'name') ?? stringField(grip, 'class')
  if (previewMessage) return previewName ? `${previewName}: ${previewMessage}` : previewMessage
  const ownProperties = record(preview?.ownProperties)
  const errorMessage = stringField(ownProperties?.message, 'value')
  const className = stringField(grip, 'class')
  if (errorMessage && className) return `${className}: ${errorMessage}`
  const initial = stringField(grip, 'initial')
  if (initial !== undefined) return initial
  return stringify(value)
}

function stackTrace(value: unknown): string | undefined {
  if (typeof value === 'string') return truncate(value, maxStackLength)
  if (Array.isArray(value)) {
    const frames = value.map((item) => {
      const frame = record(item)
      if (!frame) return stringify(item)
      const functionName = stringField(frame, 'functionName', 'name')
      const source = stringField(frame, 'filename', 'source', 'sourceName', 'url')
      const line = frame.lineNumber ?? frame.line
      const column = frame.columnNumber ?? frame.column
      const location = source
        ? `${source}${line === undefined ? '' : `:${String(line)}${column === undefined ? '' : `:${String(column)}`}`}`
        : undefined
      if (functionName && location) return `    at ${functionName} (${location})`
      if (location) return `    at ${location}`
      return functionName ? `    at ${functionName}` : stringify(item)
    })
    return truncate(frames.join('\n'), maxStackLength)
  }
  if (value === undefined || value === null) return undefined
  return truncate(stringify(value), maxStackLength)
}

function timestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value
    const date = new Date(milliseconds)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  if (typeof value === 'string') {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return new Date().toISOString()
}

function cachedMessages(response: unknown): Array<Record<string, unknown>> {
  const object = record(response)
  if (object && (object._type || object.type)) return [object]
  const messages = object?.messages
  if (Array.isArray(messages)) {
    return messages.flatMap((item) => {
      const parsed = record(item)
      return parsed ? [parsed] : []
    })
  }
  const message = object?.message
  if (Array.isArray(message)) {
    return message.flatMap((item) => {
      const parsed = record(item)
      return parsed ? [parsed] : []
    })
  }
  const parsed = record(message)
  return parsed ? [parsed] : []
}

/** Collects Firefox WebConsole errors while keeping a bounded, per-test buffer. */
export class FirefoxErrorDiagnostics {
  private readonly diagnostics: FirefoxErrorDiagnostic[] = []
  private readonly seenDiagnosticKeys = new Map<string, FirefoxErrorDiagnostic>()
  private readonly registrations = new Map<string, ConsoleRegistration>()
  private droppedCount = 0
  private firstTestStarted = false
  private closed = false

  private readonly onPacket = (packet: RDPResponse): void => {
    const item = record(packet)
    if (item?.type === 'target-available-form') {
      const actor = stringField(item.target, 'actor')
      const target = actor
        ? this.session.targets.find((candidate) => candidate.actorId === actor)
        : undefined
      if (target) void this.observeTarget(target)
      return
    }
    if (item?.type === 'target-destroyed-form') {
      const actor = stringField(item.target, 'actor')
      if (actor) this.removeTarget(actor)
    }
  }

  private readonly onConnectionClose = (): void => {
    this.disposeListeners()
  }

  constructor(
    private readonly session: FirefoxRdpSession,
    private extensionId?: string
  ) {
    this.session.rdp.on('packet', this.onPacket)
    this.session.rdp.on('close', this.onConnectionClose)
  }

  async start(): Promise<void> {
    const existing = new Set(this.session.targets)
    if (this.session.chromeTarget) existing.add(this.session.chromeTarget)
    await Promise.all([...existing].map((target) => this.observeTarget(target)))
  }

  setExtensionId(extensionId: string): void {
    this.extensionId = extensionId
    for (let index = this.diagnostics.length - 1; index >= 0; index--) {
      const entry = this.diagnostics[index]
      if (
        entry?.executionContext === 'extension background' &&
        entry.extensionId !== undefined &&
        entry.extensionId !== extensionId
      )
        this.diagnostics.splice(index, 1)
    }
    this.seenDiagnosticKeys.clear()
    for (const entry of this.diagnostics)
      this.seenDiagnosticKeys.set(this.diagnosticKey(entry), entry)
  }

  /** Preserve startup diagnostics for the first test; discard all prior-test events afterwards. */
  beginTest(): void {
    if (this.firstTestStarted) this.clear()
    this.firstTestStarted = true
  }

  snapshot(): { entries: FirefoxErrorDiagnostic[]; droppedCount: number } {
    return {
      entries: this.diagnostics.map((entry) => ({ ...entry })),
      droppedCount: this.droppedCount
    }
  }

  endTest(): void {
    this.clear()
  }

  async close(): Promise<void> {
    if (this.closed) return
    const registrations = [...this.registrations.values()]
    this.disposeListeners()
    await Promise.all(
      registrations.map((registration) =>
        registration.startedListeners.length
          ? registration.console
              .call('stopListeners', { listeners: registration.startedListeners })
              .catch(() => undefined)
          : Promise.resolve()
      )
    )
  }

  private clear(): void {
    this.diagnostics.length = 0
    this.droppedCount = 0
    this.seenDiagnosticKeys.clear()
  }

  private diagnosticKey(entry: FirefoxErrorDiagnostic): string {
    return JSON.stringify([
      Math.floor(Date.parse(entry.timestamp) / 100),
      entry.sourceURL,
      entry.message,
      entry.stackTrace
    ])
  }

  private contextPriority(context: FirefoxErrorDiagnostic['executionContext']): number {
    if (context === 'extension background') return 3
    if (context === 'content script') return 2
    return 1
  }

  private disposeListeners(): void {
    if (this.closed) return
    this.closed = true
    this.session.rdp.off('packet', this.onPacket)
    this.session.rdp.off('close', this.onConnectionClose)
    for (const [actorId, registration] of this.registrations) {
      registration.console.off('pageError', registration.onPageError)
      registration.console.off('consoleAPICall', registration.onConsoleApiCall)
      this.registrations.delete(actorId)
    }
  }

  private observeTarget(target: TargetFront): Promise<void> {
    if (this.closed || this.registrations.has(target.actorId))
      return this.registrations.get(target.actorId)?.ready ?? Promise.resolve()

    let consoleActor: WebConsoleFront
    try {
      consoleActor = target.console()
    } catch {
      return Promise.resolve()
    }

    const registration: ConsoleRegistration = {
      console: consoleActor,
      onPageError: (packet) => this.capturePacket(target, 'pageError', packet),
      onConsoleApiCall: (packet) => this.capturePacket(target, 'consoleAPICall', packet),
      startedListeners: [],
      ready: Promise.resolve()
    }
    this.registrations.set(target.actorId, registration)
    consoleActor.on('pageError', registration.onPageError)
    consoleActor.on('consoleAPICall', registration.onConsoleApiCall)
    registration.ready = this.startConsoleListeners(target, registration)
    return registration.ready
  }

  private async startConsoleListeners(
    target: TargetFront,
    registration: ConsoleRegistration
  ): Promise<void> {
    try {
      const response = await registration.console.call('startListeners', {
        listeners: consoleListeners
      })
      const started = record(response)?.startedListeners
      registration.startedListeners = Array.isArray(started)
        ? started.filter((listener): listener is string => typeof listener === 'string')
        : [...consoleListeners]
    } catch {
      this.removeTarget(target.actorId)
      return
    }

    try {
      const cached = await registration.console.call('getCachedMessages', {
        messageTypes: consoleListeners
      })
      if (this.registrations.get(target.actorId) !== registration) return
      for (const entry of cachedMessages(cached)) this.captureCachedMessage(target, entry)
    } catch {
      // Cached messages are best-effort; live event listeners remain active.
    }
  }

  private captureCachedMessage(target: TargetFront, entry: Record<string, unknown>): void {
    const type = stringField(entry, '_type', 'type')?.toLowerCase()
    if (type?.includes('pageerror')) {
      const payload = record(entry.message) ?? entry
      this.capture(target, 'pageError', payload, entry.timeStamp)
    } else if (type?.includes('consoleapi')) {
      const payload = record(entry.message) ?? entry
      this.capture(target, 'consoleAPICall', payload, entry.timeStamp)
    }
  }

  private capturePacket(
    target: TargetFront,
    type: 'pageError' | 'consoleAPICall',
    packet: RDPResponse
  ): void {
    const item = record(packet)
    if (!item) return
    const payload = type === 'pageError' ? record(item.pageError) : record(item.message)
    this.capture(target, type, payload ?? item, item.timeStamp)
  }

  private capture(
    target: TargetFront,
    type: 'pageError' | 'consoleAPICall',
    payload: Record<string, unknown>,
    packetTimestamp?: unknown
  ): void {
    if (this.closed) return
    if (type === 'consoleAPICall' && stringField(payload, 'level')?.toLowerCase() !== 'error')
      return

    const sourceURL = stringField(payload, 'sourceName', 'sourceURL', 'filename', 'url')
    const targetURL = stringField(target.form, 'url')
    const addonId = stringField(payload, 'addonId') ?? stringField(target.form, 'addonId')
    const executionContext = this.executionContext(target, sourceURL, targetURL, addonId)
    if (!executionContext) return
    if (addonId && this.extensionId && addonId !== this.extensionId) return

    const args = payload.arguments
    const error = record(payload.error) ?? record(payload.exception)
    const errorPreview = record(error?.preview)
    const errorArgumentPreview = Array.isArray(args)
      ? args
          .map((argument) => record(record(argument)?.preview))
          .find((preview) => !!stringField(preview, 'message') || !!stringField(preview, 'stack'))
      : undefined
    const message =
      type === 'consoleAPICall' && Array.isArray(args)
        ? args.map(formatArgument).filter(Boolean).join(' ')
        : ([
            payload.errorMessage,
            payload.message,
            payload.description,
            payload.error,
            payload.exception,
            stringField(errorArgumentPreview, 'message'),
            payload.name
          ]
            .map(formatArgument)
            .find(Boolean) ?? 'Uncaught exception')
    const stack =
      payload.stacktrace ??
      payload.stackTrace ??
      payload.exceptionStack ??
      stringField(errorPreview, 'stack') ??
      stringField(errorArgumentPreview, 'stack')
    const formattedStack = stackTrace(stack)
    const diagnostic: FirefoxErrorDiagnostic = {
      timestamp: timestamp(payload.timeStamp ?? payload.timestamp ?? packetTimestamp),
      executionContext,
      ...(addonId ? { extensionId: truncate(addonId, 1_024) } : {}),
      ...(sourceURL || targetURL
        ? { sourceURL: truncate(sourceURL ?? targetURL ?? '', 4_096) }
        : {}),
      message: truncate(message || 'Error-level console message', maxMessageLength),
      ...(formattedStack ? { stackTrace: formattedStack } : {})
    }
    const key = this.diagnosticKey(diagnostic)
    const existing = this.seenDiagnosticKeys.get(key)
    if (existing) {
      if (
        this.contextPriority(diagnostic.executionContext) >
        this.contextPriority(existing.executionContext)
      )
        Object.assign(existing, diagnostic)
      return
    }
    this.seenDiagnosticKeys.set(key, diagnostic)
    if (this.seenDiagnosticKeys.size > maxDiagnostics * 2) {
      const oldestKey = this.seenDiagnosticKeys.keys().next().value
      if (oldestKey !== undefined) this.seenDiagnosticKeys.delete(oldestKey)
    }

    if (this.diagnostics.length === maxDiagnostics) {
      const removed = this.diagnostics.shift()
      if (removed) {
        const removedKey = this.diagnosticKey(removed)
        if (this.seenDiagnosticKeys.get(removedKey) === removed)
          this.seenDiagnosticKeys.delete(removedKey)
      }
      this.droppedCount++
    }
    this.diagnostics.push(diagnostic)
  }

  private executionContext(
    target: TargetFront,
    sourceURL: string | undefined,
    targetURL: string | undefined,
    addonId: string | undefined
  ): FirefoxErrorDiagnostic['executionContext'] | undefined {
    if (addonId) return 'extension background'

    const sourceIsExtension = sourceURL?.startsWith('moz-extension://') ?? false
    if (sourceIsExtension) {
      if (targetURL?.startsWith('moz-extension://')) return 'extension background'
      return 'content script'
    }

    const isChromeTarget = target.actorId === this.session.chromeTarget?.actorId
    const isChromeURL = (url: string | undefined): boolean =>
      !!url && /^(?:chrome|resource|jar):/.test(url)
    const isChromeAboutURL = (url: string | undefined): boolean =>
      !!url &&
      /^about:(?:preferences|addons|debugging|config|downloads|support|newtab|home)(?:[?#]|$)/.test(
        url
      )
    if (
      isChromeTarget ||
      isChromeURL(sourceURL) ||
      isChromeURL(targetURL) ||
      isChromeAboutURL(sourceURL) ||
      isChromeAboutURL(targetURL)
    )
      return 'browser chrome'
    return undefined
  }

  private removeTarget(actorId: string): void {
    const registration = this.registrations.get(actorId)
    if (!registration) return
    registration.console.off('pageError', registration.onPageError)
    registration.console.off('consoleAPICall', registration.onConsoleApiCall)
    this.registrations.delete(actorId)
  }
}
