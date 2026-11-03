# Backend caps and diagnostics evidence

This records reviewed backend activation, the discovered diagnostics disclosure and its fail-closed repair, and a test-only qualification adjustment. Health controls and their rendered-entry decision remain in285. No full CI/merge/preview result is inferred from local runs.

- [Initial integration report](task-1-report.md) and [whole-branch review](final-review.md).
- [Single production fix-wave report](final-fix-report.md) and [scoped review](final-fix-review.md).
- [Adjudicated R1 fixture report](evidence/final-fix/task-2-fixture-report.md) and [independent fixture approval](task-2-fixture-review.md).
- [Exact new artifact hashes](manifest.json), raw launch records/stdout/stderr and retained failed fixtures under evidence/. These are audit examples, not runtime source. Historical synthetic Git objects include only the real commit object named by their record, localconfig andHEAD; replay may need the documented empty refs directory. They contain no shared Git history/config/credentials.

All new runtime evidence uses cached network-isolated containers, private homes, fake services and explicit readonly code/dependency mounts. Initial29/30 failure and missing-Git probe128 are preserved; only affected diagnostics reran2/2 after the synthetic metadata correction. Production security fix28/28 and fixture1/1 passed with compiler checks. Every run preserves its actual status; no combined30/30 or hosted final-head result is claimed.

Original #285 backend history remains at [pinned source1572](https://github.com/jeremyspofford/nova/tree/1572f294d319791bfaa73ccf224335eb06eb1bbc/docs/evidence), including original test-first reports, review and raw outputs. The byte-verified45-file/144285-byte original-health audit snapshot remains private and its full hash manifest is included with these records; original historical isolation limits are not upgraded into a new no-contact claim. The original optional npm available-update notice stays preserved; future notifier suppression is not compiler-warning suppression.
