import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'

type ExtensionManifest = Record<string, unknown>

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export async function readExtensionManifest(path: string): Promise<ExtensionManifest> {
  let raw: string
  try {
    raw = await readFile(join(path, 'manifest.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error
    const archive = await JSZip.loadAsync(await readFile(path))
    const manifest = archive.file('manifest.json')
    if (!manifest) throw new Error(`Packed extension ${path} has no manifest.json`)
    raw = await manifest.async('string')
  }
  const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''))
  const manifest = record(parsed)
  if (!manifest) throw new Error('Extension manifest must be a JSON object')
  return manifest
}
