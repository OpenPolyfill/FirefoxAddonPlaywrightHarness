if (location.hash === '#harness-diagnostics') {
  console.error('DIAGNOSTIC_CONTENT_CONSOLE')
  setTimeout(() => {
    throw new Error('DIAGNOSTIC_CONTENT_EXCEPTION')
  }, 0)
}
