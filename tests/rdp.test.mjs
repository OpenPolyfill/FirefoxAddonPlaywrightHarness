import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { RdpEvaluation, FirefoxRdpSession } from '../dist/rdp.js'

function evaluationClient(call) {
  const rdp = new EventEmitter()
  rdp.requestTimeoutMs = 1000
  const consoleActor = { actorId: 'console-a', call }
  return { rdp, evaluation: new RdpEvaluation(rdp, consoleActor) }
}

function result(from, value) {
  return {
    from,
    type: 'evaluationResult',
    resultID: 'result-1',
    result: JSON.stringify({ __ok__: true, __value__: value })
  }
}

test('ignores other console actors even when their result IDs collide', async () => {
  const { rdp, evaluation } = evaluationClient(async () => {
    rdp.emit('packet', result('console-b', 'wrong context'))
    rdp.emit('packet', result('console-a', 'selected context'))
    return { resultID: 'result-1' }
  })
  try {
    assert.equal(await evaluation.evaluate('document.title'), 'selected context')
  } finally {
    evaluation.dispose()
  }
})

test('disposal rejects pending and queued evaluations and prevents future requests', async () => {
  let requests = 0
  const { rdp, evaluation } = evaluationClient(async () => {
    requests++
    return { resultID: 'result-1' }
  })
  const pending = assert.rejects(evaluation.evaluate('pending'), /disposed/)
  const queued = assert.rejects(evaluation.evaluate('queued'), /disposed/)
  await setImmediate()
  evaluation.dispose()
  evaluation.dispose()
  await Promise.all([pending, queued])
  await assert.rejects(evaluation.evaluate('after disposal'), /disposed/)
  assert.equal(requests, 1)
  assert.equal(rdp.listenerCount('packet'), 0)
  assert.equal(rdp.listenerCount('close'), 0)
})

test('connection closure cancels an evaluation whose request has not acknowledged', async () => {
  const { rdp, evaluation } = evaluationClient(() => new Promise(() => {}))
  const rejected = assert.rejects(evaluation.evaluate('pending acknowledgement'), /disposed/)
  await setImmediate()
  rdp.emit('close')
  await rejected
  assert.equal(rdp.listenerCount('packet'), 0)
})

function targetClient() {
  const rdp = new EventEmitter()
  const actors = new Map()
  rdp.specs = { windowGlobalTarget: { events: {} } }
  rdp.actor = (id) => actors.get(id) ?? { actorId: id }
  rdp.track = (actor) => {
    actors.set(actor.actorId, actor)
    return actor
  }
  rdp.close = () => rdp.emit('close')
  return rdp
}

test('destroyed targets cannot satisfy future waits and new targets remain discoverable', async () => {
  const rdp = targetClient()
  const session = new FirefoxRdpSession(rdp, 'addons')
  rdp.emit('packet', { type: 'target-available-form', target: { actor: 'old-target' } })
  assert.equal((await session.waitForTarget(() => true)).actorId, 'old-target')
  rdp.emit('packet', { type: 'target-destroyed-form', target: { actor: 'old-target' } })
  const waiting = session.waitForTarget(() => true)
  rdp.emit('packet', { type: 'target-available-form', target: { actor: 'new-target' } })
  assert.equal((await waiting).actorId, 'new-target')
  assert.deepEqual(
    session.targets.map((target) => target.actorId),
    ['new-target']
  )
  session.close()
})

test('closing a session rejects outstanding target waits and removes its listeners', async () => {
  const rdp = targetClient()
  const session = new FirefoxRdpSession(rdp, 'addons')
  const rejected = assert.rejects(
    session.waitForTarget(() => true),
    /session is closed/
  )
  rdp.emit('close')
  await rejected
  await assert.rejects(
    session.waitForTarget(() => true),
    /session is closed/
  )
  assert.equal(rdp.listenerCount('packet'), 0)
  assert.equal(rdp.listenerCount('close'), 0)
})
