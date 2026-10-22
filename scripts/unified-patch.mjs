import { randomUUID } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { applyPatch, parsePatch, reversePatch } from 'diff'

const patchOptions = { fuzzFactor: 0, autoConvertLineEndings: true }

function normalizePatchPath(path) {
  if (!path || path === '/dev/null') throw new Error('Patch file path is missing')
  const normalized = path.replace(/^[ab]\//, '')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe path in unified patch: ${path}`)
  }
  return normalized
}

function getFilePath(filePatch) {
  const oldPath = normalizePatchPath(filePatch.oldFileName)
  const newPath = normalizePatchPath(filePatch.newFileName)
  if (oldPath !== newPath)
    throw new Error(`File rename in patch is not supported: ${oldPath} -> ${newPath}`)
  return newPath
}

function parsePatches(patchText, description) {
  let patches
  try {
    patches = parsePatch(patchText)
  } catch (error) {
    throw new Error(`Invalid ${description} unified patch`, { cause: error })
  }
  if (!patches.length) throw new Error(`${description} unified patch is empty`)
  return patches
}

export function getPatchPaths(patchText, description = 'package') {
  const paths = parsePatches(patchText, description).map(getFilePath)
  if (new Set(paths).size !== paths.length)
    throw new Error(`${description} unified patch contains duplicate file paths`)
  return paths
}

export function applyUnifiedPatchSet(sources, patchText, description) {
  const patches = parsePatches(patchText, description)
  const patchedFiles = Object.create(null)
  const states = []
  const seen = new Set()

  for (const filePatch of patches) {
    const path = getFilePath(filePatch)
    if (seen.has(path))
      throw new Error(`${description} unified patch contains duplicate path ${path}`)
    seen.add(path)
    if (!Object.hasOwn(sources, path))
      throw new Error(`${description} patch target was not loaded: ${path}`)

    const source = sources[path]
    const reverse = applyPatch(source, reversePatch(filePatch), patchOptions)
    if (reverse !== false && reverse !== source) {
      states.push({ path, state: 'patched' })
      patchedFiles[path] = source
      continue
    }

    const forward = applyPatch(source, filePatch, patchOptions)
    if (forward === false || forward === source) {
      throw new Error(
        `Incompatible or partially applied ${description} patch in ${path}; restore the unpatched target and reinstall the package`
      )
    }
    states.push({ path, state: 'unpatched' })
    patchedFiles[path] = forward
  }

  const uniqueStates = new Set(states.map(({ state }) => state))
  if (uniqueStates.size !== 1) {
    const details = states.map(({ path, state }) => `${path}: ${state}`).join(', ')
    throw new Error(`Partially applied ${description} patch set: ${details}`)
  }

  return { state: states[0].state, files: patchedFiles }
}

export async function atomicWrite(path, contents) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporaryPath, contents, { flag: 'wx' })
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch(() => {})
  }
}
