# Astra audit baseline and test boundary

- Request: comprehensive independent audit only. No product implementation or PR mutations.
- Review date: 2026-11-09 (client timezone America/New_York).
- Repository: https://github.com/jeremyspofford/nova
- Existing checkout: `/workspace/nova`; tracked status clean when inspected. No resets, cleans, or product edits.
- `git fetch origin main` succeeded. Frozen source: `d948aa0a442a9f930b86f4516eeea21981b76714`, merge PR #438, 2026-11-09T15:23:15-05:00.
- Clean detached worktree created at `/workspace/nova-audit-astra`. Audit output lives in `audit-astra/`; node_modules links to the existing dependency installation.
- Node pinned by mise: 26.3.1; installed tool at `/workspace/.nova-tools/node-v26.3.1-linux-x64/bin/node`. Chromium available at `/usr/bin/chromium`.
- Expected owner preview `http://localhost:4318/api/v1/version`: connection refused in this cloud machine. No listeners on 4318 and no `~/Nova-preview/deploy-watch.log`. Owner host deployment commit and Health stamp are BLOCKED, not inferred from source.
- Review runtime will use a newly created temporary home and port 4418. No existing Nova home or review fixture is reused.
- Existing review directory names were incidentally listed during initial workspace discovery before the pasted instructions were opened; their contents were not read and are excluded from evidence.
- Sensitive whole-system threat model is excluded from context, searches, screenshots and output. This limits whole-system security assurance.
- No real model calls, research evals, model pulls, paid services or live external integrations. Synthetic model fixtures are explicitly labeled; they prove orchestration only.
- Destructive/restore/failure diagnostics use separate temporary homes or in-memory fixtures. No shared preview reset, deletion, outage or mutation.
- PR #207 is a read-only proposal reference, not shipped behavior and not a task artifact to update.

Evidence terms: **observed** = this audit's runtime interaction; **code-supported** = traced source path; **documented** = promised behavior; **hypothesis** = bounded investigation; **proposal** = new product work.
Every source finding applies to the frozen merged baseline. Runtime observations apply to the disposable instance of that same source; none establishes owner-deployed behavior.

Completion read-back: final `git fetch origin main` still returned `d948aa0a442a9f930b86f4516eeea21981b76714`. Audit runtime Health and `/api/v1/version` agree on that commit. Its `latest:null` is expected for a direct-start fixture with no deploy-watcher record. All tracked product files were unchanged at final inspection; generated M9 shots were copied into this audit and only their tracked originals restored. Runtime homes and browser profiles are not part of the package. Audit-owned main server/browser were stopped after evidence capture.
