# Health cost caps and diagnostics specimens

Review addresses: `/styleguide?entry=work-costs` (`#sg-work-costs`) and `/styleguide?entry=diagnostics` (`#sg-diagnostics`). These are local fixtures only; saving and downloading have no live effect. Owner recognition of both rendered entries was recorded before Task 4 app composition; see the separate [app proof](../../../evidence/health-app-2026-11-03/README.md).

Accounting scope, aligned with the implemented Caps API: **Nova runner usage on this machine; provider-managed tasks are not included.** Their reports live outside these Caps totals, so reporting usage elsewhere in Nova does not make it appear here. The visible scope, expanded explanation and fixtures reflect `accounting.scope: this-node-runner` and `provider_reports_included: false`. These captures supersede the earlier conditional-report wording; geometry and controls are unchanged.

120 full-page PNGs: Chromium and WebKit, each at desktop 1280×820, phone 390×844, tablet 820×1180, and half-open 1100×900. PNG height grows with the full page. All screenshots use the default Orb Teal design and dark system preference. [manifest.json](manifest.json) lists exact paths, dimensions, byte counts and SHA-256 hashes.

- Work costs: loading, unavailable, zero, mixed, configured, unlimited, invalid, saving, save-error, success, adversarial, and expanded details.
- Diagnostics: available, unavailable, and expanded privacy details.
- Files: `<engine>/<entry>-<state>-<posture>.png`; expanded disclosures use `details` for the state.

Start with [work costs on phone](chromium/work-costs-mixed-phone.png), [work costs on desktop](chromium/work-costs-mixed-desktop.png), [scope details](chromium/work-costs-details-desktop.png), [invalid input](chromium/work-costs-invalid-phone.png), [diagnostics on phone](chromium/diagnostics-available-phone.png), and [privacy details](chromium/diagnostics-details-desktop.png).

Capture: `NOVA_HEALTH_STYLEGUIDE_SHOTS=1` with `tests/ui/health-styleguide.test.ts` in the cached Playwright 1.56.1 image. No global `NOVA_UI_SHOTS`, baseline updates, or changes to previous screenshots. The dedicated test performs finite/Unlimited edits, tap/click save, keyboard/tap/auxiliary download activation, provider-name escaping, appearance-redraw preservation, and page/text overflow checks. It forbids mutation requests and reads of the real caps/diagnostics routes. The public limit fixtures are checked against Core’s `DEFAULT_LIMITS` without importing Core into the browser.

## Design self-check

| Slop criterion | Work costs | Diagnostics |
| --- | --- | --- |
| Equal-weight card grids | Pass: one existing panel; usage and limits are settings rows. | Pass: one existing panel with one download. |
| Centered content | Pass: copy, fields and tabular totals align left. | Pass: copy and action align left. |
| Decorative gradients | Pass: no new gradient; token lint passes. | Pass: no new gradient; token lint passes. |
| Multiple standouts | Pass: one plain Save limits action. | Pass: one plain Download diagnostics action. |
| Flat type hierarchy | Pass: entry title, caption groups, row titles and secondary metadata use existing scales. | Pass: entry title, description and smaller diagnostic detail use existing scales. |
| Off-scale spacing | Pass: existing tokens; token lint passes. | Pass: existing tokens; token lint passes. |
| Mixed icon styles | N/A: no added icons. | N/A: no added icons; native disclosure marker. |
| Placeholder empty states | Pass: zero and unavailable explain what is recorded or why editing is disabled. | Pass: unavailable explains when to retry. |

Limitations: these are specimens, not proof of app reachability, live enforcement, successful persistence, route access control, or a real diagnostics attachment. Other designs, installed iOS behavior and a formal accessibility audit are outside this focused capture. Both entries were subsequently owner approved. These original specimen captures remain unchanged; app reachability and real save/download proof are recorded separately.
