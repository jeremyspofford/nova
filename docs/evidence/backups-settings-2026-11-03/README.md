# Backups settings — Task1 rendered entry

Design preparation only: `/styleguide?entry=backups-settings`, anchor `#sg-backups-settings`. The shared renderer is not composed into app navigation/state/API flows by this task. The current [I1 loading correction and source-matched evidence](ci-i1-loading/README.md) use the existing shared wait primitive and caller-owned request timestamp.

The entry uses existing SettingsRow, input, button, confirmation and code-block patterns. Its fixtures use neutral paths and one public dummy key in the actual 64-hex-character/eight-group format. A paired approver can see the initial setup key once; repeated reveal is offered only to the console and requires the explicit tier-3 checkbox.

## Original 525a52e2 evidence — historical

The following full matrix describes the original commit. It is preserved unchanged, rather than relabeled as current-source evidence after I1.

- [112 final PNGs and source/PNG hashes](screenshots.json): 14 states × Chromium/WebKit × phone 390×844, desktop 1440×900, tablet 820×1180, half-open 842×675. PNGs are full-page captures at those viewport sizes; time is fixed at `2026-11-03T12:00:00Z`.
- Every state: `loading`, `empty`, `configured`, `saving`, `error`, `first-key`, `confirm`, `shown`, `paired-viewer`, `paired-approver`, `paired-first-key`, `standby`, `unavailable`, `long-paths`.
- [Chromium](chromium-matrix.json) and [WebKit](webkit-matrix.json): each 336 state/theme/posture combinations. All six installed packages use Auto mode with a dark OS preference. All tested text contrast ratios are at least 5.95:1; page bounds, text wrapping, unique IDs, form structure and enabled control heights pass.
- [Browser output](browser-release.txt), [exact command/environment/source hashes](browser-release-command.json): 4 tests passed, zero failures/skips. Includes local save/confirmation/hide/copy-demo interactions and 40 component axe scans (five representative states × four postures × two engines, in the final Paper preview).
- [Renderer and styleguide coverage](unit-release.txt): 13 passed, zero failures/skips. [Earlier affected unit/scale checks](unit-green.txt): 21 passed.
- [Final token/syntax/theme/typecheck checks](gated-static.txt) passed. [Runtime versions/environment](runtime-provenance.txt): cached Playwright 1.56.1 image, Node 26.3.1, matched read-only dependencies; no install or image pull.

Every invocation used network isolation, read-only code/Node/dependencies, a private temporary HOME, file-key mode and the Kubernetes tripwire. Browser/unit runs preloaded the Node egress guard. Early static checks omitted that preload; the final static check corrects this with explicit NODE_OPTIONS, retaining the earlier audit records. Final egress logs were empty. All previous failures, exact invocations, output and image manifests remain in the private Task1 audit. The committed screenshots are the final source-matched matrix; duplicate intermediate matrices are omitted.

## Slop check — one Backups specimen

| DESIGN-SYSTEM §0.4 item | Result | Evidence |
|---|---|---|
| Equal-weight card grids | pass | Settings are divider-separated rows. |
| Everything centered | pass | Labels, fields and actions align left. |
| Decorative gradients | pass | No new gradient; existing page background only. |
| Multiple standouts | pass | Save is the only primary control. |
| Flat type hierarchy | pass | View title, group captions and setting labels use the existing scale. |
| Off-scale spacing | pass | Token/scale lint passes. |
| Mixed icon styles | n/a | This component introduces no icons. |
| Placeholder empty states | pass | No-folder state explains what is true and the next action. |

## Limits

This proves the pure view and local specimen behavior. It does not prove app reachability, live backup saving, filesystem checks, real role authorization, key visibility across navigation/SSE, draft/focus preservation across app refreshes, clipboard operations or installed-device behavior. These belong to the approval-gated app task. Automated axe and computed contrast checks do not constitute a complete accessibility certification. Other packages' existing scale/approval debt is unchanged.
