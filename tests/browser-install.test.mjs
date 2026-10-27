import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import test from 'node:test'
import { firefox } from '@playwright/test'
import { ensureFirefoxInstalled, resolveFirefoxBrowsersPath } from '../dist/browser-install.js'

function withEnvironment(values, run) {
  const previous = new Map()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('uses the platform-specific OpenPolyfill cache directory by default', () => {
  withEnvironment(
    {
      OPENPOLYFILL_BROWSERS_PATH: undefined,
      INIT_CWD: undefined,
      XDG_CACHE_HOME: undefined,
      LOCALAPPDATA: undefined
    },
    () => {
      const expectedBase =
        process.platform === 'linux'
          ? join(homedir(), '.cache')
          : process.platform === 'darwin'
            ? join(homedir(), 'Library', 'Caches')
            : join(homedir(), 'AppData', 'Local')
      assert.equal(resolveFirefoxBrowsersPath(), join(expectedBase, 'openpolyfill'))
    }
  )
})

test('uses the Playwright-style environment overrides for absolute and relative paths', () => {
  const invocationDirectory = resolve('openpolyfill-invocation-directory')
  withEnvironment(
    {
      OPENPOLYFILL_BROWSERS_PATH: join(invocationDirectory, 'custom-cache'),
      INIT_CWD: invocationDirectory
    },
    () => assert.equal(resolveFirefoxBrowsersPath(), join(invocationDirectory, 'custom-cache'))
  )
  withEnvironment(
    { OPENPOLYFILL_BROWSERS_PATH: 'relative-cache', INIT_CWD: invocationDirectory },
    () => assert.equal(resolveFirefoxBrowsersPath(), join(invocationDirectory, 'relative-cache'))
  )
})
test('does not change Playwright browser-cache configuration', () => {
  const playwrightBrowsersPath = '/playwright/browser-cache'
  withEnvironment(
    {
      OPENPOLYFILL_BROWSERS_PATH: 'openpolyfill-cache',
      PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
      INIT_CWD: '/openpolyfill-working-directory'
    },
    () => {
      assert.equal(
        resolveFirefoxBrowsersPath(),
        resolve('/openpolyfill-working-directory', 'openpolyfill-cache')
      )
      assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, playwrightBrowsersPath)
    }
  )
})
test('reuses the in-process Firefox registry without spawning a subprocess', async () => {
  const cachePath = await mkdtemp(join(tmpdir(), 'openpolyfill-registry-test-'))
  const require = createRequire(import.meta.url)
  const registry = require('playwright-core/lib/coreBundle').registry.registry
  const firefoxExecutable = registry.findExecutable('firefox')
  assert.ok(firefoxExecutable)

  const firefoxDirectory = join(cachePath, basename(firefoxExecutable.directory))
  const executablePath = join(
    firefoxDirectory,
    relative(firefoxExecutable.directory, firefoxExecutable.executablePath())
  )
  await mkdir(dirname(executablePath), { recursive: true })
  await writeFile(executablePath, 'test executable')
  await writeFile(join(firefoxDirectory, 'INSTALLATION_COMPLETE'), '')

  const childProcess = require('node:child_process')
  const childProcessMethods = [
    'fork',
    'spawn',
    'exec',
    'execFile',
    'spawnSync',
    'execSync',
    'execFileSync'
  ]
  const originalMethods = new Map(
    childProcessMethods.map((method) => [method, childProcess[method]])
  )
  const previousEnvironment = new Map(
    ['OPENPOLYFILL_BROWSERS_PATH', 'PLAYWRIGHT_BROWSERS_PATH'].map((key) => [key, process.env[key]])
  )
  const subprocessCalls = []
  try {
    process.env.OPENPOLYFILL_BROWSERS_PATH = cachePath
    for (const method of childProcessMethods) {
      childProcess[method] = () => {
        subprocessCalls.push(method)
        throw new Error(`Unexpected subprocess via child_process.${method}`)
      }
    }

    const defaultFirefoxPath = firefox.executablePath()
    const installedPath = await ensureFirefoxInstalled({ patchFirefox: false })
    assert.equal(installedPath, executablePath)
    assert.equal(firefox.executablePath(), defaultFirefoxPath)
    assert.equal(
      process.env.PLAYWRIGHT_BROWSERS_PATH,
      previousEnvironment.get('PLAYWRIGHT_BROWSERS_PATH')
    )
    assert.deepEqual(subprocessCalls, [])
  } finally {
    for (const [method, implementation] of originalMethods) childProcess[method] = implementation
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(cachePath, { recursive: true, force: true })
  }
})

test('uses the Playwright package-local convention for the special 0 value', () => {
  withEnvironment({ OPENPOLYFILL_BROWSERS_PATH: '0' }, () => {
    assert.equal(resolveFirefoxBrowsersPath(), '0')
  })
})
