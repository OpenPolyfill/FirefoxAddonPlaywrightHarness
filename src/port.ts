import { rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const lockDir = join(tmpdir(), 'firefox-addon-playwright-harness-rdp-locks')
const held = new Set<string>()

export async function acquireRdpPort(): Promise<{ port: number; release: () => Promise<void> }> {
  await mkdir(lockDir, { recursive: true })
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await freePort()
    const lock = join(lockDir, `${port}.lock`)
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx' })
      held.add(lock)
      let released = false
      return {
        port,
        release: async () => {
          if (released) return
          released = true
          held.delete(lock)
          await rm(lock, { force: true })
        }
      }
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('Unable to reserve an RDP port')
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

process.once('exit', () => {
  for (const lock of held) {
    try {
      rmSync(lock, { force: true })
    } catch {
      /* best effort */
    }
  }
})
