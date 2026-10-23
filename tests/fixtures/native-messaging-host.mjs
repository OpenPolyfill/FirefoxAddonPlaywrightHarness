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
let responseQueue = Promise.resolve()

async function writeResponse(response, partialFrame) {
  const responseBytes = Buffer.from(JSON.stringify(response), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32LE(responseBytes.length)
  const frame = Buffer.concat([length, responseBytes])
  if (!partialFrame) {
    process.stdout.write(frame)
    return
  }
  for (const part of [frame.subarray(0, 2), frame.subarray(2, 4), frame.subarray(4)]) {
    process.stdout.write(part)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk])
  while (pending.length >= 4) {
    const messageLength = pending.readUInt32LE(0)
    if (pending.length < messageLength + 4) return
    const messageBytes = pending.subarray(4, messageLength + 4)
    pending = pending.subarray(messageLength + 4)
    const message = JSON.parse(messageBytes.toString('utf8'))
    if (typeof message?.stderr === 'string') process.stderr.write(message.stderr)
    const response = {
      message,
      pid: process.pid,
      manifestPath,
      description: manifest.description,
      extensionId: process.argv[3]
    }
    responseQueue = responseQueue.then(() =>
      writeResponse(response, message?.partialFrame === true)
    )
  }
})
