import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { resolveFirefoxBrowsersPath } from '../dist/browser-install.js'

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

test('uses the Playwright package-local convention for the special 0 value', () => {
  withEnvironment({ OPENPOLYFILL_BROWSERS_PATH: '0' }, () => {
    assert.equal(resolveFirefoxBrowsersPath(), '0')
  })
})
