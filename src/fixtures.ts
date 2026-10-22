import type { Page, TestInfo, TestType, WorkerInfo } from '@playwright/test'
import type { FirefoxRDP } from '@openpolyfill/firefox-rdp'
import { bindFirefoxExtensionPage, launchFirefoxExtension } from './launch.js'
import type { FirefoxExtension, FirefoxHarnessConfig, InternalFirefoxContext } from './types.js'

export interface FirefoxFixtures {
  context: InternalFirefoxContext
  page: Page
  extension: FirefoxExtension
  rdp: FirefoxRDP
}

interface WorkerFirefoxFixtures {
  workerContext: InternalFirefoxContext
  workerPage: Page
}

type WorkerContextFixture = Pick<WorkerFirefoxFixtures, 'workerContext'>

type FixtureUse<T> = (value: T) => Promise<void>
type HarnessContext = { context: InternalFirefoxContext; close: () => Promise<void> }

export function createFirefoxFixtures<
  TTestArgs extends object = object,
  TWorkerArgs extends object = object
>(
  test: TestType<TTestArgs, TWorkerArgs>,
  firefoxHarnessConfig: FirefoxHarnessConfig
): TestType<TTestArgs & FirefoxFixtures, TWorkerArgs> {
  const contextScope = firefoxHarnessConfig.contextScope ?? 'test'
  const contextFixture =
    contextScope === 'worker'
      ? async (
          { workerContext }: WorkerContextFixture,
          use: FixtureUse<InternalFirefoxContext>
        ) => {
          await use(workerContext)
        }
      : async ({}, use: FixtureUse<InternalFirefoxContext>, testInfo: TestInfo) => {
          const running = await launchHarnessContext(
            firefoxHarnessConfig,
            testInfo.project.use as Record<string, unknown>
          )
          try {
            await use(running.context)
          } finally {
            await running.close()
          }
        }

  const fixtures = {
    workerContext: [
      async ({}, use: FixtureUse<InternalFirefoxContext>, workerInfo: WorkerInfo) => {
        if (contextScope !== 'worker') {
          throw new Error('A worker-scoped context is required for the workerContext fixture')
        }
        const running = await launchHarnessContext(
          firefoxHarnessConfig,
          workerInfo.project.use as Record<string, unknown>
        )
        try {
          await use(running.context)
        } finally {
          await running.close()
        }
      },
      { scope: 'worker' as const }
    ],
    workerPage: [
      async ({ workerContext }: WorkerContextFixture, use: FixtureUse<Page>) => {
        await synchronizePostInstallTabs(workerContext, firefoxHarnessConfig.postInstallPages ?? [])
        await use(await workerContext.newPage())
      },
      { scope: 'worker' as const }
    ],
    context: contextFixture,
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
      const page = existing ?? (await context.newPage())
      try {
        await use(page)
      } finally {
        if (contextScope === 'worker' && !page.isClosed()) await page.goto('about:blank')
      }
    }
  }

  return test.extend<FirefoxFixtures, WorkerFirefoxFixtures>(
    fixtures as unknown as Parameters<typeof test.extend<FirefoxFixtures, WorkerFirefoxFixtures>>[0]
  ) as unknown as TestType<TTestArgs & FirefoxFixtures, TWorkerArgs>
}

/** Shares one Playwright page across tests in a worker. Requires contextScope: 'worker'. */
export function withSharedPage<TTestArgs extends object, TWorkerArgs extends object>(
  test: TestType<TTestArgs, TWorkerArgs>
): TestType<TTestArgs, TWorkerArgs> {
  const sharedPageTest = test as unknown as TestType<
    Pick<FirefoxFixtures, 'page'>,
    Pick<WorkerFirefoxFixtures, 'workerPage'>
  >
  const fixtures = {
    page: async ({ workerPage }: { workerPage: Page }, use: FixtureUse<Page>) => {
      await use(workerPage)
    }
  }
  return sharedPageTest.extend<object, { workerPage: Page }>(
    fixtures as unknown as Parameters<typeof sharedPageTest.extend<object, { workerPage: Page }>>[0]
  ) as unknown as TestType<TTestArgs, TWorkerArgs>
}

async function launchHarnessContext(
  config: FirefoxHarnessConfig,
  projectUse: Record<string, unknown>
): Promise<HarnessContext> {
  const projectOptions = config.resolveProjectOptions?.(projectUse)
  const running = await launchFirefoxExtension({
    extensionPath: config.extensionPath,
    headless: projectOptions?.headless ?? config.headless,
    firefoxUserPrefs: config.firefoxUserPrefs,
    args: config.args,
    launchOptions:
      projectOptions?.launchOptions === undefined
        ? config.launchOptions
        : { ...config.launchOptions, ...projectOptions.launchOptions },
    postInstallPages: config.postInstallPages,
    localMappings: config.localMappings,
    patchFirefox: config.patchFirefox
  })
  const context = running.context as InternalFirefoxContext
  context._firefoxHarness = {
    rdp: running.rdp,
    extension: running.extension,
    userDataDir: running.userDataDir
  }
  return { context, close: running.close }
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
