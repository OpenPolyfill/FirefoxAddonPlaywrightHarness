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
  bridgeScript: string
): Promise<string> {
  const manifest = await readExtensionManifest(extensionPath)
  const contentScripts = manifest.content_scripts
  if (contentScripts !== undefined && !Array.isArray(contentScripts)) {
    throw new Error('Extension manifest content_scripts must be an array')
  }
  const entries = (contentScripts ?? []) as unknown[]
  for (const contentScript of entries) {
    const entry = record(contentScript)
    if (!entry) throw new Error('Extension manifest content_scripts entries must be objects')
    const scripts = entry.js
    if (
      scripts !== undefined &&
      (!Array.isArray(scripts) || !scripts.every((file) => typeof file === 'string'))
    ) {
      throw new Error('Extension manifest content_scripts js entries must be strings')
    }
  }

  const bridgeFilename = `__playwright_closed_shadow_${randomUUID()}.js`
  const bridgeEntry: Record<string, unknown> = {
    matches: ['<all_urls>'],
    js: [bridgeFilename],
    run_at: 'document_start',
    all_frames: true,
    match_about_blank: true
  }
  if (manifest.manifest_version === 3) bridgeEntry.world = 'ISOLATED'
  manifest.content_scripts = [bridgeEntry, ...entries]

  const serializedManifest = JSON.stringify(manifest, null, 2)
  if ((await stat(extensionPath)).isDirectory()) {
    const stagedPath = join(stagingDirectory, 'extension')
    await cp(extensionPath, stagedPath, { recursive: true })
    await Promise.all([
      writeFile(join(stagedPath, 'manifest.json'), serializedManifest),
      writeFile(join(stagedPath, bridgeFilename), bridgeScript)
    ])
    return stagedPath
  }

  const archive = await JSZip.loadAsync(await readFile(extensionPath))
  if (!archive.file('manifest.json'))
    throw new Error(`Packed extension ${extensionPath} has no manifest.json`)
  archive.file('manifest.json', serializedManifest)
  archive.file(bridgeFilename, bridgeScript)
  const stagedPath = join(stagingDirectory, 'extension.xpi')
  await writeFile(stagedPath, await archive.generateAsync({ type: 'nodebuffer' }))
  return stagedPath
}
