import { access, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { launchFirefoxExtension } from '../../src/launch.js'
import { baseTest, createFirefoxFixtures, expect } from './fixtures.js'
import type { FirefoxExtension, InternalFirefoxContext } from '../../src/types.js'

const extensionPath = new URL('../fixtures/native-messaging-extension', import.meta.url).pathname
const nativeHostExecutable = new URL('../fixtures/native-messaging-host.mjs', import.meta.url)
  .pathname
const nativeExtensionId = 'native.messaging@tests.mozilla.org'
const nativeHostName = 'org.openpolyfill.echo'

type NativeHostReply = {
  message: unknown
  pid: number
  manifestPath: string
  description: string
  extensionId: string
}

function nativeMessagingHosts(description: string, executable = nativeHostExecutable) {
  return {
    [nativeHostName]: {
      executable,
      description,
      allowedExtensions: [nativeExtensionId]
    }
  }
}

const observeNativeMessagingHost = {
  [nativeHostName]: { mode: 'non-blocking' as const }
}

const workerTest = createFirefoxFixtures(baseTest, {
  extensionPaths: [extensionPath],
  headless: true,
  contextScope: 'worker',
  nativeMessagingHosts: nativeMessagingHosts('Worker-scoped native host'),
  nativeMessagingObservers: observeNativeMessagingHost
})
workerTest.describe.configure({ mode: 'parallel' })

async function sendNativeMessage(
  extension: FirefoxExtension,
  message: unknown
): Promise<NativeHostReply> {
  if (!extension.background) throw new Error('Native messaging extension has no background context')
  return extension.background.evaluate<NativeHostReply>(
    `browser.runtime.sendNativeMessage(${JSON.stringify(nativeHostName)}, ${JSON.stringify(message)})`
  )
}

function nativeManifestDirectory(context: InternalFirefoxContext): string {
  const userDataDir = context._firefoxHarness?.userDataDir
  if (!userDataDir) throw new Error('Firefox context has no harness profile directory')
  return join(userDataDir, 'native-messaging', 'native-messaging-hosts')
}

function stoppedMarker(pid: number): string {
  return join(tmpdir(), `openpolyfill-native-host-${pid}.stopped`)
}

async function waitForHostExit(pid: number): Promise<void> {
  const marker = stoppedMarker(pid)
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      await access(marker)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error(`Native messaging host process ${pid} did not exit`)
}
function nativeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32LE(payload.length)
  return Buffer.concat([length, payload])
}

async function readRawBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

workerTest(
  'discovers its isolated manifest and captures one-shot native messaging',
  async ({ context, extensions, nativeMessaging }) => {
    const extension = extensions.values().next().value!
    const manifestDirectory = nativeManifestDirectory(context)
    const manifestPath = join(manifestDirectory, `${nativeHostName}.json`)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({
      name: nativeHostName,
      type: 'stdio',
      allowed_extensions: [nativeExtensionId]
    })
    expect(manifest.path).toBe(nativeHostExecutable)

    const request = { text: 'one-shot' }
    const sessionCount = nativeMessaging.sessions.length
    const sessionPromise = nativeMessaging.waitForSession(nativeHostName, {
      after: sessionCount,
      timeout: 5_000
    })
    const observedDirections: string[] = []
    const onObservedData = (event: { channel: string }) => observedDirections.push(event.channel)
    nativeMessaging.on('data', onObservedData)
    let pid: number | undefined
    try {
      const [response, session] = await Promise.all([
        sendNativeMessage(extension, request),
        sessionPromise
      ])
      pid = response.pid
      expect(response).toMatchObject({
        message: request,
        description: 'Worker-scoped native host',
        extensionId: nativeExtensionId,
        manifestPath
      })
      expect(session.hostName).toBe(nativeHostName)
      expect(session.pid).toBe(response.pid)
      expect(session.startedAt).toBeDefined()
      expect(
        (await session.waitForMessage({ direction: 'stdout', timeout: 5_000 })).message
      ).toEqual(response)
      expect(observedDirections).toContain('stdin')
      expect(
        (await session.waitForMessage({ direction: 'stdin', timeout: 5_000 })).message
      ).toEqual(request)
      expect(await session.waitForExit({ timeout: 5_000 })).toEqual({ code: 0, signal: null })
      expect(session.state).toBe('exited')
      expect(session.exitCode).toBe(0)
      expect(session.exitedAt).toBeDefined()
      const [rawInput, rawOutput] = await Promise.all([
        readRawBytes(session.stdin),
        readRawBytes(session.stdout)
      ])
      expect(rawInput).toEqual(nativeFrame(request))
      expect(rawOutput).toEqual(nativeFrame(response))
      await waitForHostExit(response.pid)
    } finally {
      nativeMessaging.off('data', onObservedData)
      if (pid !== undefined) await rm(stoppedMarker(pid), { force: true })
    }
  }
)

workerTest(
  'keeps connectNative open and observes multiple bidirectional messages',
  async ({ extensions, nativeMessaging }) => {
    const extension = extensions.values().next().value!
    if (!extension.background)
      throw new Error('Native messaging extension has no background context')
    const sessionCount = nativeMessaging.sessions.length
    const sessionPromise = nativeMessaging.waitForSession(nativeHostName, {
      after: sessionCount,
      timeout: 5_000
    })
    const repliesPromise = extension.background.evaluate<
      NativeHostReply[]
    >(`(() => new Promise((resolve, reject) => {
    const port = browser.runtime.connectNative(${JSON.stringify(nativeHostName)});
    const replies = [];
    const timeout = setTimeout(() => reject(new Error('native host timed out')), 5000);
    port.onMessage.addListener(message => {
      replies.push(message);
      if (replies.length === 1) {
        port.postMessage({ text: 'second' });
      } else {
        clearTimeout(timeout);
        port.disconnect();
        resolve(replies);
      }
    });
    port.onDisconnect.addListener(() => {
      if (replies.length < 2) reject(new Error('native host disconnected before both replies'));
    });
    port.postMessage({ text: 'first' });
  }))()`)
    const [replies, session] = await Promise.all([repliesPromise, sessionPromise])

    expect(replies.map(({ message }) => message)).toEqual([{ text: 'first' }, { text: 'second' }])
    expect(replies[1].pid).toBe(replies[0].pid)
    expect(replies[1].manifestPath).toBe(replies[0].manifestPath)
    expect(session.pid).toBe(replies[0].pid)
    expect(await session.waitForExit({ timeout: 5_000 })).toEqual({ code: 0, signal: null })
    expect(await readRawBytes(session.stdin)).toEqual(
      Buffer.concat([nativeFrame({ text: 'first' }), nativeFrame({ text: 'second' })])
    )
    expect(
      session.messages
        .filter(({ direction }) => direction === 'stdin')
        .map(({ message }) => message)
    ).toEqual([{ text: 'first' }, { text: 'second' }])
    expect(
      session.messages
        .filter(({ direction }) => direction === 'stdout')
        .map(({ message }) => message)
    ).toEqual(replies)
    const observedInputs = [
      (await session.waitForMessage({ direction: 'stdin', timeout: 5_000 })).message,
      (await session.waitForMessage({ direction: 'stdin', timeout: 5_000 })).message
    ]
    const observedOutputs = [
      (await session.waitForMessage({ direction: 'stdout', timeout: 5_000 })).message,
      (await session.waitForMessage({ direction: 'stdout', timeout: 5_000 })).message
    ]
    expect(observedInputs).toEqual([{ text: 'first' }, { text: 'second' }])
    expect(observedOutputs).toEqual(replies)
    try {
      await waitForHostExit(replies[0].pid)
      expect(await session.waitForExit({ timeout: 5_000 })).toEqual({ code: 0, signal: null })
    } finally {
      await rm(stoppedMarker(replies[0].pid), { force: true })
    }
  }
)

workerTest(
  'captures stderr and decodes partially written Native Messaging frames',
  async ({ extensions, nativeMessaging }) => {
    const extension = extensions.values().next().value!
    const request = {
      text: 'partial-frame',
      stderr: 'diagnostic from native host\\n',
      partialFrame: true
    }
    const sessionCount = nativeMessaging.sessions.length
    const sessionPromise = nativeMessaging.waitForSession(nativeHostName, {
      after: sessionCount,
      timeout: 5_000
    })
    let pid: number | undefined
    try {
      const [response, session] = await Promise.all([
        sendNativeMessage(extension, request),
        sessionPromise
      ])
      pid = response.pid
      expect(await session.waitForMessage({ direction: 'stdout', timeout: 5_000 })).toMatchObject({
        direction: 'stdout',
        message: response
      })
      expect(await session.waitForExit({ timeout: 5_000 })).toEqual({ code: 0, signal: null })
      const [rawInput, rawOutput, rawStderr] = await Promise.all([
        readRawBytes(session.stdin),
        readRawBytes(session.stdout),
        readRawBytes(session.stderr)
      ])
      expect(rawInput).toEqual(nativeFrame(request))
      expect(rawOutput).toEqual(nativeFrame(response))
      expect(rawStderr.toString('utf8')).toBe(request.stderr)
      expect(session.messages).toHaveLength(2)
      await waitForHostExit(response.pid)
    } finally {
      if (pid !== undefined) await rm(stoppedMarker(pid), { force: true })
    }
  }
)

baseTest('registered native hosts are not observed without per-name opt-in', async () => {
  const running = await launchFirefoxExtension({
    extensionPaths: [extensionPath],
    headless: true,
    nativeMessagingHosts: nativeMessagingHosts('Unobserved native host')
  })
  let pid: number | undefined
  try {
    const response = await sendNativeMessage(running.extensions.values().next().value!, {
      text: 'not-observed'
    })
    pid = response.pid
    expect(response.message).toEqual({ text: 'not-observed' })
    expect(running.nativeMessaging.sessions).toHaveLength(0)
    await waitForHostExit(response.pid)
  } finally {
    await running.close()
    if (pid !== undefined) await rm(stoppedMarker(pid), { force: true })
  }
})

baseTest('blocking Native Messaging observers can mutate both stream directions', async () => {
  const running = await launchFirefoxExtension({
    extensionPaths: [extensionPath],
    headless: true,
    nativeMessagingHosts: nativeMessagingHosts('Blocking native host'),
    nativeMessagingObservers: {
      [nativeHostName]: {
        mode: 'blocking',
        onData: ({ channel, bytes }) => {
          if (channel !== 'stdin' && channel !== 'stdout') return
          const payloadLength = bytes.readUInt32LE(0)
          const payload = JSON.parse(
            bytes.subarray(4, payloadLength + 4).toString('utf8')
          ) as Record<string, unknown>
          if (channel === 'stdin') {
            payload.text = 'mutated-inbound'
          } else if (payload.message && typeof payload.message === 'object') {
            payload.message = {
              ...(payload.message as Record<string, unknown>),
              text: 'mutated-outbound'
            }
          }
          return nativeFrame(payload)
        }
      }
    }
  })
  const request = { text: 'original' }
  const sessionPromise = running.nativeMessaging.waitForSession(nativeHostName, { timeout: 5_000 })
  let pid: number | undefined
  try {
    const [response, session] = await Promise.all([
      sendNativeMessage(running.extensions.values().next().value!, request),
      sessionPromise
    ])
    pid = response.pid
    expect(response.message).toEqual({ text: 'mutated-outbound' })
    expect((await session.waitForMessage({ direction: 'stdin', timeout: 5_000 })).message).toEqual(
      request
    )
    const observedOutput = await session.waitForMessage({ direction: 'stdout', timeout: 5_000 })
    expect(observedOutput.message).toMatchObject({ message: { text: 'mutated-inbound' } })
    expect(await session.waitForExit({ timeout: 5_000 })).toEqual({ code: 0, signal: null })
    await waitForHostExit(response.pid)
  } finally {
    await running.close()
    if (pid !== undefined) await rm(stoppedMarker(pid), { force: true })
  }
})

baseTest('writes valid native manifests without probing executable paths', async () => {
  const missingExecutable = join(tmpdir(), `openpolyfill-missing-native-host-${process.pid}`)
  await rm(missingExecutable, { force: true })
  const running = await launchFirefoxExtension({
    extensionPaths: [extensionPath],
    headless: true,
    nativeMessagingHosts: nativeMessagingHosts('Missing native binary', missingExecutable)
  })
  try {
    const manifestDirectory = join(
      running.userDataDir,
      'native-messaging',
      process.platform === 'darwin' ? 'NativeMessagingHosts' : 'native-messaging-hosts'
    )
    const manifestPath = join(manifestDirectory, `${nativeHostName}.json`)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    expect(manifest.path).toBe(missingExecutable)
    await expect(access(missingExecutable)).rejects.toThrow()
  } finally {
    await running.close()
  }
})

baseTest('fixture teardown stops an open native host and removes private manifests', async () => {
  const running = await launchFirefoxExtension({
    extensionPaths: [extensionPath],
    headless: true,
    nativeMessagingHosts: nativeMessagingHosts('Teardown native host'),
    nativeMessagingObservers: observeNativeMessagingHost
  })
  let pid: number | undefined
  let closed = false
  try {
    const extension = running.extensions.values().next().value!
    if (!extension.background)
      throw new Error('Native messaging extension has no background context')
    const [response, session] = await Promise.all([
      extension.background.evaluate<NativeHostReply>(`(() => new Promise(resolve => {
        const port = browser.runtime.connectNative(${JSON.stringify(nativeHostName)});
        globalThis.__harnessOpenNativePort = port;
        port.onMessage.addListener(resolve);
        port.postMessage({ text: 'keep-alive' });
      }))()`),
      running.nativeMessaging.waitForSession(nativeHostName, { timeout: 5_000 })
    ])
    pid = response.pid
    expect(response.message).toEqual({ text: 'keep-alive' })
    expect(session.hostName).toBe(nativeHostName)
    expect(session.pid).toBe(response.pid)
    expect((await session.waitForMessage({ direction: 'stdin', timeout: 5_000 })).message).toEqual({
      text: 'keep-alive'
    })
    await expect(access(stoppedMarker(pid))).rejects.toThrow()

    await running.close()
    closed = true
    const exit = await session.waitForExit({ timeout: 5_000 })
    expect(session.state).toBe('exited')
    expect(exit.code !== null || exit.signal !== null).toBe(true)
    await waitForHostExit(pid)
    await expect(stat(running.userDataDir)).rejects.toThrow()
  } finally {
    if (!closed) await running.close()
    if (pid !== undefined) await rm(stoppedMarker(pid), { force: true })
  }
})

baseTest('isolates same-name hosts across concurrent Firefox worker contexts', async () => {
  const launches = await Promise.allSettled([
    launchFirefoxExtension({
      extensionPaths: [extensionPath],
      headless: true,
      nativeMessagingHosts: nativeMessagingHosts('First worker host'),
      nativeMessagingObservers: observeNativeMessagingHost
    }),
    launchFirefoxExtension({
      extensionPaths: [extensionPath],
      headless: true,
      nativeMessagingHosts: nativeMessagingHosts('Second worker host'),
      nativeMessagingObservers: observeNativeMessagingHost
    })
  ])
  const [firstResult, secondResult] = launches
  if (firstResult.status === 'rejected' || secondResult.status === 'rejected') {
    await Promise.allSettled(
      [firstResult, secondResult].flatMap((result) =>
        result.status === 'fulfilled' ? [result.value.close()] : []
      )
    )
    if (firstResult.status === 'rejected') throw firstResult.reason
    if (secondResult.status === 'rejected') throw secondResult.reason
  }

  const first = firstResult.value
  const second = secondResult.value
  let firstClosed = false
  let secondClosed = false
  const pids: number[] = []
  try {
    const firstSessionPromise = first.nativeMessaging.waitForSession(nativeHostName, {
      timeout: 5_000
    })
    const secondSessionPromise = second.nativeMessaging.waitForSession(nativeHostName, {
      timeout: 5_000
    })
    const [firstResponse, secondResponse, firstSession, secondSession] = await Promise.all([
      sendNativeMessage(first.extensions.values().next().value!, { worker: 'first' }),
      sendNativeMessage(second.extensions.values().next().value!, { worker: 'second' }),
      firstSessionPromise,
      secondSessionPromise
    ])
    pids.push(firstResponse.pid, secondResponse.pid)
    expect(firstResponse.description).toBe('First worker host')
    expect(secondResponse.description).toBe('Second worker host')
    expect(firstResponse.manifestPath).toContain(first.userDataDir)
    expect(secondResponse.manifestPath).toContain(second.userDataDir)
    expect(firstResponse.manifestPath).not.toBe(secondResponse.manifestPath)
    expect(firstResponse.pid).not.toBe(secondResponse.pid)
    expect(firstSession.hostName).toBe(nativeHostName)
    expect(secondSession.hostName).toBe(nativeHostName)
    expect(firstSession.pid).toBe(firstResponse.pid)
    expect(secondSession.pid).toBe(secondResponse.pid)
    const [firstInput, firstOutput, secondInput, secondOutput] = await Promise.all([
      firstSession.waitForMessage({ direction: 'stdin', timeout: 5_000 }),
      firstSession.waitForMessage({ direction: 'stdout', timeout: 5_000 }),
      secondSession.waitForMessage({ direction: 'stdin', timeout: 5_000 }),
      secondSession.waitForMessage({ direction: 'stdout', timeout: 5_000 })
    ])
    expect(firstInput.message).toEqual({ worker: 'first' })
    expect(firstOutput.message).toEqual(firstResponse)
    expect(secondInput.message).toEqual({ worker: 'second' })
    expect(secondOutput.message).toEqual(secondResponse)

    await Promise.all([
      waitForHostExit(firstResponse.pid),
      waitForHostExit(secondResponse.pid),
      firstSession.waitForExit({ timeout: 5_000 }),
      secondSession.waitForExit({ timeout: 5_000 })
    ])
    await first.close()
    firstClosed = true
    await second.close()
    secondClosed = true
  } finally {
    await Promise.allSettled([
      firstClosed ? Promise.resolve() : first.close(),
      secondClosed ? Promise.resolve() : second.close()
    ])
    await Promise.all(pids.map((pid) => rm(stoppedMarker(pid), { force: true })))
  }
})
