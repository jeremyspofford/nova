# Passkey confirmation for tier 3 (proposed, 2026-11-03)

Design-first specimen for Insertion #3 T2. Living entry: `/styleguide?entry=passkey-approval`. Captured by `tests/ui/passkey-styleguide.test.ts` with `NOVA_PASSKEY_STYLEGUIDE_SHOTS`, orb-teal theme, dark scheme, before any interaction, pointer parked.

- `chromium/<state>-phone.png`, `chromium/<state>-desktop.png`, `webkit/<state>-phone.png`
- Confirmation states: ready, waiting, cancelled, failed, expired, no-passkey, unavailable, rate, confirmed
- Setup states: setup-start, setup-waiting, setup-added, setup-failed, setup-unavailable

The test also covers tablet and half-open postures and all six themes in both engines (geometry, 44px targets, unique ids, axe on the entry); those 112 raw captures are kept privately. Each image shows the tier-3 sheet with its passkey step beside the unchanged tier-2 sheet.
