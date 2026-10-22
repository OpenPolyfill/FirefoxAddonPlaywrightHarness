---
title: 'RDP access'
description: 'Use the Firefox RDP client exposed by the test fixture.'
---

For the complete client and actor API, see the [FirefoxRDP documentation](https://openpolyfill.github.io/FirefoxRDP).

## Inspect tabs

The `rdp` fixture is the connected `FirefoxRDP` instance used by the harness:

```ts
const tabs = await rdp.root.listTabs()
const selected = tabs.find((tab) => tab.selected) ?? tabs[0]
if (!selected) throw new Error('Firefox has no open tab')
```

## Obtain a target

Use the normal Firefox RDP actor hierarchy for operations not covered by the harness:

```ts
const target = await selected.getTarget()
const evaluation = await target.console().evaluateJS('document.title')
if (evaluation.hasException) throw new Error(String(evaluation.exceptionMessage))
console.log(evaluation.result)
```

The client also exposes generated actor fronts:

```ts
const watcher = await selected.getWatcher()
await watcher.api.watchTargets({ targetType: 'frame' })
```

Use `rdp.front(actorId, typeName).api.method(...)` for generated methods and `rdp.actor(actorId).call(method, params)` when a generic fallback is needed.

## Firefox DevTools Local Mode

The harness `localMappings` option manages this watcher lifecycle automatically. For direct RDP use, Firefox 153+ requires the network resource watcher before its network parent actor is requested:

The package's Firefox Local Mode compatibility patch adjusts these module imports in the `browser/omni.ja` archive so Firefox can load them from its distinct DevTools global. The package `globalSetup` applies this unified diff with the other Firefox patches.

```ts
const watcher = await selected.getWatcher()
await watcher.watchResources(['network-event'])
const networkParent = await watcher.api.getNetworkParentActor()
await networkParent.api.setLocalModeMappings({
  'app.localhost': '/absolute/path/to/app-fixtures'
})
```

Clear the mappings and stop watching when the page closes:

```ts
await networkParent.api.setLocalModeMappings({})
await watcher.unwatchResources(['network-event'])
```

## Security

Firefox RDP is privileged, unauthenticated, and unencrypted at the TCP layer. The harness binds its endpoint to localhost. Do not expose the endpoint to a LAN or the public Internet.
