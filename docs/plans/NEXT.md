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
| 6b patch grader | **UNBLOCKED** — see below |
| 7 ACP coding sessions, private clone | **done** — `#20` phases 0-2, mig 079/080 |
| 8 staging stack + verification | needs `#31` backups |
| 9 branch push + real GitHub PRs | prerequisite `#32` now **met** |

**Start here: `#20` phase 3 — policy engine + review surface**
(`docs/plans/acp-coding-delegation.md`). Phases 0-2 shipped 2026-07-31 and the
phase-0 findings are appended to that plan; read them before touching this,
because the headline changed the design: **ACP cannot confine an agent**, so
the container is the boundary and the permission layer is defence-in-depth on
top of it. Two concrete gaps phase 3 closes:

- **Command execution is denied wholesale.** The broker's path adjudicator
  approves a request whose paths all land inside the private clone and denies
  everything else — including any request that names NO path, which is what a
  command looks like. So the agent cannot run the tests it just wrote. An
  allowlisted command set is the fix, and it has to be enforced at the broker
  (`coder/acp.py::_decide`), not described to the agent.
- **The diff has no review surface in chat.** Library → Coding shows state,
  branch and diffstat; a session report that renders the denials and a
  copyable `git diff` invocation is what makes the operator-merge gate usable
  rather than nominal.

**Why 6b is unblocked.** A patch grader must apply a patch somewhere, and the
backend can reach only `/app/backend` and `/app/data` with neither `git` nor
`patch` in the image. The coder sidecar now has both, plus a private clone per
session — so the grader has a place to stand. Jeremy's choice of a mechanical
grader over eyeballing stands; the order is what changed, and it changed back.

## Decisions waiting on Jeremy

0. **`CODER_API_KEY` needs a key of its own.** It is set in `.env` and holds a
   COPY of `OPENROUTER_API_KEY` — that is what phase 1 was verified against
   and it works. It is the wrong long-term shape for one reason: a coding
   session is unbounded spend against the same budget Nova's own turns draw
   on, so a runaway or looping session degrades ordinary chat rather than just
   costing money. The fix is an OpenRouter key with its own spend cap pasted
   into `CODER_API_KEY`; nothing else changes, because the `coder` service in
   `docker-compose.yml` already reads it as a separate variable. Only Jeremy
   can mint it. **Also in that block:** `NOVA_CODER_TOKEN`, the broker's
   shared secret — already generated, must stay set, and unset means the
   broker refuses every request (which is the intended failure direction).

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

## Operational state, 2026-07-31

- `#20` phases 0-2 shipped and pushed (`f56e3cf..3571827`, six commits also
  carrying the workloads SA scrub, the guardian charter fix and the ruff
  clearance). The `coder` sidecar is an OPTIONAL compose profile: a stack
  without it behaves exactly as before, because `coder.configured()` derives
  from the credential rather than a flag.
- One repository is registered (`nova` ->
  `https://github.com/jeremyspofford/nova.git`). Sessions clone it fresh from
  the remote, so the agent sees COMMITTED work only — uncommitted local
  changes are invisible to it by design.
- A goal named "Coder Sidecar Access" is ACTIVE (approved during phase-2
  verification) and pre-authorises `delegate_coding_task`. Revoke it if
  unattended coding is not wanted right now.
- 36/36 backend suites pass. `ruff check backend/` is clean except
  `tests/test_model_binding.py:20`, which belongs to a parallel session's
  uncommitted work and is theirs to clear.

## Operational state, 2026-07-30

- k3d cluster `nova` is up: Calico CNI, `nova-workloads` namespace, boundary
  applied and empty. `workloads/setup.sh --recreate` rebuilds the whole thing;
  the credential it writes to `data/runtime/` is gitignored.
- Backend reaches the cluster at `https://host.docker.internal:6550` as the
  `nova-deployer` ServiceAccount. A fixed api-port is why that survives a
  cluster recreate.
- 34/34 backend suites pass.
- Automations recovered from the OpenRouter budget outage; streaks at 0.
