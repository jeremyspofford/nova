# 15 — Packaging, Distribution & Updates

## 1. Build targets

The primary deliverable is the **Hub**: a container image or a systemd unit (plus launchd and
Windows service variants), with the web UI served by the Hub (ADR-031, ADR-081; §10). `novad`
ships as signed per-OS/arch binaries served by the Hub. The table below covers the native
**desktop shell**, a later client (M7, packaged in M10):

| Platform | Formats | Arch | Notes |
| --- | --- | --- | --- |
| Linux | AppImage, `.deb`, `.rpm`, tar.gz | x64, arm64 | Primary dev/target platform |
| macOS | `.dmg`, `.zip` (universal) | x64 + arm64 | Notarized, hardened runtime |
| Windows | NSIS `.exe`, MSI, portable; MSIX optional | x64, arm64 | Code-signed. MSIX builds must not virtualize the data directory (§5) |
| Server (optional) | OCI image | x64, arm64 | Cloud runner / relay / sync |

Tooling: the Hub, Relay, catalog and sync images are built with Docker (OCI) and the systemd
unit ships with the Hub package; **electron-builder** and **electron-updater** apply to the
desktop shell only; `novad` is built with cargo per target and signed.

*As built in M7* (ADR-095; `apps/desktop`). The desktop shell exists as `apps/desktop` (Electron
44.5.1, entry `src/main.ts`). `npm start -w apps/desktop` runs it against a Hub, and
`npm run test:shell -w apps/desktop` runs its Playwright Electron journey (`docs/16` §3.3). Some
choices for a packaged build are already in the code: `nova://` is registered with the OS only by
an installed build (`app.isPackaged`), so a development or test run never changes the computer's
link handlers; developer tools open only in an unpackaged run; browser component updates are off
in every build (`disable-component-update`), so Chromium downloads nothing in the background.
Electron fuses (running as Node, `NODE_OPTIONS`, inspect flags, asar integrity) are not set yet;
that belongs to packaging. Not built: installers and the formats above, electron-builder
configuration, code signing and notarization, auto-update of the shell (§4), and a shell build or
journey in CI (`docs/16` §9).

## 2. Packaging pipeline

```
commit (main) → CI:
  lint → typecheck → spec check → unit → integration
     → build (Hub image, web UI, novad per target; desktop shell per OS from M7)
     → E2E (web UI against a running Hub; shell journeys per OS from M7)
     → package → sign → notarize (macOS) → checksums + signatures + SBOM
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
| Container images | Signed by digest; the signature and digest are published with the release |

Signing keys live in CI secrets / hardware tokens; never in the repo. A documented rotation
procedure exists.

### 3.1 Verifying an official download (FR-225)

Look-alike repositories, clone sites and fake "official download" pages that distribute
modified builds are a known threat for agent software. Every release therefore publishes, next
to its artifacts: `SHA256SUMS`, a detached signature over it (`SHA256SUMS.sig`), the SBOM, and
the fingerprints of the release signing keys. The fingerprints are also printed in the docs and
on the Hub's About page.

Procedure (documented in the user guide and linked from the Hub's About page and bootstrap
page):

1. Download only from the project's release page or from your own Hub's bootstrap page (Add a
   Device, `docs/22` §4; `novad` builds at `/api/v1/agent/dist/`).
2. Verify `SHA256SUMS.sig` against the published release key, and check that the key's
   fingerprint matches the one in the docs and on the Hub's About page.
3. Check the artifact's SHA-256 against `SHA256SUMS`.
4. Check the platform signature: macOS Developer ID and notarization (`spctl --assess`),
   Windows Authenticode signer, Linux GPG or AppImage signature, container image digest and
   signature.
5. `novad` installs through the Hub's bootstrap command verify signature, checksum and Hub
   identity automatically (FR-133); a failure aborts the install.

A build that fails any step must not be run. Nova never asks users to turn off signature
checks, and the Hub refuses to pair a `novad` whose signature does not verify.

*As built in M6.5* (ADR-094). Step 5 is what the Hub's own bootstrap command does (`docs/22`
§4.3): the builds a Hub serves come from its `NOVA_NOVAD_DIST` folder (packaging copies
`novad-<os>-<arch>` there, `.exe` on Windows, with a `VERSION` file), and the Hub signs their
manifest `novad-manifest.json` with its own identity key (`novad-manifest.sig`, over the tag
`nova-novad-manifest-v1\n` followed by the manifest bytes). The one-line command checks the
download's SHA-256 against the manifest before running it; `novad install` then checks that the
Hub's identity key hashes to the pinned fingerprint, that the manifest signature verifies with it
and that its own binary is the listed build, and refuses to continue otherwise. To verify by hand,
fetch both files from `/api/v1/agent/dist/`, check the signature with the `hubPublicKey` of
`GET /api/v1/hello` (whose SHA-256 is the fingerprint the Hub shows with the code), then the
build's SHA-256. The release signing key, `SHA256SUMS` and platform signatures of steps 2 to 4 are
not built yet (M10); it is the device that refuses a build that does not verify, not the Hub.

## 4. Updates (FR-120)

- Channels: **stable**, **beta**, **nightly** (developer).
- **Check cadence:** at start and then every 6 h by default (configurable; managed policy can
  disable). A check fetches the signed update manifest only: metadata, no user content or
  identifiers beyond the requesting version and channel. Payloads download only when an update
  applies.
- Update manifest is signed; the app verifies signature + hash before installing.
- Staged rollout (percentage) with a kill switch.
- Update flow: download in background → notify → user restarts → pre-update DB backup →
  migrations → health check → on failure, automatic rollback to the previous version.
- The app never force-updates without consent; a "restart to update" prompt is non-blocking.
- Enterprise/managed installs can pin a version and disable auto-update via managed policy.
- The PWA updates with the Hub; `novad` updates are distributed by the Hub (FR-148).

## 5. First-run & data locations

Data and config directories are **resolved explicitly** at startup and never depend on
per-user filesystem virtualization or redirection (FR-225). Resolution order:
`--data-dir <path>` flag → `NOVA_DATA_DIR` → the platform default below.

```
Hub (service):  /var/lib/nova/ (data), /etc/nova/ (config), /var/log/nova/
Hub (container): /data volume (data + config), logs to stdout
Desktop shell:
  Linux:   ~/.config/Nova/            (config), ~/.local/share/Nova/ (data), ~/.cache/Nova/
  macOS:   ~/Library/Application Support/Nova/
  Windows: %APPDATA%\Nova\  and  %LOCALAPPDATA%\Nova\  (resolved through the known-folder API)
```

- MSIX builds disable filesystem write virtualization for the data directory, so `novad`,
  other Nova processes and backups see the same path as the other installers.
- The resolved paths are logged at startup and shown in Diagnostics. A start-up check writes a
  marker file and confirms that the local `novad` (or, without one, a separate helper process)
  reads it at the same path; a mismatch is reported as an error, not ignored.
- Portable mode: a `--portable` flag keeps all data next to the binary (no keychain; uses the
  encrypted vault with a passphrase).
- A `--profile <name>` flag supports isolated profiles for testing.

*As built in M7* (ADR-095). The desktop shell keeps its settings (`shell.json`) and the Hub
session's cookies in Electron's per-user data folder for "Nova" (on Linux `~/.config/Nova/`), or
in `NOVA_SHELL_DATA_DIR` when that is set; one shell runs per data folder. The `--data-dir`,
`--portable` and `--profile` flags are not built for the shell.

### 5.1 Port conflicts

If the configured Hub port (or a `novad` local listener) is held by another process, Nova
never exits silently (FR-225, ADR-080):

1. It logs and shows a diagnostic naming the port and, where the OS allows, the process that
   holds it.
2. It binds the next free port in a small range (configured port + 1 to + 10), advertises the
   new port through mDNS and the bootstrap page, and shows the change in Diagnostics.
3. With `--strict-port` it exits with a non-zero status and the same diagnostic instead of
   falling back.

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
4. Security suite green (FR-123, FR-224); `npm audit` clean or waivered.
5. Accessibility audit (axe) passes on core flows.
6. Migrations tested from the previous two releases with rollback.
7. Installers and images signed/notarized; checksums, signatures, key fingerprints and SBOM
   published; the verification procedure (§3.1) checked against the published artifacts.
8. `CHANGELOG.md`, `RELEASE_NOTES.md`, and docs updated.
9. Update manifest published to stable; staged rollout enabled.
10. A tagged release (`v<major>.<minor>.<patch>`) with artifacts attached.

## 8. Crash & diagnostics

- Local crash dumps via `crashReporter` (kept local unless the user opts in to upload).
- A **Diagnostics** page bundles: app/OS versions, resolved data paths, listening ports,
  feature flags with their stages, provider status (no keys), MCP server status, sandbox
  status, DB size, and recent redacted logs.
- "Create diagnostic bundle" produces a `.zip` with redaction applied and a preview before
  sharing (FR-119/121).
- *As built in M8* (ADR-097): the Hub keeps its own crash reports locally (`<data>/crash/`, no
  message text, redacted relative stack frames), previewable, sendable only to an endpoint the owner
  configures, and deletable in Settings → Data (`docs/12` §9.5, `docs/16` §1.2). There is no Nova
  crash service; the desktop shell's crash dumps are not part of this.

## 9. Uninstall & data removal

- Uninstall removes the app; user data remains unless the user chooses to delete it.
- An in-app "Delete all data" performs the FR-105 flow (*as built in M8*: Settings → Data, typing
  the Hub's name, `docs/12` §9.2).
- A `--purge` uninstall option (documented) removes config, data, cache, and keychain entries.

## 10. Hub, novad, catalog & domain packaging (added)

| Artifact | Formats | Notes |
| --- | --- | --- |
| **Hub** | Container image, systemd unit, macOS launchd, Windows service | Default install on the supported-minimum mini PC |
| **novad** | Signed per-OS/arch static binaries + module bundles | Served by the Hub at `/api/v1/agent/dist/` |
| **Clients** | PWA (served by Hub) + signed desktop installers; mobile later | Same UI, thin shells |
| **Relay / Catalog / Sync** | Container images | Default host `arialabs.ai`; fully self-hostable |
| **`nova` command** (M8) | `@nova/cli` workspace package, bin `nova` (`packages/cli/src/main.ts`, run by Node's type stripping) | Linked by `npm install` in a checkout; not published or packaged separately in M8. AGPL-3.0-or-later; `@nova/sdk` (Apache-2.0) is a workspace package too (`docs/26` §9) |

Domain defaults (all configurable): catalog `catalog.arialabs.ai`, relay `wss://relay.arialabs.ai`,
sync `sync.arialabs.ai`. Standard TLS certificates for the public endpoints; the same services
are also reachable on the tailnet. Signing keys live in CI/hardware tokens, never in the repo.
