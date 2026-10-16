# 15 — Packaging, Distribution & Updates

## 1. Build targets

| Platform | Formats | Arch | Notes |
| --- | --- | --- | --- |
| Linux | AppImage, `.deb`, `.rpm`, tar.gz | x64, arm64 | Primary dev/target platform |
| macOS | `.dmg`, `.zip` (universal) | x64 + arm64 | Notarized, hardened runtime |
| Windows | NSIS `.exe`, MSI, portable | x64, arm64 | Code-signed |
| Server (optional) | OCI image | x64, arm64 | Cloud runner / relay / sync |

Tooling: **electron-builder** for desktop, **electron-updater** for updates, Docker for
server images.

## 2. Packaging pipeline

```
commit (main) → CI:
  lint → typecheck → unit → integration → build (per OS) → E2E (per OS)
     → package (installers) → sign → notarize (macOS) → checksums + SBOM
     → publish to release channel (stable|beta) → update manifest
```

- **Reproducible builds** where possible; lockfile pinned; Node/Electron versions fixed.
- **SBOM** generated (CycloneDX) and attached to each release.
- **Checksums + signatures** published alongside artifacts; update manifest is signed.
- Artifacts are cached by content hash in Turborepo/CI cache.

## 3. Code signing & notarization

| Platform | Requirement |
| --- | --- |
| macOS | Developer ID Application cert; hardened runtime; notarization via `notarytool`; entitlements minimal (keychain, network client, files user-selected) |
| Windows | EV/OV code-signing cert; timestamp; SmartScreen reputation |
| Linux | GPG-signed releases + repo metadata for `.deb`/`.rpm`; AppImage signed |

Signing keys live in CI secrets / hardware tokens; never in the repo. A documented rotation
procedure exists.

## 4. Updates (FR-120)

- Channels: **stable**, **beta**, **nightly** (developer).
- Update manifest is signed; the app verifies signature + hash before installing.
- Staged rollout (percentage) with a kill switch.
- Update flow: download in background → notify → user restarts → pre-update DB backup →
  migrations → health check → on failure, automatic rollback to the previous version.
- The app never force-updates without consent; a "restart to update" prompt is non-blocking.
- Enterprise/managed installs can pin a version and disable auto-update via managed policy.

## 5. First-run & data locations

```
Linux:   ~/.config/Unison/            (config), ~/.local/share/Unison/ (data), ~/.cache/Unison/
macOS:   ~/Library/Application Support/Unison/
Windows: %APPDATA%\Unison\  and  %LOCALAPPDATA%\Unison\
```

- Portable mode: a `--portable` flag keeps all data next to the binary (no keychain; uses the
  encrypted vault with a passphrase).
- A `--profile <name>` flag supports isolated profiles for testing.

## 6. Dependencies & licensing

- Default distribution contains only MIT/Apache-2.0/BSD/ISC dependencies.
- Optional GPL/AGPL components (e.g., certain codecs or `ghidra`-adjacent tooling, if ever
  added) are dynamically loaded, not linked, and documented in `docs/19`.
- A license report (`THIRD_PARTY_NOTICES.md`) is generated and shipped; CI fails on
  unapproved licenses.
- Native modules are rebuilt per platform in CI; prebuilds are verified.

## 7. Release checklist

1. All milestones M0–M9 complete; M10 release tasks done.
2. Full test suite green on Linux, macOS, Windows.
3. Performance budgets met (`AGENTS.md` §9) on reference hardware.
4. Security suite green (FR-123); `npm audit` clean or waivered.
5. Accessibility audit (axe) passes on core flows.
6. Migrations tested from the previous two releases with rollback.
7. Installers signed/notarized; checksums + SBOM published.
8. `CHANGELOG.md`, `RELEASE_NOTES.md`, and docs updated.
9. Update manifest published to stable; staged rollout enabled.
10. A tagged release (`v<major>.<minor>.<patch>`) with artifacts attached.

## 8. Crash & diagnostics

- Local crash dumps via `crashReporter` (kept local unless the user opts in to upload).
- A **Diagnostics** page bundles: app/OS versions, feature flags, provider status (no keys),
  MCP server status, sandbox status, DB size, and recent redacted logs.
- "Create diagnostic bundle" produces a `.zip` with redaction applied and a preview before
  sharing (FR-119/121).

## 9. Uninstall & data removal

- Uninstall removes the app; user data remains unless the user chooses to delete it.
- An in-app "Delete all data" performs the FR-105 flow.
- A `--purge` uninstall option (documented) removes config, data, cache, and keychain entries.
