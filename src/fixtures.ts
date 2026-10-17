import type { Page, TestType } from '@playwright/test'
import type { FirefoxRDP } from '@openpolyfill/firefox-rdp'
import { bindFirefoxExtensionPage, launchFirefoxExtension } from './launch.js'
import type { FirefoxExtension, FirefoxHarnessConfig, InternalFirefoxContext } from './types.js'

export interface FirefoxFixtures {
  context: InternalFirefoxContext
  page: Page
  extension: FirefoxExtension
  rdp: FirefoxRDP
}

type FixtureUse<T> = (value: T) => Promise<void>

export function createFirefoxFixtures<
  TTestArgs extends object = object,
  TWorkerArgs extends object = object
>(
  test: TestType<TTestArgs, TWorkerArgs>,
  firefoxHarnessConfig: FirefoxHarnessConfig
): TestType<TTestArgs & FirefoxFixtures, TWorkerArgs> {
  const fixtures = {
    context: async ({}, use: FixtureUse<InternalFirefoxContext>) => {
      const running = await launchFirefoxExtension(firefoxHarnessConfig)
      const context = running.context as InternalFirefoxContext
      context._firefoxHarness = {
        rdp: running.rdp,
        extension: running.extension,
        userDataDir: running.userDataDir
      }
      try {
        await use(context)
      } finally {
        await running.close()
      }
    },
    extension: async (
      { context, page }: { context: InternalFirefoxContext; page: Page },
      use: FixtureUse<FirefoxExtension>
    ) => {
      const harness = context._firefoxHarness
      if (!harness) throw new Error('Firefox harness context is not initialized')
      bindFirefoxExtensionPage(harness.extension, page)
      await use(harness.extension)
    },
    rdp: async ({ context }: { context: InternalFirefoxContext }, use: FixtureUse<FirefoxRDP>) => {
      const harness = context._firefoxHarness
      if (!harness) throw new Error('Firefox harness context is not initialized')
      await use(harness.rdp)
    },
    page: async ({ context }: { context: InternalFirefoxContext }, use: FixtureUse<Page>) => {
      await synchronizePostInstallTabs(context, firefoxHarnessConfig.postInstallPages ?? [])
      const existing = context.pages().find((candidate) => candidate.url() === 'about:blank')
      await use(existing ?? (await context.newPage()))
    }
  }
  return test.extend<FirefoxFixtures>(
    fixtures as unknown as Parameters<typeof test.extend<FirefoxFixtures>>[0]
  ) as unknown as TestType<TTestArgs & FirefoxFixtures, TWorkerArgs>
}

async function synchronizePostInstallTabs(
  context: InternalFirefoxContext,
  patterns: FirefoxHarnessConfig['postInstallPages']
): Promise<void> {
  const deadline = Date.now() + 5_000
  let lastSignature = ''
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    const urls = context
      .pages()
      .map((candidate) => candidate.url())
      .sort()
    const signature = urls.join('\u0000')
    if (signature !== lastSignature) {
      lastSignature = signature
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= 250) {
      if (
        !patterns?.length ||
        urls.some((url) =>
          patterns.some((pattern) =>
            typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)
          )
        )
      )
        return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (
    patterns?.length &&
    !context
      .pages()
      .some((candidate) =>
        patterns.some((pattern) =>
          typeof pattern === 'string'
            ? candidate.url().includes(pattern)
            : pattern.test(candidate.url())
        )
      )
  ) {
    console.warn(
      'firefox-addon-playwright-harness: no configured postInstallPages tab appeared within 5000ms'
    )
  }
}
