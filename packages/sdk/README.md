# @nova/sdk

The Nova extension SDK (FR-117, `docs/14` §4): the typed `nova` API for extension authors, the
`extension.json` types, and a test host for unit tests. Apache-2.0, with no dependencies, so an
extension under any license can use it. It is a workspace package (not published to a registry in
M8). Inside the Hub's engine, `import … from '@nova/sdk'` resolves to a small built-in module with
`API_VERSION`, `defineExtension` and `nova`; the types and the test host are for authoring and
tests only. The author's guide is `docs/26` §9.

## What an extension is

An extension is a plugin folder (the format of `docs/08` §3.1) with one more file,
`.nova-plugin/extension.json`, which names the API version, the entry module and everything the
extension may do. Its code runs on the Hub in an isolated JavaScript engine inside a worker
thread of its own: no Node APIs, no files, no network, no host objects. The only way out is the
`nova` object, and every call on it is checked against what `extension.json` declared. Anything
else is refused, audited, and turns the extension off until the owner turns it back on.

```text
my-extension/
  .nova-plugin/plugin.json      id, name, version, plugin permissions (docs/08 §3.1)
  .nova-plugin/extension.json   api, entry, declared permissions (below)
  extension.js                  export function activate(nova) { ... }
  panels/hello.html             a panel's ui:// resource
```

`nova init <dir>` (`@nova/cli`) starts one from [`examples/hello`](examples/hello), which adds a
command, a panel and three tools, plus a status item, a keybinding, a menu item, a hook and an
event listener.

## extension.json

```json
{
  "api": 1,
  "entry": "extension.js",
  "permissions": {
    "network": ["api.example.com"],
    "fs": ["${extensionData}"],
    "secrets": ["greeting"],
    "commands": ["hello.greet"],
    "panels": [
      {
        "id": "hello.panel",
        "title": "Hello",
        "resource": "ui://hello/panel",
        "entryPoint": "global",
        "file": "panels/hello.html",
        "connectDomains": ["api.example.com"]
      }
    ],
    "tools": { "greet": { "action": "read", "default": "allow" } },
    "actionDefaults": { "write": "ask" },
    "hooks": [{ "id": "note-greetings", "event": "tool.post", "matcher": "ext:com.example.hello/greet" }],
    "events": ["tool.call"]
  }
}
```

| Key | Meaning |
| --- | --- |
| `network` | Hosts `nova.net.fetch` may reach (`host`, `*.host`, or `*` for any). Public addresses only, and always within the Hub's egress policy (the owner's `network.egressMode` and deny list, and managed policy): a request the policy refuses fails with `policy_denied` but does not turn the extension off. |
| `fs` | Folders `nova.fs` may use: `${extensionData}` (its own data folder, always read and write), `${extensionRoot}` (its own files, read only), or an absolute path (read only, or `{"path": "/x", "write": true}`). A folder inside the Hub's own data, or one that contains it (such as `/`), is refused at install. |
| `secrets` | Names `nova.secrets.get` may read. The owner stores the values (Settings, or `PUT /api/v1/extensions/:id/secrets/:name`). |
| `commands` | Command ids the extension may register. |
| `panels` | `ui://` resources served from a file in the extension, at entry point `global`, `thread` or `file` (with `extensions`). Their CSP domains must be within `network`. |
| `tools` | Tool names with their action class (`read`, `write`, `send`, `delete`, `execute`) and an optional default (`allow`, `ask`, `deny`). Models see them as `ext:<id>/<name>`. |
| `actionDefaults` | Defaults per action class for its tools (over the plugin's). |
| `hooks` | Lifecycle hooks (`docs/08` §4.1) it may register. Each runs only after the owner trusts its hash, which covers the bundle, so every update needs trust again. |
| `events` | Events it may observe (`tool.call`, `run.end`, `thread.message`, or names like `run.*`). |

The owner sees all of this in plain words before installing, and the difference on an update.

## The `nova` API

`activate(nova)` runs when the extension starts (the global `nova` is the same object).

| Point | API |
| --- | --- |
| Commands | `nova.commands.register({ id, title, run })` |
| Panels | `nova.panels.register({ id, title, resource, entryPoint, extensions? })` |
| Tools | `nova.tools.register({ name, title, description, inputSchema, outputSchema?, annotations?, handler })` |
| Hooks | `nova.hooks.register({ id, event, matcher?, handler })` returning `{ block?, decision?, context?, continue? }` |
| Themes | `nova.themes.register(theme)` (contracts/schemas/theme.json, plain CSS values only; needs no declaration, and the owner chooses whether to use it) |
| Keybindings | `nova.keybindings.register({ command, key, when? })` for its own commands |
| Events | `nova.events.on(name, listener)` (observe only) |
| Context menus | `nova.menus.register({ where, items: [{ title, command }] })` |
| Status bar | `nova.status.addItem({ id, text, onClick })` returning `{ update(text), dispose() }` |
| Network | `nova.net.fetch(url, { method, headers, body })` |
| Files | `nova.fs.read`, `write`, `list`, `remove` |
| Secrets | `nova.secrets.get(name)` |
| Log | `nova.log(...)`, `console.log(...)` |

Every `register` returns `{ ready, dispose }`; `ready` rejects when the Hub refused it. Timers
(`setTimeout`, `setInterval`) and `queueMicrotask` exist; Node's modules do not. A module may
import the extension's own files by relative path and `@nova/sdk`; nothing else resolves.

Limits: 64 MiB of memory and 2 s of CPU per call into the engine; past either the worker is
ended and restarted (up to 3 times in 10 minutes). Calls time out after 30 s (60 s for tools).

## Testing an extension

```ts
import { readFileSync } from 'node:fs';
import { createTestHost, type ExtensionManifest } from '@nova/sdk';
import * as extension from './extension.js';

// A JSON import types `api` as number; read and cast the manifest instead.
const manifest = JSON.parse(
  readFileSync(new URL('./.nova-plugin/extension.json', import.meta.url), 'utf8'),
) as ExtensionManifest;
const host = createTestHost(manifest, { extensionId: 'com.example.hello', secrets: { greeting: 'Hi' } });
await extension.activate(host.nova);
await host.run('hello.greet', { name: 'Ada' });
await host.callTool('greet', { name: 'Grace' });
```

The test host refuses undeclared commands, tools, hooks, panels, hosts, files, secrets and events
(`host.denied` lists what it refused), but it is not the Hub: it throws `PermissionDeniedError` at
once where the Hub rejects `ready` and turns the extension off; it does not isolate the code, apply
the egress policy, public-address checks or limits, or validate menus, keybinding keys and status
ids; it checks themes only for `schemaVersion` and requires a panel's `resource` and a hook's
`event` to match the declaration when given. Load the extension with `nova dev` before publishing.

## Packaging and signing

`nova validate <dir>` checks everything above; `nova pack <dir>` writes a `.novax` signed with
your publisher key (`nova keys generate`). A Hub installs a bundle signed by a key its owner
trusts (`plugins.trustedPublishers`) as Verified; anything else installs only through an explicit
sideload confirmation and stays labelled Unverified. A bundle whose signature does not match its
files is refused. `nova dev <dir>` loads the folder into a running Hub and reloads it on every
change (`NOVA_URL`, `NOVA_TOKEN`). "Verified" is computed when shown, so removing a trusted key
unverifies what it signed; an update signed by another key must be accepted and clears the
extension's secrets and data.

Bundle format (ADR-097 D2): a zip of the folder plus `META-INF/nova-signature.json`
`{v: 1, publisher, digest, signature}`, where `digest` is SHA-256 over the sorted lines
`"<path>\n<sha256>\n"` of every other entry and `signature` is Ed25519 over
`"nova-extension-v1\n" + digest`.
