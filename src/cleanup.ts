import { rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative } from 'node:path'

const tracked = new Set<string>()
let exitHookInstalled = false

function safeTempPath(path: string): void {
  const root = tmpdir()
  if (!isAbsolute(path) || relative(root, path).startsWith('..')) {
    throw new Error(`Refusing to remove non-temporary path: ${path}`)
  }
}

export function trackTempDir(path: string): string {
  safeTempPath(path)
  tracked.add(path)
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.once('exit', () => {
      for (const item of tracked) {
        try {
          safeTempPath(item)
        } catch {
          continue
        }
        try {
          rmSync(item, { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
    })
  }
  return path
}

export async function removeTempDir(path?: string): Promise<void> {
  if (!path) return
  safeTempPath(path)
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } finally {
    tracked.delete(path)
  }
}

export async function bounded<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
