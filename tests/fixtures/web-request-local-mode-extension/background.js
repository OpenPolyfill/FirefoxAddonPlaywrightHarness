const mappedOrigin = 'https://web-request.localhost/'
const statusUrl = `${mappedOrigin}status`
const jsonUrl = `${mappedOrigin}json`
const contentTypeUrl = `${mappedOrigin}typed`
const pathUrl = `${mappedOrigin}path`
const payloadUrl = `${mappedOrigin}payload.bin`
const responseUrl = `${mappedOrigin}response`
const fulfilledUrls = [statusUrl, jsonUrl, contentTypeUrl, pathUrl, responseUrl]
const lifecycleEvents = [
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onSendHeaders',
  'onHeadersReceived',
  'onAuthRequired',
  'onBeforeRedirect',
  'onResponseStarted',
  'onCompleted',
  'onErrorOccurred'
]
const lifecycleExtraInfo = {
  onBeforeSendHeaders: ['requestHeaders'],
  onSendHeaders: ['requestHeaders'],
  onHeadersReceived: ['responseHeaders'],
  onAuthRequired: ['responseHeaders'],
  onBeforeRedirect: ['responseHeaders'],
  onResponseStarted: ['responseHeaders'],
  onCompleted: ['responseHeaders']
}

globalThis.localMappingsWebRequestObservations = {
  ordinary: [],
  events: [],
  registered: [],
  registrationErrors: [],
  blocking: [],
  responseHeaders: [],
  headerChanges: [],
  bodyStreams: [],
  byteChanges: [],
  streamStops: []
}

for (const eventName of lifecycleEvents) {
  try {
    const event = browser.webRequest[eventName]
    const listener = (details) => {
      const record = {
        event: eventName,
        url: details.url,
        requestId: details.requestId,
        type: details.type
      }
      if (details.redirectUrl !== undefined) record.redirectUrl = details.redirectUrl
      if (details.error !== undefined) record.error = details.error
      if (details.isProxy !== undefined) record.isProxy = details.isProxy
      if (details.challenger !== undefined) record.challenger = details.challenger
      if (details.scheme !== undefined) record.scheme = details.scheme
      if (details.realm !== undefined) record.realm = details.realm
      if (details.statusCode !== undefined) record.statusCode = details.statusCode
      if (details.statusLine !== undefined) record.statusLine = details.statusLine
      if (details.requestHeaders) {
        record.requestHeaders = details.requestHeaders.map(({ name, value }) => ({
          name: name.toLowerCase(),
          value: value ?? ''
        }))
      }
      if (details.responseHeaders) {
        record.responseHeaders = details.responseHeaders.map(({ name, value }) => ({
          name: name.toLowerCase(),
          value: value ?? ''
        }))
      }
      globalThis.localMappingsWebRequestObservations.events.push(record)
      if (eventName === 'onBeforeRequest') {
        globalThis.localMappingsWebRequestObservations.ordinary.push({
          url: details.url,
          type: details.type
        })
      }
      if (eventName === 'onHeadersReceived') {
        globalThis.localMappingsWebRequestObservations.responseHeaders.push({
          url: details.url,
          statusCode: details.statusCode,
          statusLine: details.statusLine,
          headers: record.responseHeaders ?? []
        })
      }
    }
    const filter = { urls: [`${mappedOrigin}*`] }
    const extraInfo = lifecycleExtraInfo[eventName]
    if (extraInfo) event.addListener(listener, filter, extraInfo)
    else event.addListener(listener, filter)
    globalThis.localMappingsWebRequestObservations.registered.push(eventName)
  } catch (error) {
    globalThis.localMappingsWebRequestObservations.registrationErrors.push({
      eventName,
      message: String(error)
    })
  }
}

try {
  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.url !== statusUrl) return {}
      let before
      const responseHeaders = (details.responseHeaders ?? []).map((header) => {
        if (header.name.toLowerCase() !== 'x-harness-response') return header
        before = header.value
        return { ...header, value: 'modified-by-webRequest' }
      })
      responseHeaders.push({ name: 'x-webrequest-blocking', value: 'changed' })
      globalThis.localMappingsWebRequestObservations.headerChanges.push({
        url: details.url,
        before,
        after: 'modified-by-webRequest'
      })
      return { responseHeaders }
    },
    { urls: [statusUrl] },
    ['blocking', 'responseHeaders']
  )
  globalThis.localMappingsWebRequestObservations.registered.push('onHeadersReceived.blocking')
} catch (error) {
  globalThis.localMappingsWebRequestObservations.registrationErrors.push({
    eventName: 'onHeadersReceived.blocking',
    message: String(error)
  })
}

try {
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      const shouldFilter =
        details.type === 'xmlhttprequest' && [...fulfilledUrls, payloadUrl].includes(details.url)
      if (!shouldFilter) return {}
      globalThis.localMappingsWebRequestObservations.blocking.push({
        url: details.url,
        type: details.type
      })
      const filter = browser.webRequest.filterResponseData(details.requestId)
      const bodyStream = { url: details.url, bytes: [] }
      globalThis.localMappingsWebRequestObservations.bodyStreams.push(bodyStream)
      let changed = false
      filter.ondata = ({ data }) => {
        const bytes = new Uint8Array(data)
        bodyStream.bytes.push(...bytes)
        if (details.url === payloadUrl && !changed && bytes.length > 0) {
          const before = bytes[0]
          bytes[0] = 0x5a
          globalThis.localMappingsWebRequestObservations.byteChanges.push({
            before,
            after: bytes[0]
          })
          changed = true
        }
        filter.write(bytes)
      }
      filter.onstop = () => {
        globalThis.localMappingsWebRequestObservations.streamStops.push(details.url)
        filter.close()
      }
      return {}
    },
    { urls: [`${mappedOrigin}*`] },
    ['blocking']
  )
  globalThis.localMappingsWebRequestObservations.registered.push('blocking.filterResponseData')
} catch (error) {
  globalThis.localMappingsWebRequestObservations.registrationErrors.push({
    eventName: 'blocking.filterResponseData',
    message: String(error)
  })
}
