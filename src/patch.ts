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
const pageAgentPath = 'chrome/juggler/content/content/PageAgent.js'
const popupRegistryMarker = '// @openpolyfill:popup-registry'
const sidebarRegistryMarker = '// @openpolyfill:sidebar-registry'
const sidebarConstructorMarker = '// @openpolyfill:sidebar-constructor'
const sidebarHostMarker = '// @openpolyfill:sidebar-host'
const sidebarPageTargetMarker = '// @openpolyfill:sidebar-target'
const sidebarWindowCleanupMarker = '// @openpolyfill:sidebar-window-cleanup'
const sidebarPageHandlerSourceMarker = '// @openpolyfill:sidebar-mouse-offset'
const previousPopupRegistryMarker = '// --- Firefox Addon Playwright Popup Page Targets v3 ---'
const popupPageTargetMarker = '// @openpolyfill:page-target'
const legacyPopupPageTargetMarker = '// --- Firefox Addon Playwright Popup PageTarget behavior ---'
const popupPageHandlerMarker = '// @openpolyfill:page-handler'
const previousPopupPageHandlerMarkers = [
  '// --- Firefox Addon Playwright Popup Page v11 ---',
  '// --- Firefox Addon Playwright Popup Page v20 ---'
]
const popupPageAgentMarker = '// @openpolyfill:page-agent'
const previousPopupPageAgentMarker = '// --- Firefox Addon Playwright Popup mouse agent v6 ---'
const popupWindowListenerMarker = '// @openpolyfill:window-listener'
const popupWindowCleanupMarker = '// @openpolyfill:window-cleanup'
const popupPageConstructorMarker = '// @openpolyfill:page-constructor'
const popupPageHostMarker = '// @openpolyfill:page-host'
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
  file: string,
  previousMarker?: string
): string {
  const markerCount = countOccurrences(content, marker)
  const previousMarkerCount = previousMarker ? countOccurrences(content, previousMarker) : 0
  if (markerCount > 1 || previousMarkerCount > 1 || (markerCount && previousMarkerCount))
    throw new Error(`Incompatible popup patch marker state in ${file}`)
  if (markerCount === 1) return content
  if (previousMarker && previousMarkerCount === 1)
    return replaceExactlyOnce(content, previousMarker, marker, file)
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
    ${sidebarRegistryMarker}
    this.registerExtensionSidebar = (ownerWindow, extensionId) => {
      const controller = ownerWindow.SidebarController;
      if (!controller || !controller._box)
        throw new Error('Firefox SidebarController is unavailable');
      const entry = [...controller.sidebars.entries()].find(([, sidebar]) => sidebar.extensionId === extensionId);
      if (!entry)
        throw new Error('Firefox extension sidebar is not registered');
      const [commandID] = entry;
      if (!controller.isOpen || controller.currentID !== commandID)
        throw new Error('Firefox extension sidebar is not active');
      const hostBrowser = controller.browser;
      const browser = hostBrowser.contentDocument?.getElementById('webext-panels-browser');
      if (!browser || browser.getAttribute('webextension-view-type') !== 'sidebar' || !browser.browsingContext)
        throw new Error('Firefox extension sidebar inner browser is unavailable');
      const existing = this._browserToTarget.get(browser);
      if (existing) {
        if (existing._sidebarExtensionID === extensionId && existing._sidebarCommandID === commandID)
          return existing.id();
        if (existing._sidebarController)
          existing.dispose();
        else
          throw new Error('Firefox extension sidebar browser already has a Juggler target');
      }
      const browsingContext = browser.browsingContext;
      const opener = this._browserToTarget.get(ownerWindow.gBrowser.selectedBrowser);
      const userContextId = browsingContext.originAttributes.userContextId || 0;
      const browserContext = opener ? opener.browserContext() : this._userContextIdToBrowserContext.get(userContextId);
      if (!browserContext)
        throw new Error('Firefox extension sidebar has no Playwright browser context');
      const sidebarTab = { linkedBrowser: browser, userContextId };
      const target = new PageTarget(this, ownerWindow, sidebarTab, browserContext, opener, null, controller, commandID, extensionId);
      target._sidebarOwnerWindow = ownerWindow;
      target._sidebarOwnerUnloadListener = () => target.dispose();
      ownerWindow.addEventListener('unload', target._sidebarOwnerUnloadListener, { once: true });
      target._sidebarHostBrowser = hostBrowser;
      const onSidebarChange = () => {
        const activeBrowser = hostBrowser.contentDocument?.getElementById('webext-panels-browser');
        if (!controller.isOpen || controller.currentID !== commandID || activeBrowser !== browser)
          target.dispose();
      };
      const observer = new ownerWindow.MutationObserver(onSidebarChange);
      target._sidebarObserver = observer;
      observer.observe(controller._box, { attributes: true, attributeFilter: ['hidden'] });
      const sidebarDocument = browser.ownerDocument;
      if (sidebarDocument?.documentElement)
        observer.observe(sidebarDocument.documentElement, { childList: true, subtree: true });
      const onHostLoad = () => onSidebarChange();
      target._sidebarHostLoadListener = onHostLoad;
      hostBrowser.addEventListener('load', onHostLoad, true);
      target.updateOverridesForBrowsingContext(browsingContext);
      target.updateViewportSize().catch(error => dump('Sidebar viewport update failed: ' + error + '\\n'));
      return target.id();
    };
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
  const previousRegistrationCount = countOccurrences(patched, previousPopupRegistryMarker)
  const currentRegistrationCount = countOccurrences(patched, popupRegistryMarker)
  if (
    previousRegistrationCount > 1 ||
    currentRegistrationCount > 1 ||
    (previousRegistrationCount && currentRegistrationCount)
  )
    throw new Error(`Incompatible popup Page target patch state in ${file}`)
  if (previousRegistrationCount || currentRegistrationCount) {
    const marker = previousRegistrationCount ? previousPopupRegistryMarker : popupRegistryMarker
    const markerIndex = patched.indexOf(marker)
    const start = patched.lastIndexOf(registrationAnchor, markerIndex)
    const end = patched.indexOf(`    const onOpenWindow = async (appWindow) => {`, markerIndex)
    if (start < 0 || end < 0) throw new Error(`Incompatible popup Page target patch in ${file}`)
    patched = patched.slice(0, start) + registrationPatch + `\n\n` + patched.slice(end)
  } else {
    patched = replaceExactlyOnce(patched, registrationAnchor, registrationPatch, file)
  }
  const windowListenerAnchor = `        helper.addEventListener(tabContainer, 'TabClose', onTabCloseListener),`
  patched = replaceWithMarker(
    patched,
    windowListenerAnchor,
    `${windowListenerAnchor}
        helper.addEventListener(domWindow.document, 'WebExtPopupLoaded', event => onExtensionPopupLoaded(domWindow, event)), ${popupWindowListenerMarker}`,
    popupWindowListenerMarker,
    file,
    '// popup Page lifecycle'
  )
  const closeWindowAnchor = `      helper.removeListeners(listeners);
      for (const tab of domWindow.gBrowser.tabs)`
  const closeWindowPatch = `      helper.removeListeners(listeners);
      ${popupWindowCleanupMarker}
      for (const target of popupTargetsByWindow.get(domWindow) || [])
        target.dispose();
      popupTargetsByWindow.delete(domWindow);
      for (const tab of domWindow.gBrowser.tabs)`
  patched = replaceWithMarker(
    patched,
    closeWindowAnchor,
    closeWindowPatch,
    popupWindowCleanupMarker,
    file,
    '// popup Page window cleanup'
  )
  const sidebarWindowCleanupCount = countOccurrences(patched, sidebarWindowCleanupMarker)
  if (sidebarWindowCleanupCount > 1)
    throw new Error(`Incompatible sidebar window cleanup patch state in ${file}`)
  if (sidebarWindowCleanupCount === 1) {
    patched = replaceExactlyOnce(
      patched,
      `      ${sidebarWindowCleanupMarker}
      for (const target of this._browserToTarget.values())
        if (target._sidebarOwnerWindow === domWindow)
          target.dispose();
      popupTargetsByWindow.delete(domWindow);`,
      `      popupTargetsByWindow.delete(domWindow);`,
      file
    )
  }

  const constructorAnchor = `  constructor(registry, win, tab, browserContext, opener) {`
  patched = replaceWithMarker(
    patched,
    constructorAnchor,
    `  constructor(registry, win, tab, browserContext, opener, popupPanel = null) { ${popupPageConstructorMarker}`,
    popupPageConstructorMarker,
    file,
    '// popup Page constructor'
  )
  const sidebarConstructorAnchor = `  constructor(registry, win, tab, browserContext, opener, popupPanel = null) { ${popupPageConstructorMarker}`
  patched = replaceWithMarker(
    patched,
    sidebarConstructorAnchor,
    `  constructor(registry, win, tab, browserContext, opener, popupPanel = null, sidebarController = null, sidebarCommandID = null, sidebarExtensionID = null) { ${popupPageConstructorMarker} ${sidebarConstructorMarker}`,
    sidebarConstructorMarker,
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
    this._popupPanel = popupPanel; ${popupPageHostMarker}`,
    popupPageHostMarker,
    file,
    '// popup Page host'
  )
  patched = patchOrVerify(
    patched,
    '    this._gBrowser = popupPanel ? { documentGlobal: tab.linkedBrowser.contentWindow } : win.gBrowser;',
    '    this._gBrowser = (popupPanel || sidebarController) ? { documentGlobal: tab.linkedBrowser.contentWindow } : win.gBrowser;',
    file
  )
  const sidebarHostAnchor = `    this._popupPanel = popupPanel; ${popupPageHostMarker}`
  patched = replaceWithMarker(
    patched,
    sidebarHostAnchor,
    `${sidebarHostAnchor}
    this._sidebarController = sidebarController;
    this._sidebarCommandID = sidebarCommandID;
    this._sidebarExtensionID = sidebarExtensionID; ${sidebarHostMarker}`,
    sidebarHostMarker,
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
    patched = replaceExactlyOnce(
      patched,
      currentPopupViewportSizeBlock,
      popupViewportSizeBlock,
      file
    )

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
    if (count > 1) throw new Error(`Incompatible popup Page activation patch state in ${file}`)
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
  if (!this._disposed && this._popupPanel.state !== 'closed' && this._popupPanel.state !== 'hiding')
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
    file,
    legacyPopupPageTargetMarker
  )
  patched = patchOrVerify(
    patched,
    `  if (!this._disposed && this._popupPanel.state === 'open')
    this._popupPanel.hidePopup();`,
    `  if (!this._disposed && this._popupPanel.state !== 'closed' && this._popupPanel.state !== 'hiding')
    this._popupPanel.hidePopup();`,
    file
  )
  const sidebarPrototypeAnchor = `function fromProtocolColorScheme(colorScheme) {`
  const sidebarPrototypePatch = `${sidebarPageTargetMarker}
const originalSidebarActivateAndRun = PageTarget.prototype.activateAndRun;
PageTarget.prototype.activateAndRun = function(callback = () => {}, options = {}) {
  if (!this._sidebarController)
    return originalSidebarActivateAndRun.call(this, callback, options);
  if (
    this._disposed ||
    !this._sidebarController.isOpen ||
    this._sidebarController.currentID !== this._sidebarCommandID
  )
    throw new Error('Sidebar page is closed');
  return callback();
};

const originalSidebarClose = PageTarget.prototype.close;
PageTarget.prototype.close = function(runBeforeUnload = false) {
  if (!this._sidebarController)
    return originalSidebarClose.call(this, runBeforeUnload);
  if (this._disposed)
    return;
  this._sidebarController.hide({ dismissPanel: true });
  if (!this._sidebarController.isOpen || this._sidebarController.currentID !== this._sidebarCommandID)
    this.dispose();
};

const originalSidebarDispose = PageTarget.prototype.dispose;
PageTarget.prototype.dispose = function() {
  if (this._sidebarController && this._disposed)
    return;
  if (this._sidebarController) {
    this._sidebarObserver?.disconnect();
    this._sidebarObserver = undefined;
    if (this._sidebarHostBrowser && this._sidebarHostLoadListener)
      this._sidebarHostBrowser.removeEventListener('load', this._sidebarHostLoadListener, true);
    if (this._sidebarOwnerWindow && this._sidebarOwnerUnloadListener)
      this._sidebarOwnerWindow.removeEventListener('unload', this._sidebarOwnerUnloadListener);
  }
  return originalSidebarDispose.call(this);
};

const originalSidebarUpdateViewportSize = PageTarget.prototype.updateViewportSize;
PageTarget.prototype.updateViewportSize = async function() {
  if (!this._sidebarController)
    return originalSidebarUpdateViewportSize.call(this);
  await waitForWindowReady(this._window);
  this.updateDPPXOverride();
  this.updateScreenEmulation();
  const viewportSize = this._viewportSize;
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

${sidebarPrototypeAnchor}`
  patched = replaceWithMarker(
    patched,
    sidebarPrototypeAnchor,
    sidebarPrototypePatch,
    sidebarPageTargetMarker,
    file
  )
  return patched
}

function patchPopupPageAgent(content: string, file: string): string {
  const markerCount = countOccurrences(content, popupPageAgentMarker)
  const previousMarkerCount = countOccurrences(content, previousPopupPageAgentMarker)
  const previousRoute = 'dispatchPopupMouseEvent: this._dispatchPopupMouseEvent.bind(this),'
  const previousRouteCount = countOccurrences(content, previousRoute)
  const dragRoute = 'dispatchDragEvent: this._dispatchDragEvent.bind(this),'
  const popupDragRoute = 'dispatchDragEvent: this._dispatchPopupMouseEvent.bind(this),'
  const dragRouteCount = countOccurrences(content, dragRoute)
  const popupDragRouteCount = countOccurrences(content, popupDragRoute)
  if (
    markerCount > 1 ||
    previousMarkerCount > 1 ||
    (markerCount && previousMarkerCount) ||
    previousRouteCount > 1 ||
    dragRouteCount > 1 ||
    popupDragRouteCount > 1
  )
    throw new Error(`Incompatible popup mouse agent patch state in ${file}`)
  const methodAnchor = '  async _dispatchDragEvent({type, x, y, modifiers}) {'
  const method = `  ${popupPageAgentMarker}
  async _dispatchPopupMouseEvent({type, x, y, button = 0, clickCount = 0, modifiers = 0, buttons = 0}) {
    if (!['mousedown', 'mousemove', 'mouseup'].includes(type))
      return this._dispatchDragEvent({ type, x, y, modifiers });
    const win = this._frameTree.mainFrame().domWindow();
    const target = win.document.elementFromPoint(x, y) || win.document.documentElement;
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
      detail: clickCount,
      screenX: Math.round(win.mozInnerScreenX + x),
      screenY: Math.round(win.mozInnerScreenY + y),
      clientX: x,
      clientY: y,
      button,
      buttons,
      ctrlKey: !!(modifiers & 2),
      altKey: !!(modifiers & 1),
      shiftKey: !!(modifiers & 4),
      metaKey: !!(modifiers & 8)
    };
    const pointerEventTypes = {
      mousemove: 'pointermove',
      mousedown: 'pointerdown',
      mouseup: 'pointerup',
      mouseover: 'pointerover',
      mouseout: 'pointerout',
      mouseenter: 'pointerenter',
      mouseleave: 'pointerleave',
      click: 'click',
      auxclick: 'auxclick',
      dblclick: 'dblclick'
    };
    const dispatch = (eventType, eventTarget = target, detail = clickCount, relatedTarget = null) => {
      const options = {
        ...eventOptions,
        bubbles: !['mouseenter', 'mouseleave'].includes(eventType),
        detail,
        relatedTarget
      };
      const pointerEventType = pointerEventTypes[eventType];
      if (pointerEventType) {
        const pointerOptions = {
          ...options,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          width: 1,
          height: 1,
          pressure: buttons ? 0.5 : 0,
          tangentialPressure: 0,
          tiltX: 0,
          tiltY: 0,
          twist: 0,
          button: eventType === 'mousemove' && buttons === 0 ? -1 : button
        };
        win.windowUtils.dispatchDOMEventViaPresShellForTesting(
          eventTarget,
          new win.PointerEvent(pointerEventType, pointerOptions)
        );
      }
      return win.windowUtils.dispatchDOMEventViaPresShellForTesting(
        eventTarget,
        new win.MouseEvent(eventType, options)
      );
    };
    if (type === 'mousemove') {
      const previousTarget = this._popupMouseLastTarget;
      if (previousTarget !== target) {
        const ancestors = element => {
          const result = [];
          for (let current = element; current; current = current.parentElement)
            result.push(current);
          return result;
        };
        const previousAncestors = previousTarget ? ancestors(previousTarget) : [];
        const targetAncestors = ancestors(target);
        while (
          previousAncestors.length &&
          targetAncestors.length &&
          previousAncestors[previousAncestors.length - 1] === targetAncestors[targetAncestors.length - 1]
        ) {
          previousAncestors.pop();
          targetAncestors.pop();
        }
        if (previousTarget) {
          dispatch('mouseout', previousTarget, 0, target);
          for (const ancestor of previousAncestors)
            dispatch('mouseleave', ancestor, 0, target);
        }
        dispatch('mouseover', target, 0, previousTarget);
        for (const ancestor of targetAncestors.reverse())
          dispatch('mouseenter', ancestor, 0, previousTarget);
        this._popupMouseLastTarget = target;
      }
      return dispatch(type);
    }
    return dispatch(type);
  }

`

  if (markerCount || previousMarkerCount) {
    if (previousRouteCount || dragRouteCount || popupDragRouteCount !== 1)
      throw new Error(`Incompatible popup mouse agent patch state in ${file}`)
    const marker = markerCount ? popupPageAgentMarker : previousPopupPageAgentMarker
    const markerIndex = content.indexOf(marker)
    const methodIndex = content.indexOf(methodAnchor, markerIndex)
    const methodStart = content.lastIndexOf('\n', markerIndex) + 1
    if (markerIndex < 0 || methodIndex < 0)
      throw new Error(`Incompatible popup mouse agent method in ${file}`)
    return content.slice(0, methodStart) + method + content.slice(methodIndex)
  }
  if (previousRouteCount || dragRouteCount !== 1 || popupDragRouteCount)
    throw new Error(`Incompatible popup mouse agent route in ${file}`)
  const patched = replaceExactlyOnce(content, dragRoute, popupDragRoute, file)
  const methodIndex = patched.indexOf(methodAnchor)
  if (methodIndex < 0) throw new Error(`Incompatible popup mouse agent method in ${file}`)
  return patched.slice(0, methodIndex) + method + patched.slice(methodIndex)
}

function patchPopupPageHandler(content: string, file: string): string {
  const markerCount = countOccurrences(content, popupPageHandlerMarker)
  const previousMarkers = previousPopupPageHandlerMarkers.filter((marker) =>
    countOccurrences(content, marker)
  )
  const previousMarkerCount = previousMarkers.reduce(
    (count, marker) => count + countOccurrences(content, marker),
    0
  )
  if (markerCount > 1 || previousMarkerCount > 1 || (markerCount && previousMarkerCount))
    throw new Error(`Incompatible popup Page handler patch state in ${file}`)
  const previousMarker = previousMarkers[0] ?? ''
  const marker = markerCount ? popupPageHandlerMarker : previousMarker
  let base = marker ? content.slice(0, content.indexOf(marker)).trimEnd() : content
  const sidebarMouseOffsetCount = countOccurrences(base, sidebarPageHandlerSourceMarker)
  if (sidebarMouseOffsetCount > 1)
    throw new Error(`Incompatible sidebar mouse offset patch state in ${file}`)
  if (sidebarMouseOffsetCount === 1) {
    base = replaceExactlyOnce(
      base,
      `      ${sidebarPageHandlerSourceMarker}
      const sidebarHostBounds = this._pageTarget._sidebarController
        ? this._pageTarget._sidebarHostBrowser.getBoundingClientRect()
        : { left: 0, top: 0 };
      const promises = [];`,
      `      const promises = [];`,
      file
    )
    base = replaceExactlyOnce(
      base,
      '          x + boundingBox.left + sidebarHostBounds.left,\n          y + boundingBox.top + sidebarHostBounds.top,',
      '          x + boundingBox.left,\n          y + boundingBox.top,',
      file
    )
  }
  return `${base}

${popupPageHandlerMarker}
const originalPopupPageReload = PageHandler.prototype['Page.reload'];
PageHandler.prototype['Page.reload'] = async function() {
  if (this._pageTarget._popupPanel || this._pageTarget._sidebarController) {
    this._pageTarget.linkedBrowser().webNavigation.reload(Ci.nsIWebNavigation.LOAD_FLAGS_NONE);
    return;
  }
  return originalPopupPageReload.call(this);
};
const originalPopupDispatchMouseEvent = PageHandler.prototype['Page.dispatchMouseEvent'];
PageHandler.prototype['Page.dispatchMouseEvent'] = async function(options) {
  const { type, x, y, button = 0, clickCount, modifiers = 0, buttons = 0 } = options;
  const isPopup = !!this._pageTarget._popupPanel;
  const isSidebar = !!this._pageTarget._sidebarController;
  if (
    (!isPopup && !isSidebar) ||
    (isPopup && !modifiers) ||
    !['mousedown', 'mousemove', 'mouseup'].includes(type)
  )
    return originalPopupDispatchMouseEvent.call(this, options);

  const browser = this._pageTarget._linkedBrowser;
  browser.scrollRectIntoViewIfNeeded(x, y, 0, 0);
  const bounds = browser.getBoundingClientRect();
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height)
    return originalPopupDispatchMouseEvent.call(this, options);

  const sendMouseEvent = async eventType => {
    await this._contentPage.send('dispatchDragEvent', {
      type: eventType,
      x,
      y,
      button,
      clickCount,
      modifiers,
      buttons
    });
  };

  return this._pageTarget.activateAndRun(async () => {
    this._pageTarget.ensureContextMenuClosed();
    if (type === 'mousedown') {
      if (!this._isDragging)
        await sendMouseEvent(type);
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
      await sendMouseEvent(type);
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
    await sendMouseEvent(type);
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
  const pageAgent = zip.file(pageAgentPath)
  const sourceInFirefox = frameTree ? await frameTree.async('string') : ''
  const targetRegistrySource = targetRegistry ? await targetRegistry.async('string') : ''
  const pageHandlerSource = pageHandler ? await pageHandler.async('string') : ''
  const pageAgentSource = pageAgent ? await pageAgent.async('string') : ''
  if (
    countOccurrences(sourceInFirefox, frameTreeGetterPatch) !== 1 ||
    countOccurrences(targetRegistrySource, popupRegistryMarker) !== 1 ||
    countOccurrences(targetRegistrySource, sidebarRegistryMarker) !== 1 ||
    countOccurrences(targetRegistrySource, popupPageTargetMarker) !== 1 ||
    countOccurrences(targetRegistrySource, sidebarPageTargetMarker) !== 1 ||
    countOccurrences(targetRegistrySource, sidebarConstructorMarker) !== 1 ||
    countOccurrences(targetRegistrySource, sidebarHostMarker) !== 1 ||
    countOccurrences(pageHandlerSource, popupPageHandlerMarker) !== 1 ||
    countOccurrences(pageAgentSource, popupPageAgentMarker) !== 1
  ) {
    throw new Error(
      `Playwright Firefox is not patched for popup and sidebar Pages: omni.ja:${targetRegistryPath}, ${pageHandlerPath}, and ${pageAgentPath}`
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
  const pageAgent = zip.file(pageAgentPath)
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
  if (!pageAgent)
    throw new Error(`Incompatible Playwright Firefox build: omni.ja is missing ${pageAgentPath}`)
  const addonBefore = await addon.async('string')
  const jugglerBefore = await juggler.async('string')
  const frameTreeBefore = await frameTree.async('string')
  const targetRegistryBefore = await targetRegistry.async('string')
  const pageHandlerBefore = await pageHandler.async('string')
  const pageAgentBefore = await pageAgent.async('string')
  const frameTreeSource = patchFrameTreeGetter(frameTreeBefore, `omni.ja:${frameTreePath}`)
  const targetRegistrySource = patchPopupTargetRegistry(
    targetRegistryBefore,
    `omni.ja:${targetRegistryPath}`
  )
  const pageHandlerSource = patchPopupPageHandler(pageHandlerBefore, `omni.ja:${pageHandlerPath}`)
  const pageAgentSource = patchPopupPageAgent(pageAgentBefore, `omni.ja:${pageAgentPath}`)
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
      pageHandlerSource !== pageHandlerBefore ||
      pageAgentSource !== pageAgentBefore
    ) {
      zip.file(frameTreePath, frameTreeSource)
      zip.file(targetRegistryPath, targetRegistrySource)
      zip.file(pageHandlerPath, pageHandlerSource)
      zip.file(pageAgentPath, pageAgentSource)
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
  zip.file(pageAgentPath, pageAgentSource)

  const suffix = `\n${PATCH_MARKER}\nlockPref("marionette.running", true);\n// --- End Firefox Addon Playwright Harness ---\n`
  const cfgTmp = `${cfgPath}.tmp-${process.pid}`
  await writeOmniArchive(zip, omniPath)
  await writeFile(cfgTmp, cfg + suffix)
  await rename(cfgTmp, cfgPath)
}

export { replaceExactlyOnce }
