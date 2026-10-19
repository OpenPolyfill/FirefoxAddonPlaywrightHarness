export { launchFirefoxExtension } from './launch.js'
export { ensureFirefoxPatched, replaceExactlyOnce, PATCH_MARKER } from './patch.js'
export { createFirefoxFixtures } from './fixtures.js'
export type { FirefoxFixtures } from './fixtures.js'
export { FirefoxRdpSession, RdpEvaluation, RdpInspectedWindowEvaluation } from './rdp.js'
export type {
  ActionKind,
  EvaluateOptions,
  FirefoxBackground,
  FirefoxExtension,
  FirefoxHarnessConfig,
  FirefoxIsolated,
  FirefoxIsolatedContexts,
  FirefoxIsolatedPage,
  FirefoxLaunchResult,
  UrlMatcher
} from './types.js'
export type { FirefoxRDP } from '@openpolyfill/firefox-rdp'
