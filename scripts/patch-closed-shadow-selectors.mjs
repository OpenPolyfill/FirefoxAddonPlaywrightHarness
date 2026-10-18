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
const rolePreviouslyPatched =
  'const shadows = [];\\n    const rootShadow = root.shadowRoot || root.__playwrightClosedShadowRoot__;\\n    if (rootShadow)\\n      shadows.push(rootShadow);\\n    for (const element of root.querySelectorAll("*")) {\\n      match(element);\\n      const shadowRoot = element.shadowRoot || element.__playwrightClosedShadowRoot__;\\n      if (shadowRoot)\\n        shadows.push(shadowRoot);\\n    }\\n    shadows.forEach(query);'
const roleCapturePatched =
  'const shadows = [];\\n    const rootShadow = root.shadowRoot || root.__playwrightClosedShadowRoot__ || root.wrappedJSObject?.__playwrightClosedShadowRoot__;\\n    if (rootShadow)\\n      shadows.push(rootShadow);\\n    for (const element of root.querySelectorAll("*")) {\\n      match(element);\\n      const shadowRoot = element.shadowRoot || element.__playwrightClosedShadowRoot__ || element.wrappedJSObject?.__playwrightClosedShadowRoot__;\\n      if (shadowRoot)\\n        shadows.push(shadowRoot);\\n    }\\n    shadows.forEach(query);'
const roleBridgePatched =
  'const shadows = [];\\n    const rootShadow = root.shadowRoot || window.wrappedJSObject?.__openpolyfillPlaywrightClosedShadowRoot__?.(root);\\n    if (rootShadow)\\n      shadows.push(rootShadow);\\n    for (const element of root.querySelectorAll("*")) {\\n      match(element);\\n      const shadowRoot = element.shadowRoot || window.wrappedJSObject?.__openpolyfillPlaywrightClosedShadowRoot__?.(element);\\n      if (shadowRoot)\\n        shadows.push(shadowRoot);\\n    }\\n    shadows.forEach(query);'
const selectorOriginal =
  'if (root.shadowRoot)\\n          query(root.shadowRoot);\\n        for (const element of root.querySelectorAll("*")) {\\n          if (element.shadowRoot)\\n            query(element.shadowRoot);\\n        }'
const selectorPreviouslyPatched =
  'const rootShadow = root.shadowRoot || root.__playwrightClosedShadowRoot__;\\n        if (rootShadow)\\n          query(rootShadow);\\n        for (const element of root.querySelectorAll("*")) {\\n          const shadowRoot = element.shadowRoot || element.__playwrightClosedShadowRoot__;\\n          if (shadowRoot)\\n            query(shadowRoot);\\n        }'
const selectorCapturePatched =
  'const rootShadow = root.shadowRoot || root.__playwrightClosedShadowRoot__ || root.wrappedJSObject?.__playwrightClosedShadowRoot__;\\n        if (rootShadow)\\n          query(rootShadow);\\n        for (const element of root.querySelectorAll("*")) {\\n          const shadowRoot = element.shadowRoot || element.__playwrightClosedShadowRoot__ || element.wrappedJSObject?.__playwrightClosedShadowRoot__;\\n          if (shadowRoot)\\n            query(shadowRoot);\\n        }'
const selectorBridgePatched =
  'const rootShadow = root.shadowRoot || window.wrappedJSObject?.__openpolyfillPlaywrightClosedShadowRoot__?.(root);\\n        if (rootShadow)\\n          query(rootShadow);\\n        for (const element of root.querySelectorAll("*")) {\\n          const shadowRoot = element.shadowRoot || window.wrappedJSObject?.__openpolyfillPlaywrightClosedShadowRoot__?.(element);\\n          if (shadowRoot)\\n            query(shadowRoot);\\n        }'

function countOccurrences(text, needle) {
  return text.split(needle).length - 1
}

function replaceExactlyOnce(text, from, to) {
  const count = countOccurrences(text, from)
  if (count !== 1)
    throw new Error(
      `Expected exactly one Playwright selector patch point in ${coreBundlePath}; found ${count}`
    )
  return text.replace(from, to)
}

let patched = source
const roleSources = [roleOriginal, rolePreviouslyPatched, roleCapturePatched]
const roleSource = roleSources.find((candidate) => patched.includes(candidate))
if (roleSource) patched = replaceExactlyOnce(patched, roleSource, roleBridgePatched)
else if (!patched.includes(roleBridgePatched)) {
  console.warn(
    `Closed-shadow Playwright role patch skipped: unsupported source in ${coreBundlePath}.`
  )
  process.exit(0)
}

const selectorSources = [selectorOriginal, selectorPreviouslyPatched, selectorCapturePatched]
const selectorSource = selectorSources.find((candidate) => patched.includes(candidate))
if (selectorSource) patched = replaceExactlyOnce(patched, selectorSource, selectorBridgePatched)
else if (!patched.includes(selectorBridgePatched)) {
  console.warn(
    `Closed-shadow Playwright selector patch skipped: unsupported selector source in ${coreBundlePath}.`
  )
  process.exit(0)
}

if (patched !== source) {
  const temporaryPath = `${coreBundlePath}.tmp-${process.pid}`
  await writeFile(temporaryPath, patched)
  await rename(temporaryPath, coreBundlePath)
}
