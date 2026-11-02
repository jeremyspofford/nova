# Main CI fixture synchronization evidence

This repair addresses two failed checks in main push [41396575075](https://github.com/jeremyspofford/nova/actions/runs/41396575075), following #280’s green PR run. The failed main run was not blindly retried. Application source, credential handling and screenshot baselines are unchanged. This record describes actual local validation and task reviews; the required check on the PR’s final head establishes public CI independently.

## Completion boundaries

The vault-history fixture now awaits the actual promise returned by commitHome. Its old 50ms delay and independent ensureGit call did not establish completion. An owned real Git pre-commit hook demonstrates the missing commit before release and the complete history afterward. Every original secrecy/history assertion remains.

The layout sweep boots once per device and uses the app’s real links between views. It waits for the intended view, seeded content, initial sidebar data and finite animations. Fresh-context deep links preserve direct-load coverage at all ten postures in both engines. Genuine CORS/403 controls and all original error/layout/safe-area/screenshot assertions remain.

Independent review additionally identified that design metadata can complete before CSS installation. The test now waits for the actual enabled parsed stylesheet matching the server’s generation for the intended device/design; it does not install CSS itself. Controlled held-response tests exercise both engines.

A subsequent screenshot failure was reproduced byte for byte by holding the real scheduled Chat callback that removes no-anim. The readiness helper had returned before that callback enabled entrance animations. It now waits for the pending render marker, actual frames and finite animations. A separately reproduced stale ElementHandle race explained an empty style read during the actual Home rerender; the test now reads the current connected card atomically. Expected style values, image masks, channel threshold 48 and 2% tolerance remain unchanged.

## Actual evidence and limits

Source checkpoints: f98c5e0b (initial repair), ad3f0f9b (CSS generation guard), 801c1a62 (render boundary), 5771cdd8 (atomic current-card style read). Cited commits were preserved rather than amended.

- Final affected browser command: fold-render, fold-navigation and fold-postures; **9/9 passed, zero skips/failures**, 364 audits (184 original sweep plus 180 fresh deep links), six designs/all widths/live swaps,20 unchanged baselines and safe-area checks. Chromium duo-cover Chat is0.40%, below the unchanged2% limit.
- Focused final browser controls 5/5; final typecheck, diff and scope checks passed. Outer Kubernetes tripwire never fired.
- Vault 11 passed with one pre-existing environment-only desktop-keychain skip. The owned Git gate, unchanged secrecy assertions and actual commit completion pass; no real keychain was accessed.
- Observed RED evidence includes the missing Git commit, exact WebKit teardown errors, held-CSS early completion, byte-identical missing Chat paint and both engines’ detached-card style failures. Previous covering 7/8 and 8/9 failures, a stopped owned-container selector failure and an overwritten initial TypeScript-log caveat remain disclosed. Later success does not rewrite them.

[Initial independent review](../reviews/main-ci-fixtures-independent-review-2026-11-02.md) found the CSS race; [rereview1](../reviews/main-ci-fixtures-rereview1-2026-11-02.md) closed it while retaining the screenshot blocker; [rereview2](../reviews/main-ci-fixtures-rereview2-2026-11-02.md) closes the render/style findings with no new findings. Exact commands, protocols, intermediate failures and final source scope are in the [implementation report](../reviews/main-ci-fixtures-implementation-2026-11-02.md).

Controlled experiments establish sufficient causal orderings, including the exact failed PNG, but do not recover historical event/frame traces. The original CI playbook-at-unload attribution remains an inference. HTTP200 alone does not disprove CORS; no error filter or production lifecycle correctness claim is introduced. No real cluster, credentialed deployment or full M10j gate is proved; #275 remains parked for findings B.
