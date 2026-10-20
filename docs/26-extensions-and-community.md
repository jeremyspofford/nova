# 26 — Extensions & Community

Nova is extensible by design (`docs/08`). This document expands the model to a **community
ecosystem**: MCP servers, connectors, plugins, skills, hooks, themes, automations, and device
integrations contributed by third parties.

## 1. Extension types

| Type | What it adds | Format |
| --- | --- | --- |
| **MCP server** | Tools, resources, prompts, optional UI (MCP Apps) and events | Standard MCP (stdio/SSE/streamable HTTP) |
| **MCP bundle** | One packaged MCP server with a typed config form (FR-199) | `.mcpb` zip with `manifest.json` (open MCP Bundle format) |
| **Connector** | Authenticated integration to a service | Manifest + OAuth/API-key config |
| **Plugin** | Bundles skills, MCP servers, lifecycle hooks, sub-agent roles, commands (converted to skills), browser extensions (installed only with consent) and optional UI per MCP Apps (FR-045, FR-198) | `.nova-plugin/plugin.json` bundle (`docs/08` §3) |
| **Skill** | Reusable instructions/procedures with optional scripts and templates | Folder with `SKILL.md` (open agent-skills layout, ADR-067) |
| **Hook** | Code run at lifecycle events; can block, add context or answer non-safety asks; trusted by hash (FR-197, ADR-068) | Hooks JSON (`docs/08` §4.1), standalone or inside a plugin |
| **Theme** | Appearance tokens | Theme JSON |
| **Automation template** | Prebuilt triggers/conditions/actions | Automation JSON |
| **Device integration** | Smart-home/device adapter | Connector + entity mappings |
| **Extension (SDK)** | Commands, panels (MCP Apps bridge), tools, hooks, themes, keybindings, menus, status items, event listeners | A plugin folder plus `.nova-plugin/extension.json`, shipped as a signed `.novax` (§9) |
| **Pet** | An animated companion | `pet.json` and frames (`docs/14` §2.3) |

## 2. Registries

- **Nova catalog** (default): signed index served by the Hub or a configurable URL; can be
  self-hosted and works offline from a local directory.
- **Git-hosted catalogs**: any Git repository with a signed `nova-catalog.json` index. Entries
  are pinned to a commit SHA; a moved ref shows as an update with a permission diff
  (`docs/08` §7).
- **MCP Registry**: import MCP servers and bundles from community/standard registries. Nova
  verifies them and wraps them with declared permissions (network none, filesystem only what
  the user grants, tools default `ask`) before they can run (FR-166, FR-199).
- **Curated** vs **open** sources: users can add any registry, but only entries whose
  signatures verify against a trusted publisher key install without the sideload flow.
- **Sideload**: install from a file, folder or Git URL. Unsigned items, or items signed by an
  unknown key, need an **explicit sideload confirmation** and stay labelled **Unverified**
  (§3). Managed policy can disable sideloading.

### 2.1 Catalog hosting

A catalog can be served from several endpoints at once:

- **Public domain** — e.g., `catalog.<your-domain>`.
- **mesh/tailnet URL** — e.g., `https://catalog.<tailnet>.ts.net` for private/mesh access.
- **Git repository** — a public or private Git host.
- **Self-hosted / offline** — a local directory or a container.

Clients accept one or more catalog URLs and try them in order. The index and every artifact are
signed, so any endpoint can serve them. Hosting the catalog at **both** a public domain and a
tailnet name is supported and recommended.

*As shipped in M8 (ADR-097; `docs/14` §5, `docs/08` §7).* The Hub reads the built-in sample
catalog, folders on the Hub, Git repositories pinned to a commit and https locations; every index
may be signed (`<index>.sig`), a catalog may pin its publisher key, and a bad or (under a pin)
missing signature refuses the whole catalog. The index is `catalog.json` or `nova-catalog.json`
([`catalog-index.json`](../contracts/schemas/catalog-index.json)). There is no hosted Nova catalog
service yet and no MCP Registry import beyond registry entries a catalog lists; managed policy can
forbid unverified items, deny plugins and extensions by id and restrict catalogs (by the
`plugins.catalogs` rule).

## 3. Install & trust flow

```
Browse/search → view details (permissions, hooks, roles, browser extensions, UI, source)
  → install → verify signature + checksum
      ├─ verified   → show permission preview
      └─ unverified → explicit sideload confirmation ("Unverified") → show permission preview
  → confirm → place in plugins/<id>/<version>/ → register tools/skills/roles/UI/MCP servers
  → hooks registered as needs_trust → sandbox with declared permissions only
```

- **Permission preview** is mandatory: network hosts, filesystem scopes, secrets, per-action
  tool defaults, hooks (event and whether they may answer asks), browser extensions, UI
  domains and entry points.
- **Unverified items** show the Unverified label in the catalog, in settings and in the audit
  log for as long as they are installed. The sideload confirmation names the missing or unknown
  signature.
- **Hooks** never run at install. Each one runs only after the user trusts its content hash;
  a changed hook needs trust again (FR-197).
- **Browser extensions** declared by a plugin are installed only after a separate consent that
  names the browser profile.
- **Updates** show a permission **diff**; added permissions require re-confirmation.
- **Rollback**: keep the previous version; failures auto-revert.
- **Uninstall** removes code, hooks, roles and UI registrations and, with confirmation, user
  data.

*As shipped in M8 (ADR-097).* The flow above is built for the Marketplace (plugins, skills, themes,
pets, MCP servers) and for Settings → Extensions:

- **Verified** means signed by a key in the owner's trusted publishers (`plugins.trustedPublishers`)
  and, from a catalog, listed by a verified catalog with a matching checksum. Everything else shows
  **Unverified** with its reasons and installs only after "I trust its source; install it
  unverified" (`confirmSideload`), while sideloading is allowed (`market.allowSideload`, managed
  `unverifiedInstalls`). A tampered bundle (its signature does not match its files) is refused
  outright. Removing a trusted key unverifies what it signed.
- **Preview first.** Nothing is written before the install: the preview lists the permissions in
  plain words (sensitive ones marked), the hooks with their hashes, the warnings and, on an update,
  the diff; the marketplace needs the diff accepted when a permission is added or changed. An update
  by another publisher (or an unsigned one replacing a signed one) must be accepted separately and
  clears the extension's secrets and data.
- **Rollback.** A failed install or update puts back what it replaced; an extension's previous
  signed bundle is kept and re-verified on the way back.
- **Hooks** of plugins and extensions arrive `needs_trust`; an extension's hook hash covers its
  bundle, and a plugin hook's covers the plugin's files, so any code change needs trust again.
- **Uninstall** of an extension always removes its secrets and, when asked ("Also remove its data"),
  its data folder.

## 4. Community contribution

- **Authoring**: `nova dev` (hot reload), `nova validate`, `nova pack` (signed bundle),
  template repo, and the in-app "build a plugin/skill" flow.
- **Signing**: authors sign with a keypair; the catalog publishes publisher keys. The Hub
  verifies before install.
- **Publishing**: submit to a registry with metadata, permissions, license, and version.
- **Review**: automated checks (schema, permissions, known-malware signatures, dependency
  scan, hook definitions, UI CSP domains within declared network permissions) plus optional
  human/community review for the curated catalog.
- **Versioning** follows semver; compatibility ranges declared against Nova versions.

*As shipped in M8*: `nova init`, `nova validate`, `nova pack`, `nova keys` and `nova dev` (§9); a
publisher signs with an Ed25519 key and the owner adds its public key to the trusted publishers
(Marketplace → Catalogs); a catalog is a folder or repository with a signed `catalog.json` (§9.6).
Automated review, a malware or dependency scan, a submission service and the in-app "build a
plugin" flow are not built.

## 5. Security & supply chain

1. **Least privilege**: declared permissions are enforced at runtime, not trusted.
2. **Sandboxing**: extensions run in isolated processes/workers with resource limits; MCP Apps
   UIs run in sandboxed iframes on opaque origins.
3. **Signatures**: catalog, publisher, and bundle are all verified, for every catalog source.
4. **Scanning**: dependency and secret scanning on publish and install.
5. **No silent network**: undeclared egress is blocked and reported.
6. **Kill switch**: the Hub can disable an extension across the fleet; a local allowlist
   restricts what can be installed.
7. **Transparency**: an extension's requested permissions, source URL, and signature are always
   visible; users can inspect the bundle.
8. **Integration hygiene** (FR-192, ADR-075): Nova never registers itself, its keys or its MCP
   server in another application's configuration, and never copies its skills into other
   agents' skill folders. Exposing Nova's MCP server is an explicit, per-client action that
   issues a scoped, revocable token. Every Hub and `novad` listener requires a token or
   certificate; loopback is not an authorization boundary. Extensions that do any of this to
   other applications fail review.
9. **Hooks tighten only**: a hook can block or add context; it never overrides built-in safety,
   managed policy or a deny (ADR-068).

*As shipped in M8 (ADR-097 D3).* Extension code runs in QuickJS inside a worker thread per account
and extension, with no Node APIs, files, network or host objects; its only way out is the `nova`
object, whose every call is checked against `extension.json` on the Hub, and undeclared access is
denied, audited and turns the extension off (item 1). Network goes only to declared hosts on public
addresses, within the egress policy (item 5). Bundles and catalogs are signed and read with a
bounded zip reader that refuses overlapping, inconsistent and ZIP64 archives (item 3); `nova pack`
refuses `.env` files and private keys (item 4, for the author's side; there is no scanning on
install). A worker starts only when the installed files still match their digest. The fleet kill
switch is managed policy (deny by id, `sdk.enabled` off; item 6).

## 6. Governance

- **Report/abuse** flow; takedown from the curated catalog; revocation of publisher keys.
- A **verified** badge for publishers who complete review; unverified entries are clearly
  labeled and require an extra confirmation.
- **Managed policy** can allow/deny by publisher, category, or id, can restrict catalogs
  (including Git catalogs), can require signed MCP bundles, and can disable sideloading.
- No telemetry about installs leaves the device by default.

*As shipped in M8 (ADR-097 D4).* Managed policy restricts plugins and extensions by id (allow and
deny lists with `*`), forbids unverified installs (which also pins the trusted publishers to the
policy's list), filters catalogs by id and location with their pins, refuses user-added MCP servers
and can turn the SDK off. Reporting, takedown, publisher badges and key revocation lists are not
built.

## 7. Import from other assistants (FR-200)

Users can bring their setup from other assistants and coding agents: instruction files,
`SKILL.md` folders, MCP server configs, plugin folders, sub-agent definitions, commands,
projects, memories and chat exports (`docs/08` §4.2).

- A **preview** lists every item, its Nova target, conflicts, masked secrets and what stays
  disabled before anything is written.
- Items are deduplicated by **SHA-256** in an import ledger, so a re-import skips unchanged
  items.
- Commands become skills; sub-agent Markdown becomes role files; hooks arrive as
  `needs_trust`.
- Secrets in imported config move into the keychain as `secret://` references.
- Imported plugins and MCP servers stay **disabled until their permissions are declared** and
  confirmed.
- Import only reads. It never edits the other application's files or configuration (§5).

## 8. Requirements (see `docs/03` §Q)

- One catalog format covering all extension types, served from remote, Git or local sources.
- MCP registry import + permission wrapping; MCP bundles (FR-199).
- Signed publish, permission diff, rollback; unsigned items only through a labelled sideload.
- Hooks trusted by hash; tighten-only (FR-197).
- Automated review + reporting + managed allow/deny.
- SDK, validator, packer, and template.
- Import from other assistants (FR-200).

## 9. Writing an extension (author's guide, M8)

This is how an extension is built, tested, signed and published with what M8 ships (ADR-097
D1-D3; the API reference is `docs/14` §4.4, the routes are `contracts/hub-api.md` "Extensions",
and `packages/sdk/README.md` has the type list). Everything runs from a checkout of the repository:
the `nova` command is `node packages/cli/src/main.ts`, linked as `nova` by `npm install`.

### 9.1 Start from the sample

```sh
nova init notes --id com.example.notes --name "Notes"
cd notes
```

`nova init` copies `packages/sdk/examples/hello` (a command, a panel, three tools, a status item, a
keybinding, a menu item, a hook and an event listener) and gives it your id (reverse-DNS, which is
also the plugin id) and name. An extension is a plugin folder (`docs/08` §3.1) with one more file:

```text
notes/
  .nova-plugin/plugin.json      id, name, version, plugin permissions (actionDefaults, …)
  .nova-plugin/extension.json   api, entry, everything the code may do
  extension.js                  export function activate(nova) { … }
  panels/notes.html             a panel's ui:// resource (optional)
```

### 9.2 Declare what it may do

`extension.json` ([`extension-manifest.json`](../contracts/schemas/extension-manifest.json)) lists
every capability; the Hub refuses anything else, audits the attempt and turns the extension off:

```json
{
  "api": 1,
  "entry": "extension.js",
  "permissions": {
    "network": ["api.example.com"],
    "fs": ["${extensionData}"],
    "secrets": ["apiKey"],
    "commands": ["notes.new"],
    "panels": [
      { "id": "notes.panel", "title": "Notes", "resource": "ui://notes/panel",
        "entryPoint": "global", "file": "panels/notes.html",
        "connectDomains": ["api.example.com"] }
    ],
    "tools": {
      "list_notes": { "action": "read", "default": "allow" },
      "save_note": { "action": "write" }
    },
    "hooks": [{ "id": "tag-notes", "event": "tool.post", "matcher": "ext:com.example.notes/save_note" }],
    "events": ["run.end"]
  }
}
```

- `network`: hosts for `nova.net.fetch` (`host`, `*.host`, or `*`, which the owner is warned about).
  Requests reach public addresses only and stay within the Hub's egress policy.
- `fs`: `${extensionData}` (the extension's own data folder, always writable), `${extensionRoot}`
  (its installed files, read-only) or absolute folders (read-only unless `{"path": …, "write":
  true}`). A folder inside or containing the Hub's data is refused at install.
- `secrets`: names the owner fills in (Settings → Extensions); `nova.secrets.get` reads only these,
  and each read is audited.
- `tools`: each tool's action class (`read`, `write`, `send`, `delete`, `execute`) and optional
  approval default; a tool's canonical name is `ext:<id>/<name>`, and models see it only where
  plugin tools are enabled (per thread or agent). `actionDefaults` sets defaults per class.
- `panels`: an HTML file in the folder served as a `ui://` resource at the `global`, `thread` or
  `file` entry point (`extensions` for a file panel); its CSP domains must fall within `network`.
- `hooks`: lifecycle hooks (`docs/08` §4.1); `events`: what it may observe (`docs/14` §4.1;
  observing chat messages is shown as sensitive).

The owner reads all of this in plain words before installing, and the difference on every update.

### 9.3 Use the API

```js
// extension.js: an ES module; it may import its own files and '@nova/sdk', nothing else.
export function activate(nova) {
  nova.commands.register({
    id: 'notes.new',
    title: 'Notes: new note',
    run: async (args) => {
      await nova.fs.write('${extensionData}/latest.txt', String(args?.text ?? ''));
      return { saved: true };
    },
  });

  nova.tools.register({
    name: 'list_notes',
    title: 'List notes',
    description: 'List the saved notes.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnly: true },
    handler: async () => (await nova.fs.list('${extensionData}')).map((e) => e.name).join('\n'),
  });

  nova.hooks.register({
    id: 'tag-notes',
    handler: () => ({ context: 'A note was saved by the Notes extension.' }),
  });

  nova.events.on('run.end', (e) => nova.log('a run ended', e.payload));

  nova.themes.register({
    schemaVersion: 1, id: 'com.example.notes.paper', name: 'Paper', variant: 'light',
    tokens: { '--u-bg': '#faf8f2', '--u-accent': '#8a5a00' },
  });

  const item = nova.status.addItem({ id: 'notes.count', text: 'Notes: 0', onClick: 'notes.new' });
  item.update('Notes: 1');
}
```

- **Every `register` returns `{ready, dispose}`**; `ready` rejects when the Hub refused it.
- **What a command returns** shows in a toast: a string as is; an object's `message` or `text`
  field; a flat object as `key: value` when it fits one line; anything longer or nested behind
  **Show the result**, which opens it in a dialog. Raw JSON never appears in a toast.
- **Commands** appear in the command palette under the extension's name and can be bound in Keyboard;
  `nova.keybindings.register({command, key})` only suggests a binding, and `nova.menus.register` adds
  items to a chat's row menu, a message's actions, the file preview or the composer's + menu.
- **Tools** take a JSON Schema object and return text or JSON; a handler has 60 s, a command 30 s.
- **Hooks** answer with `{block?, decision?, context?, continue?}` within the hook's limits; they run
  only after the owner trusts them, need trust again after every update, never answer approval asks,
  and fail closed while the extension is not running.
- **Themes** use the theme file of `docs/14` §2.2 with plain CSS values only; the owner chooses to
  save or use one.
- **Events** are observe-only, redacted and at most 64 KiB each.
- **Network**: `await nova.net.fetch(url, {method, headers, body})` returns `{ok, status,
  statusText, headers, truncated, text(), json(), base64()}` (bodies up to 5 MiB, binary bodies as
  base64, `set-cookie` removed); 8 requests may be in flight.
- **Files**: `nova.fs.read|write|list|remove(path)`, 5 MB per file, links out of a scope refused.
- **Limits**: 64 MiB of memory and 2 s of CPU per call into the engine; a fault ends the worker,
  which restarts at most 3 times in 10 minutes. No Node modules, no `require`, no npm packages at run
  time (bundle what you need into your own files).

### 9.4 Test it

`@nova/sdk` has a test host that applies the declared permissions without the Hub:

```ts
import { readFileSync } from 'node:fs';
import { createTestHost, type ExtensionManifest } from '@nova/sdk';
import * as extension from './extension.js';

const manifest = JSON.parse(
  readFileSync(new URL('./.nova-plugin/extension.json', import.meta.url), 'utf8'),
) as ExtensionManifest;
const host = createTestHost(manifest, { extensionId: 'com.example.notes' });
await extension.activate(host.nova);
await host.run('notes.new', { text: 'hi' });
expect(await host.callTool('list_notes', {})).toContain('latest.txt');
expect(host.denied).toEqual([]);
```

It refuses undeclared commands, tools, hooks, panels, network hosts, files and secrets (throwing
`PermissionDeniedError` at once and recording it in `host.denied`) and gives `run`, `callTool`,
`runHook` and `emit`. It is not the Hub's engine: it does not isolate the code, does not apply the
egress policy, address checks or limits, and checks themes only for `schemaVersion`. Run the real
thing with `nova dev` before publishing.

### 9.5 Validate and run it on a Hub

```sh
nova validate .                      # every problem at once; exit 1 if any
export NOVA_URL=https://hub.local:7419 NOVA_TOKEN=<the owner's session token>
nova dev .                           # load, then reload on every change; --once to load and exit
```

`nova validate` checks `plugin.json` and its parts, `extension.json`, filesystem scopes, panel
domains, hooks, events, that every module loads and imports only the extension's own files, that no
`.env` file or private key would be packed, and a bundle's signature. `nova dev` packs the folder
unsigned and posts it with the sideload confirmation, so the extension shows **Unverified** ("Loaded
by nova dev from a folder"); `--trust-hooks` trusts its hooks at each load's hashes, and
`--accept-publisher-change` lets it replace an installed signed copy (whose secrets and data are then
cleared). A Hub whose managed policy forbids unverified installs refuses dev loads.

### 9.6 Sign and publish

```sh
nova keys generate                   # Ed25519, ~/.config/nova/publisher-key, 0600, never in a repo
nova keys show                       # the public key and its fingerprint to give to owners
nova pack .                          # com.example.notes-0.1.0.novax, signed
```

A Hub owner who adds your public key to the trusted publishers (Marketplace → Catalogs → Trusted
publishers) installs your bundles as **Verified**; anyone else can still install them as
Unverified. To publish through a catalog, put the `.novax` in a folder or Git repository next to a
`catalog.json` ([`catalog-index.json`](../contracts/schemas/catalog-index.json)):

```json
{
  "schemaVersion": 1,
  "name": "Example catalog",
  "items": [
    {
      "kind": "plugin",
      "id": "com.example.notes",
      "name": "Notes",
      "version": "0.1.0",
      "author": "Example",
      "publisher": { "name": "Example", "key": "<your public key>" },
      "path": "com.example.notes-0.1.0.novax",
      "sha256": "<sha256 of the .novax>"
    }
  ]
}
```

Sign the index too: `catalog.json.sig` is `{v: 1, publisher, digest, signature}` with Ed25519 over
`"nova-catalog-v1\n"` + the hex SHA-256 of the index bytes
([`catalog-signature.json`](../contracts/schemas/catalog-signature.json));
`packages/core/test/fixtures/market/sign-sample-catalog.ts` shows how the sample catalog is packed
and signed with `signCatalogIndex` from `@nova/core`. Owners add the catalog (a folder on the Hub, a
Git URL with the commit to read, or an https address) with your key pinned. A new version is an
update: the owner sees the permission diff and accepts what it adds or changes; a different signing
key needs the publisher change accepted.
