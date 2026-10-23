import { constants } from 'node:fs'
import { access, mkdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FirefoxRDP, TargetFront } from '@openpolyfill/firefox-rdp'
import { RdpEvaluation } from './rdp.js'
import type { NativeMessagingHostConfig } from './types.js'
declare const Cc: Record<
  string,
  { createInstance(iid: unknown): { initWithPath(path: string): void } }
>
declare const Ci: { nsIFile: unknown }
declare const Services: {
  dirsvc: {
    set(name: string, file: unknown): void
    get(name: string, iid: unknown): { path: string }
  }
}
declare const ChromeUtils: {
  importESModule(path: string): {
    NativeManifests: {
      _initializePromise: Promise<unknown> | null
      init(): Promise<unknown>
    }
  }
}

const nativeHostNamePattern = /^\w+(?:\.\w+)*$/

export async function prepareNativeMessagingHosts(
  userDataDir: string,
  hosts: Record<string, NativeMessagingHostConfig> | undefined
): Promise<string | undefined> {
  if (!hosts || Object.keys(hosts).length === 0) return undefined
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error(
      'Harness native messaging hosts require Linux or macOS directory-based manifests'
    )
  }

  const manifestBaseDir = join(userDataDir, 'native-messaging')
  const manifestDirectory = join(
    manifestBaseDir,
    process.platform === 'linux' ? 'native-messaging-hosts' : 'NativeMessagingHosts'
  )
  await mkdir(manifestDirectory, { recursive: true, mode: 0o700 })

  for (const [name, host] of Object.entries(hosts)) {
    if (!nativeHostNamePattern.test(name)) {
      throw new Error(`Invalid Firefox native messaging host name: ${name}`)
    }
    if (!host || typeof host.executable !== 'string' || host.executable.trim() === '') {
      throw new Error(`nativeMessagingHosts['${name}'].executable must be a file path`)
    }
    if (
      !Array.isArray(host.allowedExtensions) ||
      host.allowedExtensions.length === 0 ||
      host.allowedExtensions.some((id) => typeof id !== 'string' || id.trim() === '')
    ) {
      throw new Error(
        `nativeMessagingHosts['${name}'].allowedExtensions must contain extension IDs`
      )
    }
    if (host.description !== undefined && typeof host.description !== 'string') {
      throw new Error(`nativeMessagingHosts['${name}'].description must be a string`)
    }

    const executable = resolve(host.executable)
    try {
      const executableInfo = await stat(executable)
      if (!executableInfo.isFile()) throw new Error('not a file')
      await access(executable, constants.X_OK)
    } catch (error) {
      throw new Error(
        `Native messaging host executable is missing or not executable: ${executable}`,
        {
          cause: error
        }
      )
    }

    const manifest = {
      name,
      description: host.description?.trim() || name,
      path: executable,
      type: 'stdio',
      allowed_extensions: [...host.allowedExtensions]
    }
    await writeFile(
      join(manifestDirectory, `${name}.json`),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 }
    )
  }

  return manifestBaseDir
}

export async function configureNativeMessagingDirectory(
  rdp: FirefoxRDP,
  chromeTarget: TargetFront,
  manifestBaseDir: string
): Promise<void> {
  const consoleActor = chromeTarget.console()
  await consoleActor.call('startListeners', { listeners: ['evaluationResult'] })
  const evaluation = new RdpEvaluation(rdp, consoleActor)
  let configuredPath: string
  try {
    configuredPath = await evaluation.evaluate<string>(
      (...args: unknown[]) => {
        const directoryPath = args[0]
        if (typeof directoryPath !== 'string')
          throw new Error('Native manifest directory path is missing')
        const localFileClass = Cc['@mozilla.org/file/local;1']
        if (!localFileClass) throw new Error('Firefox local file service is unavailable')
        const manifestDirectory = localFileClass.createInstance(Ci.nsIFile)
        manifestDirectory.initWithPath(directoryPath)
        Services.dirsvc.set('XREUserNativeManifests', manifestDirectory)

        const { NativeManifests } = ChromeUtils.importESModule(
          'resource://gre/modules/NativeManifests.sys.mjs'
        )
        if (NativeManifests._initializePromise) {
          throw new Error(
            'NativeManifests initialized before the harness set its isolated directory'
          )
        }
        const configuredDirectory = Services.dirsvc.get('XREUserNativeManifests', Ci.nsIFile).path
        if (configuredDirectory !== directoryPath) {
          throw new Error(`Firefox kept the native manifest directory at ${configuredDirectory}`)
        }
        return NativeManifests.init().then(
          () => Services.dirsvc.get('XREUserNativeManifests', Ci.nsIFile).path
        )
      },
      [manifestBaseDir]
    )
  } finally {
    evaluation.dispose()
  }
  if (configuredPath !== manifestBaseDir) {
    throw new Error(
      `Firefox initialized native manifests from an unexpected directory: ${configuredPath}`
    )
  }
}
