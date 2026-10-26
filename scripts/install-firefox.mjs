import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const patchFirefox = process.env.OPENPOLYFILL_INSTALL_PATCH_FIREFOX === '1'

async function main() {
  const { registry: registryModule } = require('playwright-core/lib/coreBundle')
  const registry = registryModule?.registry
  if (
    !registry ||
    typeof registry.findExecutable !== 'function' ||
    typeof registry.install !== 'function'
  ) {
    throw new Error(
      'The installed Playwright version does not expose the browser registry installer required by the Firefox harness'
    )
  }

  const firefox = registry.findExecutable('firefox')
  if (!firefox || typeof firefox._install !== 'function') {
    throw new Error(
      'The installed Playwright version does not provide its Firefox browser installer'
    )
  }

  const executablePath = firefox.executablePath()
  const install = firefox._install
  firefox._install = async (force) => {
    await install(force)
    try {
      await access(executablePath)
    } catch (error) {
      throw Object.assign(
        new Error(`Playwright Firefox installation is incomplete: ${executablePath}`, {
          cause: error
        }),
        { code: 'OPENPOLYFILL_INCOMPLETE_FIREFOX_INSTALL' }
      )
    }
    if (patchFirefox) {
      const { applyFirefoxPatchesForExecutable } = await import('../dist/patch.js')
      await applyFirefoxPatchesForExecutable(executablePath)
    }
  }

  try {
    await registry.install([firefox], { gc: false })
  } catch (error) {
    if (error?.code !== 'OPENPOLYFILL_INCOMPLETE_FIREFOX_INSTALL') throw error
    await registry.install([firefox], { force: true, gc: false })
  }
  await access(executablePath)
  return executablePath
}

function reply(message) {
  if (typeof process.send === 'function') {
    process.send(message, () => process.disconnect())
    return
  }
  if (message.type === 'error') console.error(message.stack || message.message)
  else console.log(message.executablePath)
}

main().then(
  (executablePath) => reply({ type: 'complete', executablePath }),
  (error) => {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : undefined
    reply({ type: 'error', message, stack })
    process.exitCode = 1
  }
)
