# 19 — Legal & Ethics

This project reimplements **functionality and user experience** inspired by publicly
documented products. It is a clean-room effort. This document sets the rules that keep it
lawful and ethical, and that the build agent must follow.

## 1. Clean-room rules (mandatory)

1. **No copying of code.** Implement from the functional spec only. Never paste decompiled
   pseudocode, vendor source, or obfuscated fragments into the repository.
2. **No copying of assets.** Icons, fonts, images, sounds, animations, illustrations, copy,
   and mascots must be original or permissively licensed. Do not extract assets from any
   third-party app.
3. **No trademarks or trade dress.** Do not use the names, logos, or distinctive visual
   identity of any third-party product for our product or in any way that implies
   affiliation. The app name "Nova" is a working title and is not affiliated with any
   third party. Reference applications are tracked by opaque IDs (`APP-1`…) in the private
   evidence ledger, never by name in the shipped spec (ADR-056):
   - Their identities and the mapping of opaque evidence refs to real sources live only in
     `docs/external/private/` (gitignored: `IDENTITIES.md`, `appN-refs.md`, research notes).
   - `docs/external/` is the evidence zone; the committed findings there use opaque IDs, and
     the reconciliation (`docs/external/RECONCILIATION.md`) cites them only by ID.
   - `scripts/check-spec.mjs` runs in CI and fails when a reference-app name appears in any
     Markdown file outside `docs/external/`; the name list is read from the private ledger, so
     the names themselves are never committed.
   - Integration targets (chat services, smart-home platforms, mesh control planes, Git
     hosts, model providers), protocols and dependencies may be named: Nova talks to them.
4. **Behavior is not copyrightable; expression is.** Matching functional behavior (e.g.,
   "permission modes include Manual/Accept edits/Plan/Auto/Bypass") is fine. Copying the exact
   text of dialogs, docs, or marketing is not.
5. **Two-implementer rule for high-risk areas.** For any feature derived from reverse
   engineering of a specific binary (rather than public documentation), one person/agent
   writes the functional description; a second writes the implementation from that description
   without seeing the original. In this project, the spec documents are the description, and
   the build agent implements from them.
6. **Document provenance.** Each significant feature records whether it came from public docs,
   lawful observation, or both (see `docs/01`).

## 2. Lawful use of analysis tools

- Only analyze software you own or are authorized to inspect.
- Do not bypass DRM, license checks, activation, or encryption.
- Do not use commercial engines (IDA Pro, Hopper, JEB) unless properly licensed; the tool's
  own license governs its use.
- Respect each product's Terms of Service. Automated scraping or unauthorized API use is not
  permitted; use documented APIs and user-provided credentials only.
- When in doubt about a finding's necessity, stop and document the uncertainty rather than
  extracting more.

## 3. Third-party software licenses

| Category | Rule |
| --- | --- |
| Runtime deps | MIT, Apache-2.0, BSD, ISC, MPL-2.0 allowed by default |
| Weak copyleft (LGPL) | Allowed only if dynamically linked and documented; review required |
| Strong copyleft (GPL/AGPL) | Not allowed in the default build; may be an optional, separately distributed plugin with its own notice |
| Proprietary | Not allowed unless the user supplies it at runtime (e.g., a locally installed IDA for optional tooling) |
| Fonts | SIL OFL or Apache-2.0 only; bundle the license |
| Models | Only models with licenses permitting local use; record license in `models.json` |

CI generates `THIRD_PARTY_NOTICES.md` and fails on unapproved licenses. The build must remain
distributable by a single party under permissive terms.

### 3.1 Dependencies added in M6 (ADR-093)

| Dependency | Version (pinned) | License | Where and why |
| --- | --- | --- | --- |
| `playwright-core` | 1.64.1 | Apache-2.0 | `@nova/core`, the agent browser (FR-092). Loaded lazily, so core works without it. It has no dependencies of its own and bundles no browser: Nova drives the Chromium installed for Playwright or the one `browser.executablePath` names |
| `ed25519-dalek` | =2.2.0 | BSD-3-Clause | `novad`, Ed25519 signing and verification of capability documents and update bundles. Default features off, `zeroize` on (the signing key is wiped when dropped); strict verification |
| `sha2` | =0.10.9 | MIT OR Apache-2.0 | `novad`, SHA-256 and SHA-512. Default features off |

These two crates replaced hand-written SHA-2 and Ed25519 code; the release binary grew by about
62 KB (5 %). They pull in these crates, all permissive: `curve25519-dalek` 4.1.3 (BSD-3-Clause,
with the 2024 timing fix), `subtle` 2.6.1 (BSD-3-Clause), `curve25519-dalek-derive` 0.1.1,
`version_check` 0.9.5 (MIT/Apache-2.0), `ed25519` 2.2.3, `signature` 2.2.0, `zeroize` 1.9.1,
`digest` 0.10.7, `block-buffer` 0.10.4, `crypto-common` 0.1.7, `typenum` 1.20.1, `cfg-if` 1.0.5,
`cpufeatures` 0.2.17, `syn` 2.0.119, `rustc_version` 0.4.1, `semver` 1.0.28, `libc` 0.2.191 (MIT
OR Apache-2.0), `generic-array` 0.14.7 (MIT) and `fiat-crypto` 0.2.9 (MIT OR Apache-2.0 OR
BSD-1-Clause). `fiat-crypto` and `libc` are in the lockfile but are not compiled on x86-64 Linux.
`novad`'s other crates (`serde`, `serde_json` and their dependencies) are MIT or Apache-2.0
(`memchr` Unlicense OR MIT, `zmij` MIT, `unicode-ident` also Unicode-3.0). No GPL or AGPL
dependency was added.

### 3.2 M7: the permissive server packages and new dependencies (ADR-023, ADR-095)

ADR-023 is applied: the components that run on someone else's server are separate, permissively
licensed packages, each with its own `LICENSE` file, and they import no AGPL package. The rest of
the repository stays AGPL-3.0-or-later (ADR-022).

| Package | License | Notes |
| --- | --- | --- |
| `services/relay` (`@nova/relay-service`) | Apache-2.0 | The self-hostable Relay. It now logs with its own small JSON-lines logger instead of `@nova/telemetry` (AGPL), and holds the APNs and FCM senders |
| `packages/relay` (`@nova/relay`) | Apache-2.0 | The Relay protocol library shared by the Hub, the Relay and clients |
| `services/runner` (`@nova/runner-service`) | Apache-2.0 | The self-hostable cloud runner; its only dependencies are `fastify` and `zod`, with a redactor of its own |

Dependencies added in M7, all pinned:

| Dependency | Version (pinned) | License | Where and why |
| --- | --- | --- | --- |
| `quickjs-emscripten` | 0.32.0 | MIT | `@nova/core`, the isolated engine of `script.run` (FR-202) |
| `@jitl/quickjs-wasmfile-release-sync` | 0.32.0 | MIT | The QuickJS WebAssembly build it loads (`RELEASE_SYNC`) |
| `imapflow` | 2.2.2 | MIT | `@nova/core`, reading email bindings' mailboxes (IMAP, IDLE; FR-110) |
| `mailparser` | 3.9.32 | MIT | `@nova/core`, parsing inbound mail |
| `nodemailer` | 10.0.13 | MIT-0 | `@nova/core`, sending mail over SMTP |
| `electron` | 44.5.1 | MIT | `apps/desktop`, the desktop shell (dev dependency; an installed build bundles it) |
| `rustls` | =0.23.45 | Apache-2.0 OR ISC OR MIT | `novad`, TLS to the Hub (R-023, FR-126); TLS 1.3 and 1.2, no logging |
| `ring` | 0.17.14 | Apache-2.0 AND ISC | `novad`, the rustls crypto provider (builds with the Rust image's C compiler; aws-lc would need cmake) |
| `rcgen` | =0.14.10 | MIT OR Apache-2.0 | `novad` tests only: certificates are made when the tests run, so no key material is committed |

They pull in `rustls-webpki` 0.103.15 (ISC), `rustls-pki-types` 1.15.1 (MIT OR Apache-2.0),
`untrusted` 0.9.0 (ISC), `getrandom` 0.2.17 and `cc` 1.8.0 (MIT OR Apache-2.0), and, for `rcgen`
in tests only, the ASN.1, parsing and time crates in the lockfile, all permissive (MIT,
Apache-2.0, or both). Web Push (RFC 8291,
RFC 8292), the OIDC token checks and the APNs and FCM senders use `node:crypto` only. No GPL or
AGPL dependency was added.

### 3.3 M7.5: no new third-party code (ADR-096)

M7.5 adds no third-party package or crate. `ring` 0.17.14, already in `novad`'s build through
`rustls` (§3.2), becomes a direct dependency for the one SHA-1 the WebSocket handshake of the
browser's DevTools relay requires, so the lockfile gains no crate. The browser extension
(`apps/extension`, `@nova/extension`, AGPL-3.0-or-later like the rest of the repository) is our
own code with no dependencies of its own; its icon is drawn by our own script
(`scripts/icons.mjs`), and it carries no third-party asset, text or trademark. The Redfish, IPMI,
iPXE, UEFI and firmware-attributes support is written from the public specifications and the Linux
kernel's documented `sysfs` interface; the programs Nova calls (`ipmitool`, `efibootmgr`,
`bootctl`, `grub-reboot`, `fwupdmgr`, Chromium) are run as separate processes on the user's
machine and are neither bundled nor linked.

### 3.4 M8: SDK licensing, no new third-party code (ADR-097)

M8 adds no third-party package. Extension code runs in `quickjs-emscripten`, already a dependency of
`script.run` (§3.2). Two new workspace packages carry their own licenses:

| Package | License | Why |
| --- | --- | --- |
| `packages/sdk` (`@nova/sdk`) and its sample extension (`examples/hello`) | Apache-2.0 | Types and a test host only, with no dependencies, so an extension under any license can build against it without taking on the AGPL |
| `packages/cli` (`@nova/cli`, the `nova` command) | AGPL-3.0-or-later | It imports `@nova/core` |

The sample catalog's third-party items (`Release notes`, the `Aurora` theme, the `word-count`
extension of a made-up "Example Labs" publisher) are our own code and text, signed with test keys
whose private halves are fixtures marked fake. Extensions, plugins and themes a user installs from a
catalog carry their publishers' licenses; Nova neither bundles nor redistributes them. OAuth 2.0
authorization with PKCE, dynamic registration, server metadata and the `iss` parameter (RFC 6749,
7636, 7591, 8414, 8252, 9207), the SASL XOAUTH2 mechanism for email and OTLP/HTTP with JSON are
written from their public specifications.

## 4. Privacy & data protection

- **No training on user data**, ever. The product states this plainly.
- **Local-first**: content stays on the device unless the user enables a cloud/sync feature.
- **Telemetry off by default**; opt-in only, with a local preview of exactly what is sent.
  OTLP export to a user-named collector is a separate opt-in (FR-223). Apart from the
  update-metadata check (every 6 h, metadata only, can be turned off; `docs/15` §4), Nova
  contacts providers, catalogs, relays and sync services only when the user configures or uses
  them.
- **Data subject rights**: export, correct, delete (with recovery window), and restrict
  processing are all supported locally.
- **Regulatory posture**: designed for GDPR/CCPA compliance. A data map lists every data
  flow (provider, cloud runner, relay, catalog) with purpose, retention, and legal basis.
- **Children**: not directed at children; no age-gated content beyond provider policies.
- **Confidentiality**: E2EE for sync; content-blind servers; secrets never leave the keychain.

## 5. Provider terms of service

- Users connect with their own accounts and keys; the app does not share credentials.
- Respect provider rate limits and content policies; surface provider errors verbatim.
- Do not proxy requests in a way that hides end users from providers.
- Do not resell provider access.
- Route requests to the endpoints the user configured; no undisclosed middleboxes and no vendor
  AI gateway in front of providers (ADR-080).
- Never reuse another application's OAuth client id, and never offer sign-in to a
  subscription plan issued for another application. Nova authenticates with its own registered
  OAuth client where a provider offers one, or with the user's API key; impersonating another
  client breaks provider terms (ADR-080).

## 6. Responsible agent behavior

- Human-in-the-loop by default for consequential actions.
- Built-in, non-overridable safety: no purchases, no account creation, no CAPTCHA bypass, no
  credential changes, no exfiltration of secrets, no destructive system changes.
- Clear disclosure that agents make mistakes; encourage review of consequential output.
- No deceptive behavior, impersonation, or evasion of safety systems.
- Support for a "stop everything" control and a full audit trail.

## 7. Content policy

- The app does not generate or distribute unlawful content; it inherits and surfaces provider
  policies.
- A user-configurable blocklist can refuse categories; defaults are conservative.
- Abuse reporting/telemetry is never automatic; users choose what to share.

## 8. Export & sanctions

- Cryptographic features use standard, auditable primitives (libsodium).
- Export-control classification is the distributor's responsibility; the codebase avoids
  providing offensive tooling by default.
- Optional security-analysis tooling (e.g., decompilers) is user-supplied, not bundled.

## 9. Attribution & notices

- `THIRD_PARTY_NOTICES.md` lists every dependency with its license text.
- Bundled fonts, icons, and models include their licenses.
- The README states that the product is unaffiliated with any third-party product; reference
  products are never named there.

## 10. Agent checklist before merging a feature

- [ ] Implemented from the spec, not from copied source/assets.
- [ ] No vendor trademarks/logos/copy introduced; `node scripts/check-spec.mjs` passes (no
      reference-app names).
- [ ] New dependencies are permissively licensed and added to notices.
- [ ] No secrets committed; CI secret scan green.
- [ ] Data flows documented if new (update `docs/13` data map).
- [ ] Safety defaults preserved (fail closed).
- [ ] Attribution added for any new third-party asset.

## 11. Additional legal considerations (added)

- **Ambient recording.** Screen/audio capture is subject to local wiretap and recording-consent
  laws (some jurisdictions require all-party consent). Capture is off by default, visible, and
  user-controlled; the app shows a consent notice at enable time and documents that the user is
  responsible for lawful use. No covert capture, ever.
- **Smart home & physical actions.** Commands that affect locks, alarms, or safety systems are
  approval-gated; the app disclaims liability for automation outcomes and documents supported
  devices.
- **Community content.** The catalog operates a notice-and-takedown process, publisher key
  revocation, and abuse reporting; it does not endorse third-party extensions. Contributors
  warrant they have rights to their code and assets.
- **Self-improvement & autonomy.** Learning and self-modification are transparent, auditable,
  reversible, and gated; the product does not claim autonomous legal agency, and users remain
  responsible for consequential actions.
- **Domain & branding.** `arialabs.ai` and Nova branding belong to the project owner;
  third-party product names remain excluded per §1.
