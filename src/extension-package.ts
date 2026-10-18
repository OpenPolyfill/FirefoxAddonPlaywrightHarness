import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

export async function createClosedShadowBridgeExtension(
  profileDirectory: string,
  bridgeScript: string
): Promise<string> {
  const extensionId = `${randomUUID()}@openpolyfill.test`
  const bridgeDirectory = join(profileDirectory, 'closed-shadow-bridge')
  const bridgeFilename = 'bridge.js'
  const manifest = {
    manifest_version: 3,
    name: 'Firefox Playwright Closed Shadow Bridge',
    version: '1.0',
    browser_specific_settings: { gecko: { id: extensionId } },
    content_scripts: [
      {
        matches: ['<all_urls>'],
        js: [bridgeFilename],
        run_at: 'document_start',
        all_frames: true,
        match_about_blank: true,
        world: 'ISOLATED'
      }
    ]
  }
  await mkdir(bridgeDirectory, { recursive: true })
  await Promise.all([
    writeFile(join(bridgeDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2)),
    writeFile(join(bridgeDirectory, bridgeFilename), bridgeScript)
  ])
  return bridgeDirectory
}
