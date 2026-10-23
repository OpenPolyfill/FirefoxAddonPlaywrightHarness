import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeMessagingSession } from '../dist/native-messaging-observer.js'

const retainedMessageLimit = 256

function nativeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32LE(payload.length)
  return Buffer.concat([length, payload])
}

test('bounds retained Native Messaging history and deferred message waits', async () => {
  const session = new NativeMessagingSession('org.example.test', 123, 456)
  session._markStarted()

  for (let id = 0; id < retainedMessageLimit + 44; id++) {
    session._receive('stdin', nativeFrame({ id }))
  }

  assert.equal(session.messages.length, retainedMessageLimit)
  assert.equal(session.messages[0]?.message.id, 44)
  assert.equal(session.messages.at(-1)?.message.id, retainedMessageLimit + 43)

  const receivedIds = []
  for (let count = 0; count < retainedMessageLimit; count++) {
    const { message } = await session.waitForMessage({ direction: 'stdin' })
    receivedIds.push(message.id)
  }
  assert.deepEqual(
    receivedIds,
    Array.from({ length: retainedMessageLimit }, (_, index) => index + 44)
  )
})
