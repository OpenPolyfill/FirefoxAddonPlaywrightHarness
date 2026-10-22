export type UnifiedPatchState = 'unpatched' | 'patched'

export interface UnifiedPatchResult {
  state: UnifiedPatchState
  files: Record<string, string>
}

export function getPatchPaths(patchText: string, description?: string): string[]
export function applyUnifiedPatchSet(
  sources: Record<string, string>,
  patchText: string,
  description: string
): UnifiedPatchResult
export function atomicWrite(path: string, contents: string | Uint8Array): Promise<void>
