import { access, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function nativeMessagingHosts(description: string) {
  return {
    [nativeHostName]: {
      executable: nativeHostExecutable,
      description,
      allowedExtensions: [nativeExtensionId]
    }
  }
}

const workerTest = createFirefoxFixtures(baseTest, {
  extensionPath,
  headless: true,
  contextScope: 'worker',
  nativeMessagingHosts: nativeMessagingHosts('Worker-scoped native host')
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

workerTest(
  'discovers its isolated manifest and supports sendNativeMessage',
  async ({ context, extension }) => {
    const manifestDirectory = nativeManifestDirectory(context)
    const manifestPath = join(manifestDirectory, `${nativeHostName}.json`)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({
      name: nativeHostName,
      type: 'stdio',
      allowed_extensions: [nativeExtensionId],
      path: nativeHostExecutable
    })

    let pid: number | undefined
    try {
      const response = await sendNativeMessage(extension, { text: 'one-shot' })
      pid = response.pid
      expect(response).toMatchObject({
        message: { text: 'one-shot' },
        description: 'Worker-scoped native host',
        extensionId: nativeExtensionId,
        manifestPath
      })
      await waitForHostExit(response.pid)
    } finally {
      if (pid !== undefined) await rm(stoppedMarker(pid), { force: true })
    }
  }
)

workerTest(
  'keeps connectNative open for multiple bidirectional messages',
  async ({ extension }) => {
    if (!extension.background)
      throw new Error('Native messaging extension has no background context')
    const replies = await extension.background.evaluate<
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

    expect(replies.map(({ message }) => message)).toEqual([{ text: 'first' }, { text: 'second' }])
    expect(replies[1].pid).toBe(replies[0].pid)
    expect(replies[1].manifestPath).toBe(replies[0].manifestPath)
    try {
      await waitForHostExit(replies[0].pid)
    } finally {
      await rm(stoppedMarker(replies[0].pid), { force: true })
    }
  }
)

baseTest('fixture teardown stops an open native host and removes private manifests', async () => {
  const running = await launchFirefoxExtension({
    extensionPath,
    headless: true,
    nativeMessagingHosts: nativeMessagingHosts('Teardown native host')
  })
  let pid: number | undefined
  let closed = false
  try {
    if (!running.extension.background)
      throw new Error('Native messaging extension has no background context')
    const response = await running.extension.background
      .evaluate<NativeHostReply>(`(() => new Promise(resolve => {
      const port = browser.runtime.connectNative(${JSON.stringify(nativeHostName)});
      globalThis.__harnessOpenNativePort = port;
      port.onMessage.addListener(resolve);
      port.postMessage({ text: 'keep-alive' });
    }))()`)
    pid = response.pid
    expect(response.message).toEqual({ text: 'keep-alive' })
    await expect(access(stoppedMarker(pid))).rejects.toThrow()

    await running.close()
    closed = true
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
      extensionPath,
      headless: true,
      nativeMessagingHosts: nativeMessagingHosts('First worker host')
    }),
    launchFirefoxExtension({
      extensionPath,
      headless: true,
      nativeMessagingHosts: nativeMessagingHosts('Second worker host')
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
    const [firstResponse, secondResponse] = await Promise.all([
      sendNativeMessage(first.extension, { worker: 'first' }),
      sendNativeMessage(second.extension, { worker: 'second' })
    ])
    pids.push(firstResponse.pid, secondResponse.pid)
    expect(firstResponse.description).toBe('First worker host')
    expect(secondResponse.description).toBe('Second worker host')
    expect(firstResponse.manifestPath).toContain(first.userDataDir)
    expect(secondResponse.manifestPath).toContain(second.userDataDir)
    expect(firstResponse.manifestPath).not.toBe(secondResponse.manifestPath)
    expect(firstResponse.pid).not.toBe(secondResponse.pid)

    await Promise.all([waitForHostExit(firstResponse.pid), waitForHostExit(secondResponse.pid)])
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
