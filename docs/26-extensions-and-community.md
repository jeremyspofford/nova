# 26 — Extensions & Community

Nova is extensible by design (`docs/08`). This document expands the model to a **community
ecosystem**: MCP servers, connectors, plugins, skills, themes, automations, and device
integrations contributed by third parties.

## 1. Extension types

| Type | What it adds | Format |
| --- | --- | --- |
| **MCP server** | Tools, resources, prompts | Standard MCP (stdio/SSE/HTTP) |
| **Connector** | Authenticated integration to a service | Manifest + OAuth/API-key config |
| **Plugin** | Bundles skills + MCP servers + optional UI | `.nova-plugin` bundle |
| **Skill** | Reusable instructions/procedures | Markdown + front-matter |
| **Theme** | Appearance tokens | Theme JSON |
| **Automation template** | Prebuilt triggers/conditions/actions | Automation JSON |
| **Device integration** | Smart-home/device adapter | Connector + entity mappings |
| **Extension (SDK)** | Commands, panels, tools, event hooks | `@nova/sdk` package |

## 2. Registries

- **Nova catalog** (default): signed index served by the Hub or a configurable URL; can be
  self-hosted and works offline from a local directory.
- **MCP Registry**: import MCP servers from community/standard registries; Nova verifies and
  wraps them with permissions.
- **Curated** vs **open** sources: users can add any registry, but only signed entries install
  without extra warning.
- **Sideload**: install from a file or git URL with an explicit trust prompt.

### 2.1 Catalog hosting

A catalog can be served from several endpoints at once:

- **Public domain** — e.g., `catalog.<your-domain>`.
- **mesh/tailnet URL** — e.g., `https://catalog.<tailnet>.ts.net` for private/mesh access.
- **Self-hosted / offline** — a local directory or a container.

Clients accept one or more catalog URLs and try them in order. The index and every artifact are
signed, so any endpoint can serve them. Hosting the catalog at **both** a public domain and a
tailnet name is supported and recommended.

## 3. Install & trust flow

```
Browse/search → view details (permissions, screenshots, changelog, source)
  → install → verify signature + checksum → show permission diff
  → confirm → place in plugins/<id>/<version>/ → register tools/skills/commands
  → sandbox with declared permissions only
```

- **Permission preview** is mandatory: network hosts, filesystem scopes, secrets, commands,
  panels, tools.
- **Updates** show a permission **diff**; added permissions require re-confirmation.
- **Rollback**: keep the previous version; failures auto-revert.
- **Uninstall** removes code and, with confirmation, user data.

## 4. Community contribution

- **Authoring**: `nova dev` (hot reload), `nova validate`, `nova pack` (signed bundle),
  template repo, and the in-app "build a plugin/skill" flow.
- **Signing**: authors sign with a keypair; the catalog publishes publisher keys. The Hub
  verifies before install.
- **Publishing**: submit to a registry with metadata, permissions, license, and version.
- **Review**: automated checks (schema, permissions, known-malware signatures, dependency
  scan) plus optional human/community review for the curated catalog.
- **Versioning** follows semver; compatibility ranges declared against Nova versions.

## 5. Security & supply chain

1. **Least privilege**: declared permissions are enforced at runtime, not trusted.
2. **Sandboxing**: extensions run in isolated processes/workers with resource limits.
3. **Signatures**: catalog, publisher, and bundle are all verified.
4. **Scanning**: dependency and secret scanning on publish and install.
5. **No silent network**: undeclared egress is blocked and reported.
6. **Kill switch**: the Hub can disable an extension across the fleet; a local allowlist
   restricts what can be installed.
7. **Transparency**: an extension's requested permissions, source URL, and signature are always
   visible; users can inspect the bundle.

## 6. Governance

- **Report/abuse** flow; takedown from the curated catalog; revocation of publisher keys.
- A **verified** badge for publishers who complete review; unverified entries are clearly
  labeled and require an extra confirmation.
- **Managed policy** can allow/deny by publisher, category, or id, and can disable sideloading.
- No telemetry about installs leaves the device by default.

## 7. Requirements (see `docs/03` §Q)

- One catalog format covering all extension types.
- MCP registry import + permission wrapping.
- Signed publish, permission diff, rollback.
- Automated review + reporting + managed allow/deny.
- SDK, validator, packer, and template.
