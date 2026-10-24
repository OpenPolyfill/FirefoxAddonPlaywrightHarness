const mappedOrigin = 'https://web-request.localhost/'
const payloadUrl = `${mappedOrigin}payload.bin`

globalThis.localMappingsWebRequestObservations = {
  ordinary: [],
  blocking: [],
  byteChanges: [],
  streamStops: 0
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    globalThis.localMappingsWebRequestObservations.ordinary.push({
      url: details.url,
      type: details.type
    })
  },
  { urls: [`${mappedOrigin}*`] }
)

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    globalThis.localMappingsWebRequestObservations.blocking.push({
      url: details.url,
      type: details.type
    })
    const filter = browser.webRequest.filterResponseData(details.requestId)
    let changed = false
    filter.ondata = ({ data }) => {
      const bytes = new Uint8Array(data)
      if (!changed && bytes.length > 0) {
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
      globalThis.localMappingsWebRequestObservations.streamStops += 1
      filter.close()
    }
    return {}
  },
  { urls: [payloadUrl], types: ['xmlhttprequest'] },
  ['blocking']
)
