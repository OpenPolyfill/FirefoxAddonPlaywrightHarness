import { randomUUID } from 'node:crypto'
import { cp, readFile, stat, writeFile } from 'node:fs/promises'
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

export async function stageExtensionContentScripts(
  extensionPath: string,
  stagingDirectory: string,
  captureScript: string
): Promise<string> {
  const manifest = await readExtensionManifest(extensionPath)
  const contentScripts = manifest.content_scripts
  if (!Array.isArray(contentScripts) || contentScripts.length === 0) return extensionPath

  const entries: Array<{ manifest: Record<string, unknown>; scripts: string[] }> = []
  for (const contentScript of contentScripts) {
    const entry = record(contentScript)
    if (!entry) throw new Error('Extension manifest content_scripts entries must be objects')
    const scripts = entry.js
    if (scripts === undefined) continue
    if (!Array.isArray(scripts) || !scripts.every((file) => typeof file === 'string')) {
      throw new Error('Extension manifest content_scripts js entries must be strings')
    }
    if (scripts.length > 0) entries.push({ manifest: entry, scripts })
  }
  if (entries.length === 0) return extensionPath

  const bootstrapFilename = `__playwright_closed_shadow_${randomUUID()}.js`
  for (const { manifest: entry, scripts } of entries) entry.js = [bootstrapFilename, ...scripts]

  const serializedManifest = JSON.stringify(manifest, null, 2)
  if ((await stat(extensionPath)).isDirectory()) {
    const stagedPath = join(stagingDirectory, 'extension')
    await cp(extensionPath, stagedPath, { recursive: true })
    await Promise.all([
      writeFile(join(stagedPath, 'manifest.json'), serializedManifest),
      writeFile(join(stagedPath, bootstrapFilename), captureScript)
    ])
    return stagedPath
  }

  const archive = await JSZip.loadAsync(await readFile(extensionPath))
  if (!archive.file('manifest.json'))
    throw new Error(`Packed extension ${extensionPath} has no manifest.json`)
  archive.file('manifest.json', serializedManifest)
  archive.file(bootstrapFilename, captureScript)
  const stagedPath = join(stagingDirectory, 'extension.xpi')
  await writeFile(stagedPath, await archive.generateAsync({ type: 'nodebuffer' }))
  return stagedPath
}
