#!/usr/bin/env node
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const manifestPath = process.argv[2]
if (!manifestPath) throw new Error('Firefox did not pass the native host manifest path')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const stoppedMarker = join(tmpdir(), `openpolyfill-native-host-${process.pid}.stopped`)
try {
  unlinkSync(stoppedMarker)
} catch {}
process.on('exit', () => writeFileSync(stoppedMarker, String(process.pid)))

let pending = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk])
  while (pending.length >= 4) {
    const messageLength = pending.readUInt32LE(0)
    if (pending.length < messageLength + 4) return
    const messageBytes = pending.subarray(4, messageLength + 4)
    pending = pending.subarray(messageLength + 4)
    const response = Buffer.from(
      JSON.stringify({
        message: JSON.parse(messageBytes.toString('utf8')),
        pid: process.pid,
        manifestPath,
        description: manifest.description,
        extensionId: process.argv[3]
      }),
      'utf8'
    )
    const length = Buffer.alloc(4)
    length.writeUInt32LE(response.length)
    process.stdout.write(Buffer.concat([length, response]))
  }
})
