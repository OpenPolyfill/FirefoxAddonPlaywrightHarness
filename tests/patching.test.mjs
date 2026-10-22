import assert from 'node:assert/strict'
import test from 'node:test'
import { createPatch } from 'diff'
import { applyUnifiedPatchSet } from '../scripts/unified-patch.mjs'

const before = 'first line\nold value\nlast line\n'
const after = 'first line\nnew value\nlast line\n'
const patchText = createPatch('fixture.txt', before, after)

test('applies a unified patch once and recognizes the repeated application', () => {
  const applied = applyUnifiedPatchSet({ 'fixture.txt': before }, patchText, 'test')
  assert.equal(applied.state, 'unpatched')
  assert.equal(applied.files['fixture.txt'], after)

  const repeated = applyUnifiedPatchSet(applied.files, patchText, 'test')
  assert.equal(repeated.state, 'patched')
  assert.deepEqual(repeated.files, applied.files)
})

test('rejects incompatible patch sources', () => {
  assert.throws(
    () => applyUnifiedPatchSet({ 'fixture.txt': 'unrelated content\n' }, patchText, 'test'),
    /Incompatible or partially applied test patch/
  )
})

test('rejects a patch set split between original and patched files', () => {
  const secondBefore = 'second old\n'
  const secondAfter = 'second new\n'
  const patchSet = patchText + createPatch('second.txt', secondBefore, secondAfter)
  assert.throws(
    () =>
      applyUnifiedPatchSet({ 'fixture.txt': after, 'second.txt': secondBefore }, patchSet, 'test'),
    /Partially applied test patch set/
  )
})
