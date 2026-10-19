import { readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
let coreBundlePath
try {
  coreBundlePath = join(dirname(require.resolve('playwright-core')), 'lib', 'coreBundle.js')
} catch {
  console.warn('Closed-shadow Playwright selector patch skipped: playwright-core is unavailable.')
  process.exit(0)
}

const source = await readFile(coreBundlePath, 'utf8')

const roleOriginal =
  'const shadows = [];\\n    if (root.shadowRoot)\\n      shadows.push(root.shadowRoot);\\n    for (const element of root.querySelectorAll("*")) {\\n      match(element);\\n      if (element.shadowRoot)\\n        shadows.push(element.shadowRoot);\\n    }\\n    shadows.forEach(query);'
const roleDirectGetterPatched =
  'const shadows = [];\\n    const rootShadow = root.shadowRoot || globalThis.__openpolyfillClosedShadowRootForPlaywright__?.(root);\\n    if (rootShadow)\\n      shadows.push(rootShadow);\\n    for (const element of root.querySelectorAll("*")) {\\n      match(element);\\n      const shadowRoot = element.shadowRoot || globalThis.__openpolyfillClosedShadowRootForPlaywright__?.(element);\\n      if (shadowRoot)\\n        shadows.push(shadowRoot);\\n    }\\n    shadows.forEach(query);'
const roleElementGetterPatched =
  'const shadows = [];\\n    const rootShadow = root.shadowRoot || root.openOrClosedShadowRoot;\\n    if (rootShadow)\\n      shadows.push(rootShadow);\\n    for (const element of root.querySelectorAll("*")) {\\n      match(element);\\n      const shadowRoot = element.shadowRoot || element.openOrClosedShadowRoot;\\n      if (shadowRoot)\\n        shadows.push(shadowRoot);\\n    }\\n    shadows.forEach(query);'

const selectorOriginal =
  'if (root.shadowRoot)\\n          query(root.shadowRoot);\\n        for (const element of root.querySelectorAll("*")) {\\n          if (element.shadowRoot)\\n            query(element.shadowRoot);\\n        }'
const selectorDirectGetterPatched =
  'const rootShadow = root.shadowRoot || globalThis.__openpolyfillClosedShadowRootForPlaywright__?.(root);\\n        if (rootShadow)\\n          query(rootShadow);\\n        for (const element of root.querySelectorAll("*")) {\\n          const shadowRoot = element.shadowRoot || globalThis.__openpolyfillClosedShadowRootForPlaywright__?.(element);\\n          if (shadowRoot)\\n            query(shadowRoot);\\n        }'
const selectorElementGetterPatched =
  'const rootShadow = root.shadowRoot || root.openOrClosedShadowRoot;\\n        if (rootShadow)\\n          query(rootShadow);\\n        for (const element of root.querySelectorAll("*")) {\\n          const shadowRoot = element.shadowRoot || element.openOrClosedShadowRoot;\\n          if (shadowRoot)\\n            query(shadowRoot);\\n        }'

const oldUtilityInitOriginal = `async addInitScript(initScript, worldName) {
        this._initScripts.push({ initScript, worldName });`
const oldUtilityInitPatched = `async addInitScript(initScript, worldName) {
        if (initScript.source.includes("/* @openpolyfill-utility-world */"))
          worldName = UTILITY_WORLD_NAME2;
        this._initScripts.push({ initScript, worldName });`
const oldUtilityInitLegacyPatched = oldUtilityInitPatched.replaceAll('.includes(', '.startsWith(')
const oldUtilityPageBootstrapOriginal =
  'this.addInitScript(new InitScript(this._page, ""), UTILITY_WORLD_NAME2).catch((e) => this._reportAsNew(e));'
const oldUtilityPageBootstrapPatched =
  'Promise.all([this.addInitScript(new InitScript(this._page, ""), UTILITY_WORLD_NAME2), ...browserContext.initScripts.filter((script) => script.source.includes("/* @openpolyfill-utility-world */")).map((script) => this.addInitScript(script, UTILITY_WORLD_NAME2))]).catch((e) => this._reportAsNew(e));'
const oldUtilityPageBootstrapLegacyPatched = oldUtilityPageBootstrapPatched.replaceAll(
  '.includes(',
  '.startsWith('
)

const oldUtilityContextUpdateOriginal = `async _updateInitScripts() {
        const bindingScripts = [...this._pageBindings.values()].map((binding) => binding.initScript.source);
        if (this.bindingsInitScript)
          bindingScripts.unshift(this.bindingsInitScript.source);
        const initScripts = this.initScripts.map((script) => script.source);
        await this._browser.session.send("Browser.setInitScripts", { browserContextId: this._browserContextId, scripts: [...bindingScripts, ...initScripts].map((script) => ({ script })) });
      }`
const oldUtilityContextUpdatePatched = `async _updateInitScripts() {
        const bindingScripts = [...this._pageBindings.values()].map((binding) => binding.initScript.source);
        if (this.bindingsInitScript)
          bindingScripts.unshift(this.bindingsInitScript.source);
        const utilityInitScripts = this.initScripts.filter((script) => script.source.includes("/* @openpolyfill-utility-world */"));
        const initScripts = this.initScripts.filter((script) => !script.source.includes("/* @openpolyfill-utility-world */")).map((script) => script.source);
        await this._browser.session.send("Browser.setInitScripts", { browserContextId: this._browserContextId, scripts: [...bindingScripts, ...initScripts].map((script) => ({ script })) });
        await Promise.all(this._ffPages().map(async (ffPage) => {
          const utilityInitSet = new Set(utilityInitScripts);
          const currentInitScripts = ffPage._initScripts.filter((entry) => entry.initScript.source.includes("/* @openpolyfill-utility-world */"));
          const removedInitScripts = currentInitScripts.map((entry) => entry.initScript).filter((script) => !utilityInitSet.has(script));
          if (removedInitScripts.length)
            await ffPage.removeInitScripts(removedInitScripts);
          const currentInitSet = new Set(currentInitScripts.map((entry) => entry.initScript));
          await Promise.all(utilityInitScripts.filter((script) => !currentInitSet.has(script)).map((script) => ffPage.addInitScript(script, UTILITY_WORLD_NAME2)));
        }));
      }`
const oldUtilityContextUpdateLegacyPatched = oldUtilityContextUpdatePatched.replaceAll(
  '.includes(',
  '.startsWith('
)

function countOccurrences(text, needle) {
  return text.split(needle).length - 1
}

function replaceOneKnownVersion(text, versions, replacement, description) {
  const matching = versions.filter((version) => text.includes(version))
  if (matching.length > 1)
    throw new Error(
      `Unsupported or ambiguous Playwright ${description} patch point in ${coreBundlePath}`
    )
  if (matching.length === 0) {
    const replacementCount = countOccurrences(text, replacement)
    if (replacementCount === 1) return text
    throw new Error(
      `Unsupported or ambiguous Playwright ${description} patch point in ${coreBundlePath}`
    )
  }

  if (countOccurrences(text, matching[0]) !== 1)
    throw new Error(
      `Expected exactly one Playwright ${description} patch point in ${coreBundlePath}`
    )
  return text.replace(matching[0], replacement)
}
function restoreKnownVersion(text, versions, original, description) {
  const matching = versions.filter((version) => text.includes(version))
  if (matching.length > 1)
    throw new Error(
      `Unsupported or ambiguous legacy Playwright ${description} patch in ${coreBundlePath}`
    )
  if (matching.length === 0) return text
  if (countOccurrences(text, matching[0]) !== 1)
    throw new Error(
      `Expected exactly one legacy Playwright ${description} patch in ${coreBundlePath}`
    )
  return matching[0] === original ? text : text.replace(matching[0], original)
}

let patched = source
patched = replaceOneKnownVersion(
  patched,
  [roleOriginal, roleDirectGetterPatched, roleElementGetterPatched],
  roleElementGetterPatched,
  'role selector'
)
patched = replaceOneKnownVersion(
  patched,
  [selectorOriginal, selectorDirectGetterPatched, selectorElementGetterPatched],
  selectorElementGetterPatched,
  'CSS selector'
)

patched = restoreKnownVersion(
  patched,
  [oldUtilityInitOriginal, oldUtilityInitPatched, oldUtilityInitLegacyPatched],
  oldUtilityInitOriginal,
  'utility-world init script'
)
patched = restoreKnownVersion(
  patched,
  [
    oldUtilityPageBootstrapOriginal,
    oldUtilityPageBootstrapPatched,
    oldUtilityPageBootstrapLegacyPatched
  ],
  oldUtilityPageBootstrapOriginal,
  'utility-world page bootstrap'
)
patched = restoreKnownVersion(
  patched,
  [
    oldUtilityContextUpdateOriginal,
    oldUtilityContextUpdatePatched,
    oldUtilityContextUpdateLegacyPatched
  ],
  oldUtilityContextUpdateOriginal,
  'Firefox context init script lifecycle'
)

if (patched !== source) {
  const temporaryPath = `${coreBundlePath}.tmp-${process.pid}`
  await writeFile(temporaryPath, patched)
  await rename(temporaryPath, coreBundlePath)
}
