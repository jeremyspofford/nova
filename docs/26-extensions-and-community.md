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
| **Extension (SDK)** | Commands, panels (MCP Apps bridge), tools, hooks, event listeners | `@nova/sdk` package |

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

## 6. Governance

- **Report/abuse** flow; takedown from the curated catalog; revocation of publisher keys.
- A **verified** badge for publishers who complete review; unverified entries are clearly
  labeled and require an extra confirmation.
- **Managed policy** can allow/deny by publisher, category, or id, can restrict catalogs
  (including Git catalogs), can require signed MCP bundles, and can disable sideloading.
- No telemetry about installs leaves the device by default.

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
