# NEXT — what to pick up, and what it is waiting on

Rewritten 2026-07-30. The previous version was a lane dispatcher for three
parallel sessions (turn-speed, eval-pipeline, eval-suites); all three landed
long ago and it had gone stale enough to mislead.

`ROADMAP.md` stays the priority list and the plan docs are the how. This file
answers one question: **what is actually next, and what is blocking it.**

## Standing rules

- Leave changes UNCOMMITTED and summarize; Jeremy decides when to commit.
- A parallel session often shares this checkout. Never `git add -A`; stage by
  explicit pathspec and check `git show --stat` after. When a file is edited by
  both, split the diff into hunks, classify by whose markers the added lines
  carry, and `git apply --cached` only yours — then prove the staged tree
  compiles before committing, because it differs from what is on disk.
- Verify in the running app, not just in tests. `:5173` gets frontend changes
  by HMR; `:8080` needs `docker compose build web && docker compose up -d web`.

## The critical path: capability acquisition

`docs/plans/capability-acquisition.md` — Jeremy's 2026-07-29 ask (read her own
code, propose, build, PR; and figure out how to do a thing nobody built).

| Phase | State |
|---|---|
| 1 `maintainer` reads her own source | **done** (mig 065/066) |
| 1b goal-scoped autonomy | **done** (mig 067/068) |
| 2 her own k3s runtime + boundary | **done**, attacked, holding (Calico) |
| 3 workload tools + `deployer` agent | **done** (mig 069) |
| 4 acceptance test | **run, passed**, found the egress gap |
| 5 acquisition router | **done** |
| 6a `propose_patch` | **done** (mig 071) |
| 6b patch grader | **blocked on 7** — see below |
| 7 ACP coding sessions, private clone | **next**, needs the `#20` phase-0 spike |
| 8 staging stack + verification | needs `#31` backups |
| 9 branch push + real GitHub PRs | prerequisite `#32` now **met** |

**Start here: `#20` phase 0 — the ACP validation spike**
(`docs/plans/acp-coding-delegation.md`). It is a spike on purpose: the ACP
landscape moves monthly and the findings may reshape phase 7. Two corrections
already apply to that plan and must survive the spike — a git worktree is NOT a
portable containment unit (clone into a private volume, export with `git
bundle`), and the ACP `auto` permission mode is banned.

**Why 6b waits for 7.** A patch grader must apply a patch somewhere. The
backend can reach only `/app/backend` and `/app/data` — no frontend, no repo
root, no `.git` — and neither `git` nor `patch` is in the image. Built now it
would score backend Python and silently ignore everything else, and a partial
pass reads as a pass. Phase 7 creates the writable clone; the grader then has a
place to stand. Jeremy's choice of a mechanical grader over eyeballing stands —
only the order changed.

## Decisions waiting on Jeremy

1. **CLI secret managers.** 1Password and Bitwarden/Vaultwarden are registered
   but gated: neither `op` nor `bw` is in the backend image, so they need
   either those binaries added or a small sidecar to hold them. There is also
   no account here to verify a resolver against. Adding one is a resolver
   function and a CHECK entry once that is settled.
2. **`NOVA_SECRET_KEY`.** Unset, so a per-host key was generated at
   `/state/secret.key`. Fine for one machine; a second instance sharing this
   Postgres will not decrypt those rows. Set it in `.env` before the Dell or
   the mini PC joins.
3. **The 177 unused transcripts.** `review-memory-usage` raised a card: four
   followed channels, 177 documents, zero retrievals against journals' 17
   documents and 75 retrievals. Whether those channels earn their slot is a
   product call.
4. **`review-memory-usage` is enabled** and I did not enable it (I seeded it
   disabled). Leave it on, or switch it back off until the weekly cards are
   wanted?

## Small, self-contained, unblocked

- **Automation toggles leave no trace.** `automations.py` has zero references
  to `capability_events`, so enabling or disabling an automation — literally
  "unattended future turns", which is why it is in `ACTOR_TOOLS` — is recorded
  nowhere. Found while trying to work out who enabled `review-memory-usage`,
  and I could not. Small fix, same principle as everything else.
- **Journals are orphans in the graph.** 15 of 15 connect to nothing
  (`operator-identity.md` part 3). Arguably correct — a journal is a
  transcript, not a subject — but it means the graph has no view of what was
  discussed, which is worth deciding rather than inheriting.
- **`operator-identity` phase 3** — the invented-policy detector. Conditional
  by design: build it only if the identity block and capture (both shipped)
  have NOT stopped her improvising design claims. Check the logs first.
- **`transcript-summaries` open question** — whether retrieval should prefer a
  summary over its raw transcript is now moot for duplicates (they collapse),
  but the ranking question underneath it was never measured.

## Operational state, 2026-07-30

- k3d cluster `nova` is up: Calico CNI, `nova-workloads` namespace, boundary
  applied and empty. `workloads/setup.sh --recreate` rebuilds the whole thing;
  the credential it writes to `data/runtime/` is gitignored.
- Backend reaches the cluster at `https://host.docker.internal:6550` as the
  `nova-deployer` ServiceAccount. A fixed api-port is why that survives a
  cluster recreate.
- 34/34 backend suites pass.
- Automations recovered from the OpenRouter budget outage; streaks at 0.
