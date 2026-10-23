import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { FirefoxErrorDiagnostics } from '../dist/diagnostics.js'

class FakeConsole extends EventEmitter {
  async call(method) {
    if (method === 'getCachedMessages') return { messages: [] }
    return {}
  }
}

class FakeTarget {
  constructor(actorId, form, consoleActor) {
    this.actorId = actorId
    this.form = form
    this.consoleActor = consoleActor
  }

  console() {
    return this.consoleActor
  }
}

function makeTarget(actorId, form) {
  const consoleActor = new FakeConsole()
  return { target: new FakeTarget(actorId, form, consoleActor), consoleActor }
}

function makeSession(targets, chromeTarget) {
  return { rdp: new EventEmitter(), targets, chromeTarget }
}

test('collects background, content-script, and browser-chrome errors with source details', async () => {
  const background = makeTarget('background', {
    addonId: 'diagnostics@example.test',
    url: 'moz-extension://uuid/background.html',
    consoleActor: 'background-console'
  })
  const content = makeTarget('content', {
    url: 'https://example.test/',
    consoleActor: 'content-console'
  })
  const chrome = makeTarget('chrome', {
    url: 'chrome://browser/content/browser.xhtml',
    consoleActor: 'chrome-console'
  })
  const session = makeSession([background.target, content.target, chrome.target], chrome.target)
  const diagnostics = new FirefoxErrorDiagnostics(session, 'diagnostics@example.test')
  try {
    await diagnostics.start()
    const backgroundPacket = {
      pageError: {
        errorMessage: 'background exception',
        sourceName: 'moz-extension://uuid/background.js',
        stacktrace: [{ functionName: 'run', filename: 'background.js', lineNumber: 4 }],
        timeStamp: Date.now()
      }
    }
    content.consoleActor.emit('pageError', backgroundPacket)
    background.consoleActor.emit('pageError', backgroundPacket)
    background.consoleActor.emit('pageError', backgroundPacket)
    content.consoleActor.emit('consoleAPICall', {
      message: {
        level: 'error',
        arguments: [
          {
            class: 'Error',
            preview: {
              kind: 'Error',
              name: 'TypeError',
              message: 'content error',
              stack: ['TypeError: content error', '    at content.js:8'].join(
                String.fromCharCode(10)
              )
            }
          }
        ],
        filename: 'moz-extension://uuid/content.js'
      }
    })
    chrome.consoleActor.emit('pageError', {
      pageError: {
        errorMessage: 'chrome exception',
        sourceName: 'chrome://browser/content/browser.js'
      }
    })
    content.consoleActor.emit('consoleAPICall', {
      message: { level: 'warn', arguments: ['not collected'] }
    })

    const entries = diagnostics.snapshot().entries
    assert.deepEqual(
      entries.map(({ executionContext, message }) => [executionContext, message]),
      [
        ['extension background', 'background exception'],
        ['content script', 'TypeError: content error'],
        ['browser chrome', 'chrome exception']
      ]
    )
    assert.equal(entries[0].extensionId, 'diagnostics@example.test')
    assert.equal(entries[0].sourceURL, 'moz-extension://uuid/background.js')
    assert.match(entries[0].stackTrace, /run \(background\.js:4\)/)
    assert.match(entries[1].stackTrace, /content[.]js:8/)
    assert.ok(entries[0].timestamp)
  } finally {
    await diagnostics.close()
  }
})

test('bounds storage, resets between tests, and removes RDP listeners on close', async () => {
  const chrome = makeTarget('chrome', {
    url: 'chrome://browser/content/browser.xhtml',
    consoleActor: 'chrome-console'
  })
  const session = makeSession([chrome.target], chrome.target)
  const diagnostics = new FirefoxErrorDiagnostics(session)
  await diagnostics.start()

  chrome.consoleActor.emit('pageError', {
    pageError: { errorMessage: 'startup diagnostic', sourceName: 'chrome://startup.js' }
  })
  diagnostics.beginTest()
  assert.equal(diagnostics.snapshot().entries.length, 1)
  diagnostics.endTest()
  chrome.consoleActor.emit('pageError', {
    pageError: { errorMessage: 'between tests', sourceName: 'chrome://idle.js' }
  })
  diagnostics.beginTest()
  assert.equal(diagnostics.snapshot().entries.length, 0)

  for (let index = 0; index < 501; index++) {
    chrome.consoleActor.emit('pageError', {
      pageError: { errorMessage: `diagnostic ${index}`, sourceName: 'chrome://test.js' }
    })
  }
  assert.equal(diagnostics.snapshot().entries.length, 500)
  assert.equal(diagnostics.snapshot().droppedCount, 1)
  assert.equal(session.rdp.listenerCount('packet'), 1)

  await diagnostics.close()
  assert.equal(session.rdp.listenerCount('packet'), 0)
  assert.equal(chrome.consoleActor.listenerCount('pageError'), 0)
  assert.equal(chrome.consoleActor.listenerCount('consoleAPICall'), 0)
})

test('closes promptly when a vanished target never answers', async () => {
  const vanished = makeTarget('vanished', {
    url: 'https://example.test/',
    consoleActor: 'vanished-console'
  })
  const call = vanished.consoleActor.call.bind(vanished.consoleActor)
  vanished.consoleActor.call = (method, params) =>
    method === 'stopListeners' ? new Promise(() => {}) : call(method, params)
  const diagnostics = new FirefoxErrorDiagnostics(makeSession([vanished.target]))
  await diagnostics.start()
  const started = Date.now()
  await diagnostics.close()
  assert.ok(Date.now() - started < 5000, 'close() waited for an actor that never answers')
})
