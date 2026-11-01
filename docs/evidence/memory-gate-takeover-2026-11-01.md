# Memory-gate takeover verification — 2026-11-01

M10h #276 merged at `a62b4d4821106bc9b50d9c19c72fc296b4f5f93d`; #277 follows it in track order. No memory consumer is wired and no model or eval
was rerun. This update merges `origin/main` again at `a62b4d48` (including approved design stage 1 and M10h), preserves evaluation history, and adds its plain-language LEDGER
entry, decision record and inventory note.

- `git merge-base --is-ancestor 7d587168 HEAD`: exit 0 (template/rule/bounds).
- `git merge-base --is-ancestor 6392c6b0 HEAD`: exit 0 (cases before the run).
- `git merge-base --is-ancestor ebae919a HEAD`: exit 0 (results).
- `git diff ebae919a -- src/core/decision-service/templates/memory-gate.ts
  tests/ingest/memory-gate-eval docs/evidence/memory-gate-eval.json
  docs/evidence/memory-gate-eval.md`: empty.
- `sh scripts/test.sh tests/core/memory-gate.test.ts
  tests/ingest/memory-gate-eval.test.ts tests/core/decision-service-v2.test.ts`:
  23 passed, 0 failed; no-Kubernetes tripwire armed, never fired.
- `npm run typecheck`: exit 0; `git diff --check`: exit 0.

Commands used Linux Node 26.3.1 from the existing Mise installation. `tev1:4b`
passes only at its recorded digest: 0/49 false saves, 25/26 recall, ECE 0.082.
`tev1:0.8b` fails with 0/26 recall. The false-save interval reaches 7.3%, three
contradictions were skipped, and one author wrote questions and cases.

Main was merged, never rebased, and both ledger entries were retained. Require green CI on the exact final head. Never rebase this
branch. Then merge with `--match-head-commit`, restart the preview as the handoff
specifies, and verify `/`, `/api/v1/health` and mesh hello. The runner/server wiring
and candidate-reason migration are queued explicitly in `docs/plans/track1-follow-up-queue.md`.
