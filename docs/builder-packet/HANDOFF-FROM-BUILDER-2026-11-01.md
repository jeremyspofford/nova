# Handoff from the builder, 2026-11-01

This note is the tacit layer for the next builder and coordinator. It doesn't repeat the packet or the LEDGER: read START-HERE, OPERATING-RULES and the LEDGER first.

**State of main:** `6d51c5d1` (after #272, M10g), schema 22.

**Preview:** http://localhost:4318, running that commit.

## 1. Agents working at handoff

All of them work in worktrees under `.claude/worktrees/`, and each was told to commit and push a WIP checkpoint. Subagents don't survive the coordinator's session. If you can't resume them, start fresh builders from the branch heads below; each branch is self-describing via its plan file and PR body.

| Agent's job | Branch / worktree | Expected result | Safe unattended? |
|---|---|---|---|
| **Track 1:** M10h, native workloads and the capture pilot | `m10h/native-workloads`, `agent-a9c3e0c636b49a566`, PR #276 at `4d060ccd` (clean tree) | Green CI, then STOP. The PR says "don't merge: an adversarial review follows". | Yes. It only fixes CI on its own branch. |
| **Track 3:** vault broker Phase 1 PR 1, fixing the adversarial review | `vault/broker-phase1`, `agent-a7c2f37550936a695`, PR #275 at `7b39b0c3` (clean tree) | Each finding pinned by a failing test, then fixed. Evidence and claims narrowed. Green CI. | Yes. It's on its own branch, and the merge decision is yours. |
| **Track 1:** design quality, stage 1 | `design/quality-system`, `.claude/worktrees/design-quality-system`, pushed to `fc60d222`, no PR yet | One design PR with §0, the slop list, the styleguide, the Orb Teal values pass and the token lint, plus screenshots for the owner | Yes. It must not merge. It was still editing at handoff (3 uncommitted files), so check `origin/design/quality-system` for its last checkpoint. |
| Track 2: memory-gate eval | `ds2/memory-gate`, `agent-a82d637a13ec33c49`, PR #277 at `878b4bf4` | Done: CI green, not merged | Nothing is running. |

## 2. In-flight branches

**`m10h/native-workloads` (#276)**
- **Intent:** M10-orchestration Point 6, Decisions 1 and 4, plus the capture data path design's M10h gate list. Plan `docs/plans/M10h.md`, evidence `docs/evidence/m10h-gate.md`.
- **Done:**
  - the boot agent's five verbs for hub-signed workloads;
  - runtime rollout;
  - the hub `device` driver;
  - Screenpipe's definition, on a stand-in;
  - the capture data path, with signed batches and tombstones;
  - migration 0023;
  - a three-device pilot test.
- **Remains:**
  - green CI;
  - an independent adversarial review: spawn one with the code, not its claims;
  - fixes from that review;
  - the LEDGER plain-language entry, written by you at merge;
  - the preview restart.
- **Traps:**
  - CI on `4d060ccd` failed only `tests/core/m10d-review.test.ts:353` (snapshot.json missing). That's an existing time-dependent test; see §5.
  - The UI gate needed several reruns.
  - Check that migration 0023's new columns are in `ADDED_COLUMNS` in `src/core/mesh/sync.ts`, so a standby one release behind still syncs.

**`vault/broker-phase1` (#275)**
- **Intent:** vault broker Phase 1, PR 1 of 3: the broker process, Nova Vault, fixed verbs and IPC. ADR `docs/plans/vault-broker.md`. The review packet, `docs/reviews/vault-broker-phase1-review-packet.md`, was given to the owner for ChatGPT or Gemini; their findings come back as owner input.
- **Done:**
  - the first adversarial review, from reading only, because the disk was full;
  - five blocking findings:
    - B1: core could redeem the run ticket and get the value;
    - B2: migration answered guesses and created items without approval;
    - B3: the scrubber echoed core's own text back to it;
    - B4: a planted inbox replaced the hub's vault;
    - B5: `health.reused` and `weak` answered guesses;
  - the builder's commit `7b86dac8` fixes B1–B5, S1–S3, S5 and the minor ones.
- **Remains:**
  - **S4:** checkpoints keep the old vault, its key and Era 2's Gmail tokens after migration.
  - **S6:** delete with holders, which overstates C7.

  Both may be fixed or deferred as limits; check the PR. Then:
  - a SECOND adversarial review, this time with live probes in temp homes;
  - the owner's second-model findings;
  - apply the branch's NOTES for Track 1 at merge:
    - supervisor start;
    - factory reset removes `broker/` (plus a `SKIP_TOP` entry in `checkpoints.ts`);
    - `broker` added to `SECRET_DIRS` in `src/home.js`, for the file tools;
    - diagnostics;
    - console serving `seal.ts`;
    - LEDGER, ROADMAP and inventory text.

  PRs 2 (core uses the broker, plus the browser relay) and 3 follow.
- **Traps:**
  - The size budget is about 3,000 lines, and was about 2,520 before the fixes.
  - CI on `7b39b0c3` failed only `tests/acceptance/m10g-review2.test.ts:154` (R13). That's an existing timing test; see §5.

**`design/quality-system` (no PR yet)**
- **Intent:** the owner direction `INPUT-2026-11-01-DESIGN-QUALITY.md` and its diagnosis `nova-design-quality-system-2026-11-01.md`. Both are filed verbatim on this branch: the diagnosis's original sits untracked in the clone root's `docs/builder-packet/`, so leave that copy alone.
- **Sequence:** stage 1, one PR the owner reviews as screenshots. The design-first workflow rules take effect for the next new surface after it merges, and existing surfaces are conformed opportunistically, not rewritten.
- **The builder was also told to:**
  - mark the exemplar set "proposed 2026-11-01, owner may amend";
  - give each styleguide entry its own anchor;
  - word the slop list so it can be scored item by item;
  - show the UX review's symptoms (the composer ellipse, the flat orb, six equal themes, density without hierarchy) fixed or not, before and after.
- **Remains:**
  - the build;
  - the PR;
  - sending the screenshots to the owner;
  - the owner's approval, then the merge.

**`ds2/memory-gate` (#277)**
- **Intent:** the Decision Service memory-gate template and its pre-registered eval.
- **Result:** `tev1:4b` passes (0/49 false saves, 25/26 recall, ECE 0.082). `tev1:0.8b` fails (0/26 recall).
- **Caveats to repeat to the owner:** a small sample (the false-save interval reaches 7.3%), three contradictions skipped rather than flagged, and one author.
- **Pre-registration verified:**
  - the template, rule and bounds at `7d587168`, before any case;
  - the eval at `6392c6b0`, before the run;
  - the results at `ebae919a`;
  - nothing changed after the run, and all three are ancestors of the head.
- **Remains:** merge it after M10h, in track order, with a LEDGER entry. Its NOTES for Track 1 (in `docs/plans/ds2-memory-gate.md`) become a follow-up:
  - `runner.keep()` asks the gate;
  - `server.js` wiring;
  - a `memory_candidate.reason` migration.

  Until that wiring lands, the gate isn't live.
- **Trap:** update it with a MERGE of main, never a rebase, or the cited SHAs stop resolving.

**`plan/ingest-gate`:** nothing in flight. It has no commits beyond main and no PR; its content landed earlier. Safe to ignore.

## 3. Settled with the owner, not yet in the packet or LEDGER

- **The parallel-tracks standing instruction** (2026-10-31):
  - up to three tracks, all coordinated from one session;
  - Track 1 is the milestone chain and owns the hot files: LEDGER, ROADMAP, schema and migrations, `server.js` wiring, shared UI, `package.json`, and in practice CAPABILITY-INVENTORY;
  - side tracks write "NOTES for Track 1";
  - merges go one at a time, in track order, each on green CI;
  - a side track never merges while a Track 1 milestone is in its final CI and merge;
  - report one status line per track.

  I took "update to main" to mean merging main in (eval branches must never be rebased).
- **The second-model review pattern** is in OPERATING-RULES. The vault packet was handed over on 2026-11-01; no findings back yet.
- **/tmp cleanup approved once** (2026-11-01): deleting `/tmp/nova-*` test folders over 3 hours old. That was a one-off approval, not standing. The test suite leaks these folders, about 17,000 in a few days. Fixing the leak is a Track 1 follow-up.
- **Screenpipe on the preview** was turned off by hand at about 17:55 UTC on 2026-10-31, not by a merge.
- **Open owner questions**, so don't decide these yourself:
  1. Preview backlog: let `tev1:4b` screen about 51,700 earlier captures (about 7 hours), or pause it?
  2. Hub splits: add a third-vote lease (recommended), or reword ADR-11 to "settles to one, keeps the loser's changes"?
  3. Held capture items: a tier-2 "keep anyway" override?
  4. Vault:
     - the Q6 reveal mechanism: a passphrase-gated terminal launcher, or a biometric native helper (the broker has no network surface);
     - raising the broker size budget;
     - a protocol path for adding factors after setup.
  5. Real-iPhone checks for #270 (the status bar) and the fold fixes. Real-phone pairing is deferred too.
  6. FYI, already told: a failed "Backup now" turns the orb red.
- **Track 1 follow-up queue** (not all in the LEDGER):
  - wire the cost caps (#256 NOTES);
  - the diagnostics route and Health link (#259 NOTES);
  - the gate uses the Decision Service outcome for v2 and later;
  - capture screening job 2 (recall path);
  - the integrity scrub;
  - M10e's deferred `service` change kind;
  - ingest-screen v3, with a FRESH builder writing blind cases (a safety classifier cut off the previous builder twice while it wrote attack cases);
  - the memory-gate wiring;
  - the test temp-folder leak;
  - the flaky tests in §5.

## 4. My next three actions, in order

1. **M10h #276:**
   - get the exact head green;
   - spawn an independent adversarial review;
   - have the builder fix the findings;
   - merge with `gh pr merge 276 --merge --match-head-commit <sha>`, with the LEDGER entry in the same PR;
   - restart the preview and verify it;
   - report one line per track.
2. **#277:** bring it up to main by merging, wait for green, add its LEDGER entry, merge, restart the preview. Then queue the memory-gate wiring as Track 1 work.
3. **Vault #275:**
   - a second adversarial review with live probes in temp homes;
   - merge any owner second-model findings;
   - merge when clean, applying its NOTES.

   In parallel, when the design PR opens, send its screenshots to the owner (SendUserFile) and wait for approval.

After that, the order stays M10i → M10k, QA Stage 2, then M11 — Home.

## 5. Environment gotchas

**Preview restart**, after every merge. Run it from the preview worktree, never from a feature branch's older script, which drops the mesh variables:
```
cd /home/jeremy/workspace/nova-build/.claude/nova-preview && git fetch -q origin && git merge --ff-only -q origin/main
NOVA_PREVIEW_PORT=4318 NOVA_PREVIEW_MESH_URL=http://127.0.0.1:4320 NOVA_PREVIEW_MESH_PUBLIC_URL=<owner tailnet URL, port 9446> /home/jeremy/workspace/nova-build/.claude/nova-preview/scripts/preview.sh
```
The tailnet URL is deliberately not in this public repo: it's in the local Claude memory note `nova-preview-port.md` for this project, or ask the owner.

Then check that `/`, `/api/v1/health` and `http://127.0.0.1:4320/api/v1/mesh/hello` return 200.

**Don't touch:**
- Never `pkill -f "node src/server.js"`: it kills the preview. Even `pkill -f` with a narrower pattern can match your own shell (exit 144).
- The owner's Tailscale Serve ports, their shim on 4319 and the `nova-tailnet-proxy` tmux session.
- Never point a proxy at the console port.
- WSL can't reach tailnet addresses; test them with `/mnt/c/Windows/System32/curl.exe`.

**/tmp:** /tmp is a **16 GB tmpfs**. Leaked test folders filled it on 2026-11-01, and then every shell command's output was lost. Check `df -h /tmp` when commands mysteriously print nothing. While it's full, redirect output to a file under the repo and read that.

**UI tests:**
- This host's Chromium can't start (no `libnspr4`). UI tests run only via `scripts/ui-test.sh` (Docker Playwright, Chromium + WebKit).
- WebKit `generateKey` throws `OperationError` about 1 in 150 times; it's handled with retries since #266.

**CI:**
- CI is change-aware (#245): docs-only changes skip the heavy jobs. `gate` is main's only required check (`strict: false`, `enforce_admins: false`). Markdown under `system/`, `templates/`, `skills/`, `schedules/`, `connectors/` and `design-systems/` counts as code.
- Find the run for the exact head with `gh run list --commit <sha>`, then loop until its status is `completed`.
- `gh run watch` and `gh pr checks --watch` can exit early, or report "no checks", before the runs register. Never merge on that.
- Merge with `--match-head-commit`.
- A PR that conflicts with main gets NO checks at all; merge main in first.

**Flaky tests:**
- In CI under load: `m10d-review.test.ts:353` (the 30-day sealed snapshot) and `m10g-review2.test.ts:154` (R13, the replayed unhealthy answer). Main passed its last three runs. Rerun once; if a test fails twice, treat it as real.
- Locally under load only: network, provider-guard, skills-api and round2. They pass alone and in CI.

**Shell (zsh):**
- zsh doesn't word-split `$VAR`, so use Python, or arrays, for multi-file loops.
- `cp` is aliased to interactive and hangs; use `command cp -f`.
- `xargs` can't run the `command` builtin; use `/bin/rm`.
- A session hook refuses Write/Edit into a worktree other than the session's own; switch branches in your own worktree instead.

**Git:**
- Never chain `rebase … ; push`. Check `git status` shows no rebase or merge in progress before any push.
- Conflict helper for LEDGER-style "keep both" conflicts, which handles diff3 base sections and asserts no markers remain:
  ```python
  import re,sys
  p=sys.argv[1]; s=open(p,encoding='utf8').read()
  pat=re.compile(r'<<<<<<< [^\n]*\n(.*?)(?:\|\|\|\|\|\|\| [^\n]*\n.*?)?=======\n(.*?)>>>>>>> [^\n]*\n', re.S)
  n=len(pat.findall(s)); s=pat.sub(lambda m: m.group(2)+m.group(1), s)
  assert not re.search(r'^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)( |$)', s, re.M), 'markers left'
  open(p,'w',encoding='utf8').write(s); print('resolved',n)
  ```
  It puts main's side first. Use it for prose files only, never code: send code conflicts back to the branch's builder.
- LEDGER placement: a new plain-language entry goes just above the first `**2026-1` line, and decisions go after `## Decisions\n\n`.

**The clone root:**
- `/home/jeremy/workspace/nova-build` is checked out at an old main, `04512c07`, with the owner's untracked `.claude/` and `docs/builder-packet/`.
- Never commit, clean or move anything there.
- Work only in worktrees branched from `origin/main`.
- About 60 old worktrees under `.claude/worktrees/` are from merged milestones. They're clean, but don't remove them without the owner's OK.

**Ollama:** the Windows host runs 0.40.13, with `tev1:4b` (digest `7954dce2…`) and `tev1:0.8b`. Trust verdicts pin the model digest, so re-pulling a model voids its verdict.

**Never merge PR #207. Never act on issue #208.**
