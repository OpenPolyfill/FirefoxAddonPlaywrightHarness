import { readFile, writeFile, rename } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import { firefox } from '@playwright/test'

export const PATCH_MARKER = '// --- Firefox Addon Playwright Harness ---'
const utilityWorldName = '__playwright_utility_world__'
const closedShadowPropertyName = 'openOrClosedShadowRoot'
const closedShadowHelperName = '__openpolyfillClosedShadowRootHelper__'
const legacyClosedShadowGetterName = '__openpolyfillClosedShadowRootForPlaywright__'
const frameTreePath = 'chrome/juggler/content/content/FrameTree.js'
const targetRegistryPath = 'chrome/juggler/content/TargetRegistry.js'
const pageHandlerPath = 'chrome/juggler/content/protocol/PageHandler.js'
const popupRegistryMarker = '// --- Firefox Addon Playwright Popup Page Targets v3 ---'
const previousPopupRegistryMarkers = [
  '// --- Firefox Addon Playwright Popup Page Targets v2 ---',
  '// --- Firefox Addon Playwright Popup Page Targets ---',
]
const popupPageTargetMarker = '// --- Firefox Addon Playwright Popup PageTarget behavior ---'
const previousPopupPageHandlerMarkers = [
  '// --- Firefox Addon Playwright Popup Page input and lifecycle v7 ---',
  '// --- Firefox Addon Playwright Popup Page lifecycle v3 ---',
  '// --- Firefox Addon Playwright Popup Page behaviors v2 ---',
  '// --- Firefox Addon Playwright Popup Page reload ---',
  '// --- Firefox Addon Playwright Popup Page v1 ---',
  '// --- Firefox Addon Playwright Popup Page v2 ---',
  '// --- Firefox Addon Playwright Popup Page v3 ---',
  '// --- Firefox Addon Playwright Popup Page v4 ---',
  '// --- Firefox Addon Playwright Popup Page v5 ---',
  '// --- Firefox Addon Playwright Popup Page v6 ---',
  '// --- Firefox Addon Playwright Popup Page v7 ---',
  '// --- Firefox Addon Playwright Popup Page v8 ---',
  '// --- Firefox Addon Playwright Popup Page v9 ---',
  '// --- Firefox Addon Playwright Popup Page v10 ---',
]
const popupPageHandlerMarker = '// --- Firefox Addon Playwright Popup Page v11 ---'
const frameTreeContextCreation = `    const world = this._runtime.createExecutionContext(this.domWindow(), sandbox, {
      frameId: this.id(),
      name,
    });`
const frameTreeGetterPatch = `    if (name === '${utilityWorldName}') {
      const nativeGetter = Object.getOwnPropertyDescriptor(
        this.domWindow().Element.prototype,
        '${closedShadowPropertyName}'
      )?.get;
      if (!nativeGetter)
        throw new Error('Firefox openOrClosedShadowRoot getter is unavailable');
      Cu.exportFunction(
        (host) => nativeGetter.call(host) ?? host.shadowRoot,
        sandbox,
        { defineAs: '${closedShadowHelperName}' }
      );
      Cu.evalInSandbox(
        '(function() {' +
          'const getClosedRoot = globalThis["${closedShadowHelperName}"];' +
          'Object.defineProperty(Element.prototype, "${closedShadowPropertyName}", {' +
            'configurable: true,' +
            'get() { return getClosedRoot(this); }' +
          '});' +
          'if (!delete globalThis["${closedShadowHelperName}"]) throw new Error("Temporary closed-shadow getter leaked");' +
        '})()',
        sandbox
      );
    }
`
const legacyFrameTreeGetterPatch = `    if (name === '${utilityWorldName}') {
      Cu.exportFunction(
        (host) => host.openOrClosedShadowRoot ?? host.shadowRoot,
        sandbox,
        { defineAs: '${legacyClosedShadowGetterName}' }
      );
    }
`
let closedShadowPatchAssertion: Promise<void> | undefined
let patchPromise: Promise<void> | undefined

function countOccurrences(content: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while (true) {
    const index = content.indexOf(needle, offset)
    if (index < 0) return count
    count++
    offset = index + needle.length
  }
}

function replaceExactlyOnce(
  content: string,
  needle: string,
  replacement: string,
  file: string
): string {
  if (countOccurrences(content, needle) !== 1)
    throw new Error(
      `Incompatible Playwright Firefox build: patch needle must occur exactly once in ${file}: ${needle}`
    )
  return content.replace(needle, replacement)
}

function patchOrVerify(content: string, original: string, patched: string, file: string): string {
  const originalCount = countOccurrences(content, original)
  const patchedCount = countOccurrences(content, patched)
  if (patchedCount === 1 && originalCount === 0) return content
  if (patchedCount === 0 && originalCount === 1)
    return replaceExactlyOnce(content, original, patched, file)
  throw new Error(
    `Incompatible Playwright Firefox patch state in ${file}: expected exactly one original or patched needle`
  )
}

function replaceWithMarker(
  content: string,
  original: string,
  replacement: string,
  marker: string,
  file: string
): string {
  const markerCount = countOccurrences(content, marker)
  if (markerCount === 1) return content
  if (markerCount !== 0)
    throw new Error(`Incompatible partial popup Page patch in ${file}`)
  return replaceExactlyOnce(content, original, replacement, file)
}

function patchPopupTargetRegistry(content: string, file: string): string {
  let patched = content
  const oldImport = `const {ExtensionParent} = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs'); // popup Page patch`
  const oldImportCount = countOccurrences(patched, oldImport)
  if (oldImportCount > 1)
    throw new Error(`Incompatible ExtensionParent popup patch state in ${file}`)
  if (oldImportCount === 1) patched = patched.replace(oldImport, '')

  const registrationAnchor = `    const domWindowTabListeners = new Map();`
  const registrationPatch = `${registrationAnchor}
    ${popupRegistryMarker}
    const popupTargetsByWindow = new Map();
    const onExtensionPopupLoaded = (ownerWindow, event) => {
      const browser = event.target;
      if (!browser || browser.getAttribute('webextension-view-type') !== 'popup' || this._browserToTarget.has(browser))
        return;
      let panel = browser.parentNode;
      while (panel && panel.localName !== 'panel')
        panel = panel.parentNode;
      if (!panel || panel.id === 'webextension-remote-preload-panel')
        return;
      const browsingContext = browser.browsingContext;
      if (!browsingContext)
        return;
      const opener = this._browserToTarget.get(ownerWindow.gBrowser.selectedBrowser);
      const userContextId = browsingContext.originAttributes.userContextId || 0;
      const browserContext = opener ? opener.browserContext() : this._userContextIdToBrowserContext.get(userContextId);
      if (!browserContext)
        return;
      const popupTab = { linkedBrowser: browser, userContextId };
      const target = new PageTarget(this, ownerWindow, popupTab, browserContext, opener, panel);
      let targets = popupTargetsByWindow.get(ownerWindow);
      if (!targets) {
        targets = new Set();
        popupTargetsByWindow.set(ownerWindow, targets);
      }
      targets.add(target);
      target.updateOverridesForBrowsingContext(browsingContext);
      target.updateViewportSize().catch(error => dump('Popup viewport update failed: ' + error + '\\n'));
      const onPopupHidden = () => {
        popupTargetsByWindow.get(ownerWindow)?.delete(target);
        target.dispose();
        panel.removeEventListener('popuphidden', onPopupHidden);
      };
      panel.addEventListener('popuphidden', onPopupHidden);
    };`
  const previousRegistrationMarkers = previousPopupRegistryMarkers.filter(marker =>
    countOccurrences(patched, marker)
  )
  const oldRegistrationCount = previousRegistrationMarkers.reduce(
    (count, marker) => count + countOccurrences(patched, marker),
    0
  )
  const currentRegistrationCount = countOccurrences(patched, popupRegistryMarker)
  if (oldRegistrationCount > 1 || currentRegistrationCount > 1 || (oldRegistrationCount && currentRegistrationCount))
    throw new Error(`Incompatible popup Page target patch state in ${file}`)
  if (oldRegistrationCount === 1) {
    const oldMarker = previousRegistrationMarkers[0]
    if (!oldMarker) throw new Error(`Missing previous popup Page marker in ${file}`)
    const oldMarkerIndex = patched.indexOf(oldMarker)
    const start = patched.lastIndexOf(registrationAnchor, oldMarkerIndex)
    const end = patched.indexOf(`    const onOpenWindow = async (appWindow) => {`, oldMarkerIndex)
    if (start < 0 || end < 0)
      throw new Error(`Incompatible older popup Page target patch in ${file}`)
    patched = patched.slice(0, start) + registrationPatch + `\n\n` + patched.slice(end)
  } else if (!currentRegistrationCount) {
    patched = replaceExactlyOnce(patched, registrationAnchor, registrationPatch, file)
  }

  const windowListenerAnchor = `        helper.addEventListener(tabContainer, 'TabClose', onTabCloseListener),`
  patched = replaceWithMarker(
    patched,
    windowListenerAnchor,
    `${windowListenerAnchor}
        helper.addEventListener(domWindow.document, 'WebExtPopupLoaded', event => onExtensionPopupLoaded(domWindow, event)), // popup Page lifecycle`,
    'popup Page lifecycle',
    file
  )
  const closeWindowAnchor = `      helper.removeListeners(listeners);
      for (const tab of domWindow.gBrowser.tabs)`
  const closeWindowPatch = `      helper.removeListeners(listeners);
      // popup Page window cleanup
      for (const target of popupTargetsByWindow.get(domWindow) || [])
        target.dispose();
      popupTargetsByWindow.delete(domWindow);
      for (const tab of domWindow.gBrowser.tabs)`
  patched = replaceWithMarker(
    patched,
    closeWindowAnchor,
    closeWindowPatch,
    'popup Page window cleanup',
    file
  )

  const constructorAnchor = `  constructor(registry, win, tab, browserContext, opener) {`
  patched = replaceWithMarker(
    patched,
    constructorAnchor,
    `  constructor(registry, win, tab, browserContext, opener, popupPanel = null) { // popup Page constructor`,
    'popup Page constructor',
    file
  )
  const previousPopupBrowserAssignment =
    '    this._gBrowser = popupPanel ? { documentGlobal: win } : win.gBrowser;'
  if (countOccurrences(patched, previousPopupBrowserAssignment) > 1)
    throw new Error(`Incompatible popup Page host patch state in ${file}`)
  if (countOccurrences(patched, previousPopupBrowserAssignment) === 1) {
    patched = replaceExactlyOnce(
      patched,
      previousPopupBrowserAssignment,
      '    this._gBrowser = popupPanel ? { documentGlobal: tab.linkedBrowser.contentWindow } : win.gBrowser;',
      file
    )
  }

  const browserFieldsAnchor = `    this._gBrowser = win.gBrowser;
    this._tab = tab;`
  patched = replaceWithMarker(
    patched,
    browserFieldsAnchor,
    `    this._gBrowser = popupPanel ? { documentGlobal: tab.linkedBrowser.contentWindow } : win.gBrowser;
    this._tab = tab;
    this._popupPanel = popupPanel; // popup Page host`,
    'popup Page host',
    file
  )

  const currentPopupViewportSizeBlock = `  const viewportSize = this._viewportSize;
  if (viewportSize) {
    const { width, height } = viewportSize;
    this._linkedBrowser.style.setProperty('width', width + 'px');
    this._linkedBrowser.style.setProperty('height', height + 'px');
  } else {
    this._linkedBrowser.style.removeProperty('width');
    this._linkedBrowser.style.removeProperty('height');
  }`
  const popupViewportSizeBlock = `  const viewportSize = this._viewportSize || this._browserContext.defaultViewportSize;
  if (viewportSize) {
    const { width, height } = viewportSize;
    this._linkedBrowser.style.setProperty('width', width + 'px');
    this._linkedBrowser.style.setProperty('min-width', width + 'px');
    this._linkedBrowser.style.setProperty('height', height + 'px');
    this._linkedBrowser.style.setProperty('min-height', height + 'px');
  } else {
    this._linkedBrowser.style.removeProperty('width');
    this._linkedBrowser.style.removeProperty('min-width');
    this._linkedBrowser.style.removeProperty('height');
    this._linkedBrowser.style.removeProperty('min-height');
  }`
  const currentPopupViewportCount = countOccurrences(patched, currentPopupViewportSizeBlock)
  if (currentPopupViewportCount > 1)
    throw new Error(`Incompatible popup Page viewport patch state in ${file}`)
  if (currentPopupViewportCount === 1)
    patched = replaceExactlyOnce(patched, currentPopupViewportSizeBlock, popupViewportSizeBlock, file)

  const popupActivationFocusBlocks = [
    `  this._window.focus();
  this._linkedBrowser.focus();
  return callback();`,
    `  this._window.focus();
  return callback();`,
    `  this._linkedBrowser.focus();
  return callback();`
  ]
  for (const focusBlock of popupActivationFocusBlocks) {
    const count = countOccurrences(patched, focusBlock)
    if (count > 1)
      throw new Error(`Incompatible popup Page activation patch state in ${file}`)
    if (count === 1) patched = replaceExactlyOnce(patched, focusBlock, '  return callback();', file)
  }

  const prototypeAnchor = `function fromProtocolColorScheme(colorScheme) {`
  const prototypePatch = `${popupPageTargetMarker}
const originalPopupActivateAndRun = PageTarget.prototype.activateAndRun;
PageTarget.prototype.activateAndRun = function(callback = () => {}, options = {}) {
  if (!this._popupPanel)
    return originalPopupActivateAndRun.call(this, callback, options);
  if (this._disposed || this._popupPanel.state !== 'open')
    throw new Error('Popup page is closed');
  return callback();
};

const originalPopupClose = PageTarget.prototype.close;
PageTarget.prototype.close = function(runBeforeUnload = false) {
  if (!this._popupPanel)
    return originalPopupClose.call(this, runBeforeUnload);
  if (!this._disposed && this._popupPanel.state === 'open')
    this._popupPanel.hidePopup();
};

const originalPopupUpdateViewportSize = PageTarget.prototype.updateViewportSize;
PageTarget.prototype.updateViewportSize = async function() {
  if (!this._popupPanel)
    return originalPopupUpdateViewportSize.call(this);
  await waitForWindowReady(this._window);
  this.updateDPPXOverride();
  this.updateScreenEmulation();
  const viewportSize = this._viewportSize || this._browserContext.defaultViewportSize;
  if (viewportSize) {
    const { width, height } = viewportSize;
    this._linkedBrowser.style.setProperty('width', width + 'px');
    this._linkedBrowser.style.setProperty('min-width', width + 'px');
    this._linkedBrowser.style.setProperty('height', height + 'px');
    this._linkedBrowser.style.setProperty('min-height', height + 'px');
  } else {
    this._linkedBrowser.style.removeProperty('width');
    this._linkedBrowser.style.removeProperty('min-width');
    this._linkedBrowser.style.removeProperty('height');
    this._linkedBrowser.style.removeProperty('min-height');
  }
  const actualSize = this._linkedBrowser.getBoundingClientRect();
  await this._channel.connect('').send('awaitViewportDimensions', {
    width: actualSize.width / this._zoom,
    height: actualSize.height / this._zoom,
  });
};

${prototypeAnchor}`
  patched = replaceWithMarker(
    patched,
    prototypeAnchor,
    prototypePatch,
    popupPageTargetMarker,
    file
  )
  return patched
}


function patchPopupPageHandler(content: string, file: string): string {
  const currentMarkerCount = countOccurrences(content, popupPageHandlerMarker)
  const previousMarkers = previousPopupPageHandlerMarkers.filter(marker =>
    countOccurrences(content, marker)
  )
  const previousMarkerCount = previousMarkers.reduce(
    (count, marker) => count + countOccurrences(content, marker),
    0
  )
  if (currentMarkerCount > 1 || previousMarkerCount > 1 || (currentMarkerCount && previousMarkerCount))
    throw new Error(`Incompatible popup Page handler patch state in ${file}`)
  if (currentMarkerCount === 1) return content
  const previousMarker = previousMarkers[0]
  const base = previousMarker
    ? content.slice(0, content.indexOf(previousMarker)).trimEnd()
    : content
  return `${base}

${popupPageHandlerMarker}
const originalPopupPageReload = PageHandler.prototype['Page.reload'];
PageHandler.prototype['Page.reload'] = async function() {
  if (this._pageTarget._popupPanel) {
    this._pageTarget.linkedBrowser().webNavigation.reload(Ci.nsIWebNavigation.LOAD_FLAGS_NONE);
    return;
  }
  return originalPopupPageReload.call(this);
};
const originalPopupDispatchMouseEvent = PageHandler.prototype['Page.dispatchMouseEvent'];
PageHandler.prototype['Page.dispatchMouseEvent'] = async function(options) {
  const { type, x, y, button = 0, modifiers = 0 } = options;
  if (!this._pageTarget._popupPanel || !['mousedown', 'mousemove', 'mouseup'].includes(type))
    return originalPopupDispatchMouseEvent.call(this, options);

  const browser = this._pageTarget._linkedBrowser;
  const win = this._pageTarget._window;
  const utils = win.windowUtils;
  browser.scrollRectIntoViewIfNeeded(x, y, 0, 0);
  const bounds = browser.getBoundingClientRect();
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height)
    return originalPopupDispatchMouseEvent.call(this, options);

  let nativeModifiers = 0;
  if (modifiers & 1)
    nativeModifiers |= utils.NATIVE_MODIFIER_ALT_LEFT;
  if (modifiers & 2)
    nativeModifiers |= utils.NATIVE_MODIFIER_CONTROL_LEFT;
  if (modifiers & 4)
    nativeModifiers |= utils.NATIVE_MODIFIER_SHIFT_LEFT;
  if (modifiers & 8)
    nativeModifiers |= utils.NATIVE_MODIFIER_COMMAND_LEFT;

  const resolution = utils.getResolution();
  const devicePixelRatio = win.devicePixelRatio;
  const screenX = Math.round(((bounds.left + x) * resolution + win.mozInnerScreenX) * devicePixelRatio);
  const screenY = Math.round(((bounds.top + y) * resolution + win.mozInnerScreenY) * devicePixelRatio);
  const sendNativeMouseEvent = eventType => new Promise(resolve => {
    const nativeMessage = eventType === 'mousedown'
      ? utils.NATIVE_MOUSE_MESSAGE_BUTTON_DOWN
      : eventType === 'mouseup'
        ? utils.NATIVE_MOUSE_MESSAGE_BUTTON_UP
        : utils.NATIVE_MOUSE_MESSAGE_MOVE;
    utils.sendNativeMouseEvent(
      screenX,
      screenY,
      nativeMessage,
      button,
      nativeModifiers,
      this._pageTarget._popupPanel,
      resolve
    );
  });

  return this._pageTarget.activateAndRun(async () => {
    this._pageTarget.ensureContextMenuClosed();
    if (type === 'mousedown') {
      if (!this._isDragging)
        await sendNativeMouseEvent(type);
      return;
    }

    if (type === 'mousemove') {
      this._lastMousePosition = { x, y };
      if (this._isDragging) {
        const watcher = new EventWatcher(this._pageEventSink, ['dragover'], this._pendingEventWatchers);
        await this._contentPage.send('dispatchDragEvent', { type: 'dragover', x, y, modifiers });
        await watcher.ensureEventsAndDispose(['dragover']);
        return;
      }
      const watcher = new EventWatcher(
        this._pageEventSink,
        ['dragstart', 'juggler-drag-finalized'],
        this._pendingEventWatchers
      );
      await sendNativeMouseEvent(type);
      if (watcher.hasEvent('dragstart')) {
        const eventObject = await watcher.ensureEvent('juggler-drag-finalized');
        this._isDragging = eventObject.dragSessionStarted;
      }
      watcher.dispose();
      return;
    }

    if (this._isDragging) {
      const watcher = new EventWatcher(this._pageEventSink, ['dragover'], this._pendingEventWatchers);
      await this._contentPage.send('dispatchDragEvent', { type: 'dragover', x, y, modifiers });
      await this._contentPage.send('dispatchDragEvent', { type: 'drop', x, y, modifiers });
      await this._contentPage.send('dispatchDragEvent', { type: 'dragend', x, y, modifiers });
      await watcher.ensureEventsAndDispose(['dragover']);
      this._isDragging = false;
      return;
    }
    await sendNativeMouseEvent(type);
  }, { muteNotificationsPopup: true });
};

`
}

export async function ensureFirefoxPatched(): Promise<void> {
  patchPromise ??= patchFirefoxInstallation()
  return patchPromise
}

export function assertClosedShadowSelectorPatched(): Promise<void> {
  closedShadowPatchAssertion ??= verifyClosedShadowSupport().catch((error: unknown) => {
    closedShadowPatchAssertion = undefined
    throw error
  })
  return closedShadowPatchAssertion
}

async function verifyClosedShadowSupport(): Promise<void> {
  const coreBundlePath = join(
    dirname(createRequire(import.meta.url).resolve('playwright-core')),
    'lib',
    'coreBundle.js'
  )
  const source = await readFile(coreBundlePath, 'utf8')
  if (
    !source.includes(
      'const shadows = [];\\n    const rootShadow = root.shadowRoot || root.openOrClosedShadowRoot;'
    ) ||
    !source.includes('root.shadowRoot || root.openOrClosedShadowRoot') ||
    !source.includes('element.shadowRoot || element.openOrClosedShadowRoot') ||
    source.includes(legacyClosedShadowGetterName) ||
    !source.includes(`UTILITY_WORLD_NAME2 = "${utilityWorldName}";`) ||
    source.includes('/* @openpolyfill-utility-world */')
  ) {
    throw new Error(
      `Playwright's selector bundle is not patched for closed shadow roots: ${coreBundlePath}. Reinstall dependencies to run the harness postinstall patch.`
    )
  }

  const binDir = dirname(firefox.executablePath())
  const firefoxDir = process.platform === 'darwin' ? join(binDir, '..', 'Resources') : binDir
  const zip = await JSZip.loadAsync(await readFile(join(firefoxDir, 'omni.ja')))
  const frameTree = zip.file(frameTreePath)
  const targetRegistry = zip.file(targetRegistryPath)
  const pageHandler = zip.file(pageHandlerPath)
  const sourceInFirefox = frameTree ? await frameTree.async('string') : ''
  const targetRegistrySource = targetRegistry ? await targetRegistry.async('string') : ''
  const pageHandlerSource = pageHandler ? await pageHandler.async('string') : ''
  if (
    countOccurrences(sourceInFirefox, frameTreeGetterPatch) !== 1 ||
    countOccurrences(targetRegistrySource, popupRegistryMarker) !== 1 ||
    countOccurrences(targetRegistrySource, popupPageTargetMarker) !== 1 ||
    countOccurrences(pageHandlerSource, popupPageHandlerMarker) !== 1
  ) {
    throw new Error(
      `Playwright Firefox is not patched for popup Pages: omni.ja:${targetRegistryPath} and ${pageHandlerPath}`
    )
}

}
function patchFrameTreeGetter(content: string, file: string): string {
  const currentCount = countOccurrences(content, frameTreeGetterPatch)
  const legacyCount = countOccurrences(content, legacyFrameTreeGetterPatch)
  if (currentCount === 1 && legacyCount === 0) return content
  if (currentCount === 0 && legacyCount === 1)
    return replaceExactlyOnce(content, legacyFrameTreeGetterPatch, frameTreeGetterPatch, file)
  if (currentCount === 0 && legacyCount === 0)
    return replaceExactlyOnce(
      content,
      frameTreeContextCreation,
      frameTreeGetterPatch + frameTreeContextCreation,
      file
    )
  throw new Error(`Incompatible partial Juggler utility getter patch in ${file}`)
}

async function writeOmniArchive(zip: JSZip, omniPath: string): Promise<void> {
  const omniTmp = `${omniPath}.tmp-${process.pid}`
  await writeFile(omniTmp, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }))
  await rename(omniTmp, omniPath)
}

async function patchFirefoxInstallation(): Promise<void> {
  const binDir = dirname(firefox.executablePath())
  const firefoxDir = process.platform === 'darwin' ? join(binDir, '..', 'Resources') : binDir
  const cfgPath = join(firefoxDir, 'playwright.cfg')
  const omniPath = join(firefoxDir, 'omni.ja')
  let cfg: string
  try {
    cfg = await readFile(cfgPath, 'utf8')
  } catch (error) {
    throw new Error(`Cannot patch Playwright Firefox: missing ${cfgPath}`, { cause: error })
  }
  const zip = await JSZip.loadAsync(await readFile(omniPath))
  const addonPath = 'modules/addons/AddonSettings.sys.mjs'
  const jugglerPath = 'chrome/juggler/content/content/JugglerFrameChild.jsm'
  const addon = zip.file(addonPath)
  const juggler = zip.file(jugglerPath)
  const frameTree = zip.file(frameTreePath)
  const targetRegistry = zip.file(targetRegistryPath)
  const pageHandler = zip.file(pageHandlerPath)
  if (!addon || !juggler || !frameTree || !targetRegistry || !pageHandler)
    throw new Error(
      `Incompatible Playwright Firefox build: omni.ja is missing ${
        !addon
          ? addonPath
          : !juggler
            ? jugglerPath
            : !frameTree
              ? frameTreePath
              : !targetRegistry
                ? targetRegistryPath
                : pageHandlerPath
      }`
    )
  const addonBefore = await addon.async('string')
  const jugglerBefore = await juggler.async('string')
  const frameTreeBefore = await frameTree.async('string')
  const targetRegistryBefore = await targetRegistry.async('string')
  const pageHandlerBefore = await pageHandler.async('string')
  const frameTreeSource = patchFrameTreeGetter(frameTreeBefore, `omni.ja:${frameTreePath}`)
  const targetRegistrySource = patchPopupTargetRegistry(
    targetRegistryBefore,
    `omni.ja:${targetRegistryPath}`
  )
  const pageHandlerSource = patchPopupPageHandler(pageHandlerBefore, `omni.ja:${pageHandlerPath}`)
  const markerCount = countOccurrences(cfg, PATCH_MARKER)
  const prefNeedle = 'lockPref("marionette.running", true);'
  const prefCount = countOccurrences(cfg, prefNeedle)
  if (
    markerCount > 1 ||
    (markerCount === 0 && prefCount !== 0) ||
    (markerCount === 1 && prefCount !== 1)
  ) {
    throw new Error(`Incompatible Firefox configuration patch state: ${cfgPath}`)
  }
  if (markerCount === 1) {
    if (
      !addonBefore.includes('makeConstant("EXPERIMENTS_ENABLED", true)') ||
      !jugglerBefore.includes('moz-extension-DISABLED://')
    ) {
      throw new Error(
        `Incompatible partially patched Playwright Firefox installation: ${firefoxDir}`
      )
    }
    if (
      frameTreeSource !== frameTreeBefore ||
      targetRegistrySource !== targetRegistryBefore ||
      pageHandlerSource !== pageHandlerBefore
    ) {
      zip.file(frameTreePath, frameTreeSource)
      zip.file(targetRegistryPath, targetRegistrySource)
      zip.file(pageHandlerPath, pageHandlerSource)
      await writeOmniArchive(zip, omniPath)
    }
    return
  }
  const addonSource = patchOrVerify(
    addonBefore,
    'makeConstant("EXPERIMENTS_ENABLED", false)',
    'makeConstant("EXPERIMENTS_ENABLED", true)',
    `omni.ja:${addonPath}`
  )
  const jugglerSource = patchOrVerify(
    jugglerBefore,
    'moz-extension://',
    'moz-extension-DISABLED://',
    `omni.ja:${jugglerPath}`
  )
  zip.file(addonPath, addonSource)
  zip.file(jugglerPath, jugglerSource)
  zip.file(frameTreePath, frameTreeSource)
  zip.file(targetRegistryPath, targetRegistrySource)
  zip.file(pageHandlerPath, pageHandlerSource)

  const suffix = `\n${PATCH_MARKER}\nlockPref("marionette.running", true);\n// --- End Firefox Addon Playwright Harness ---\n`
  const cfgTmp = `${cfgPath}.tmp-${process.pid}`
  await writeOmniArchive(zip, omniPath)
  await writeFile(cfgTmp, cfg + suffix)
  await rename(cfgTmp, cfgPath)
}

export { replaceExactlyOnce }
