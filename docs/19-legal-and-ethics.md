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
   evidence ledger, never by name in the shipped spec.
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

## 4. Privacy & data protection

- **No training on user data**, ever. The product states this plainly.
- **Local-first**: content stays on the device unless the user enables a cloud/sync feature.
- **Telemetry off by default**; opt-in only, with a local preview of exactly what is sent.
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
- Route requests to the endpoints the user configured; no undisclosed middleboxes.

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
- The README states that the product is unaffiliated with the named source products.

## 10. Agent checklist before merging a feature

- [ ] Implemented from the spec, not from copied source/assets.
- [ ] No vendor trademarks/logos/copy introduced.
- [ ] New dependencies are permissively licensed and added to notices.
- [ ] No secrets committed; CI secret scan green.
- [ ] Data flows documented if new (update `docs/13` data map).
- [ ] Safety defaults preserved (fail closed).
- [ ] Attribution added for any new third-party asset.
