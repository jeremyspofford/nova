# Spec compliance: Pass

**Code/design quality: Approved for Task 1.**

Pinned head: `690c8458a528391934e91ea4ccd484947ab39c89`. Fix base: `621653a8`. This scoped review verifies the action-tier correction and new breakage in that fix only. The earlier review missed the capture rollback mismatch; its approval must not be read as validation of that former behavior.

## Verified correction

The binding ADR assigns capture promotion tier 3 and a person-requested rollback tier 2: `docs/plans/M10-orchestration.md:45`, `docs/plans/M10-orchestration.md:48`. The existing manager explicitly identifies manual rollback as tier 2 at `src/core/services/manager.ts:140`. These were focused outside-diff reads to resolve the concrete approval-tier mismatch, not a broader backend review.

| Action | Required | Verified specimen |
|---|---|---|
| Ordinary-service promotion | Tier 2 | Tier 2; enabled Approve, no tier-3 checkbox |
| Capture promotion | Tier 3 | Tier 3; explicit confirmation gates approval |
| Ordinary-service manual rollback | Tier 2 | Tier 2; enabled Approve, no tier-3 checkbox |
| Capture manual rollback | Tier 2 | Tier 2; enabled Approve, no tier-3 checkbox |

- `ui/js/styleguide.js:165` corrects the capture rollback selector label to tier 2. `ui/js/styleguide.js:212` supplies tier 3 only when the selected action is promotion and the service is capture; the other three cases supply tier 2 to the existing approval component.
- `ui/js/topology-view.js:45` now describes promotion and manual rollback separately. Ordinary services name tier 2 for both actions; capture names tier 3 for promotion and tier 2 for manual rollback. Historical observation wording and status continuity remain intact.
- `tests/ui/m10i-styleguide.test.ts:90` uses an explicit four-case expected tier table and checks the rendered sheet tier, approval enabled/disabled state and confirmation-checkbox presence. `tests/ui/m10i-styleguide.test.ts:159` additionally follows capture promotion back to versions, opens rollback, verifies tier 2 without the checkbox, and submits the inert specimen. The existing mutation-request assertion remains after this path.

## Rendered review

Inspected actual changed renders under `docs/screenshots/m10i-styleguide/`:

- `chromium/rollback-capture-phone.png`
- `webkit/rollback-capture-desktop.png`
- `chromium/capture-phone.png`
- `chromium/specimen-attention-service-phone.png`
- `chromium/specimen-service-phone.png`

The capture rollback sheet visibly says tier 2 in its selector, presents Approve as its primary action and has no tier-3 confirmation checkbox. The capture and stale-capture action copy distinguishes promotion from rollback; ordinary-service copy names both tier-2 actions. Updated wording wraps without clipping or obscuring controls. Stale detail still presents the age, both source reasons, Needs you and qualified historical version facts.

The changed surfaces retain the eight §0.4 outcomes: divided lists, left alignment, no added gradients, one primary action per sheet, clear type hierarchy, existing token spacing, no new icons, and unchanged truthful empty states. No design or security regression was identified in this fix; the approval action remains illustrative rather than connected to the application.

## Evidence and limits

- Read the updated task brief/context, appended round-2 implementation report and supplied diff once in two sequential sections. No changed source files were reread and no Git commands were run.
- The RED log records both engines failing `rollback-capture: action-specific ADR tier`: `.superpowers/sdd/M10i/task-1-fix2-red.log:20` and `:37`.
- The final GREEN log records 5/5 passing tests, no failures/skips and an unfired no-Kubernetes tripwire: `.superpowers/sdd/M10i/task-1-fix2-green.log:2`. The reviewed test matrix covers 392 combinations plus navigation paths. No browser suite was rerun for this review.
- The static log records passing token lint, theme validation, typecheck and 13/13 coverage/UI-review tests. The previously established Node-only localStorage warning remains disclosed and unsuppressed at `.superpowers/sdd/M10i/task-1-fix2-static.log:18`; it is not newly introduced by this fix.
- Cannot verify owner rendered approval: it remains pending. This verdict clears the independent Task 1 review gate at the pinned SHA, not application integration or the deferred backend/export/live-action/performance work.

**Open actionable findings: none.**
