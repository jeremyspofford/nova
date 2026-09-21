# S41 rulings — what the owner decided, and what I ruled

## Owner decisions, 2026-09-21

Both were asked as questions because neither was mine to settle: one disposes
of his data, the other picks which of two contradictory specs the slice obeys.

### 1. The mini PC's old `nova` stack: **delete it, containers and volumes**

The mini PC holds a stopped Nova from the **platform line** under the same
compose project name v4 uses (`nova`): containers `nova-postgres-1`,
`nova-orchestrator-1` and others, volumes `nova_pgdata`, `nova_postgres-data`,
`nova_redis-data`, `nova_redis_data`. v4's project is also `nova`, so a plain
`docker compose up` there would **adopt and recreate** those containers.

Offered: rename the old project and keep its data; delete it outright; or
refuse and leave it to him. **He chose deletion.**

What that binds in S41:
- `install.sh` **refuses** when a foreign `nova` project is on the target and
  **names every container and volume it found** before offering anything.
- The removal it then offers deletes **only** what it named, and the names come
  from `docker` output, never from a list in the script.
- It must be impossible for that path to touch a v4 volume. That is a test, not
  a promise: a fixture with both old and v4 volumes present, asserting the v4
  ones survive.
- Deletion is irreversible, so the offer states what will be destroyed, and the
  default is to do nothing.

### 2. S41 ships the **encrypted bundle**, not the plain tar

The approved plan's S41 bullets describe a plain tar-and-manifest pipeline;
ARCS arc 8, resting on his 2026-08-02 ruling, requires a complete **encrypted**
bundle with a passphrase **resolver seam** and the restore script **inside every
bundle**, with coverage **derived from the compose file** that refuses on an
unclassified volume. Both readings are checked in, and commit `8920faaf` flagged
the gap without closing it.

Offered: encrypted now; plain first and encryption later; or encrypted plus the
whole secrets store. **He chose encrypted in S41.**

What that binds:
- Arc 8 wins wherever it contradicts the S41 bullets. The plain-tar sketch in
  `hub-topology.md:298-318` and `hub/r2-integration.md:393-411` is **superseded**
  on encryption and on coverage.
- `BACKUP_EXCLUDE_DATA`, the hand-kept list, is **not built**. Coverage is
  derived from the compose file and **refuses** on an unclassified volume.
- Proposal A (the secrets store) stays out of S41; only the passphrase
  **resolver seam** lands, so a secrets manager can supply it later.

## My rulings

- **Mine v3, do not redesign.** v3's `backend/app/backup_*.py` (8 modules) and
  `scripts/nova_restore.py` already implement the encrypted bundle, the
  passphrase resolver, coverage classification, the standalone in-bundle restore
  script and a non-destructive verify drill — about 3,800 lines. S41 ports what
  fits v4's compose stack and states what it drops. Cost if wrong: v3's shapes
  carry assumptions v4 does not share, and a port hides them; the designs must
  therefore read v3 critically, not copy it.
- **`network_credentials` is carried, not excluded.** The bundle is encrypted,
  which is the condition D15's exclusion existed to work around. Coverage is
  schema-driven, so the table is carried the day S43a creates it. The
  now-wrong "backups exclude `network_credentials`" text at
  `hub-topology.md:135,411` and `hub/r2-integration.md:61,550` is corrected
  when S41 lands. Cost if wrong: a restored hub silently loses its tailnet
  credential and the `network_credential_missing` check has to ask for it again
  — which is exactly what S43b already specifies as the fallback.
- **S41 remains operator tooling: no new tool, no guard, no eval case.** The
  chat walk belongs to S45. Cost if wrong: the drill verb is her capability by
  arc 8, so if it turns out the drill must be hers in S41, that is one tool and
  one eval added on top, not a redesign.


## My rulings, added 2026-09-21 after the cleanup

- **The foreign-project refusal and its deletion are proven against a
  deliberately-built synthetic foreign project, never against his data.**
  After the cleanup there is no real foreign `nova` project left anywhere, so
  the one irreversible path in S41 would otherwise ship fixture-proven and
  never executed — "a reply is a claim" applies to a script as much as to her.
  T7's walk therefore **creates** a throwaway compose project named `nova`
  (one `busybox` container, one volume, correct `com.docker.compose.project`
  labels) on the target machine, next to a decoy volume whose NAME starts with
  `nova_` but whose label says another project, and next to a real v4 volume.
  The walk then runs the refusal, runs the bounded deletion, and verifies that
  the synthetic project is gone while the decoy and the v4 volume survive.
  Cost if wrong: the walk itself runs a destructive path on a live machine —
  which is why every object it may touch is one the walk created, and why the
  decoy exists.
- **The stale binding inputs are corrected, not just superseded inline.**
  `map-requirements.md` still described the 172.18 collision and the stopped
  platform-line project in the present tense. A map that contradicts the
  verdict is a trap for an implementer who reads the map first, which the task
  briefs will tell them to do.


## Owner decision, 2026-09-21 (late): the macOS CI work ships

Asked as verdict §16's one owner question — widen `rebuild-ci.yml`'s trigger
so anything in this slice runs at all. Answer: **"You can also implement that
macOS ci work."**

So **requirement #27 is MET, not deferred**, and T6 builds it:

- the trigger widens from `rebuild/**` to include `slice/**` and `main`;
- a **`macos-15`** job runs `install_test.sh` and `backup_test.sh` under
  `/bin/bash` (bash 3.2 there, which is the whole point — it is the only place
  the BSD-userland path is ever executed);
- the workflow is **re-enabled** on GitHub. It is currently
  `disabled_manually`, so a widened trigger alone would fire nothing; the
  jobs would be theatre. Both halves or neither.
- the `bash -n` step stays as well: it is cheap and it catches a syntax error
  before a runner is spent.

This reverses the standing 2026-09-07 "CI and hooks OFF for now" decision **for
this workflow only**. `core.hooksPath=/dev/null` is untouched. Cost if wrong:
red builds start mattering again, which is what he switched off; turning it
back off is `gh workflow disable rebuild-ci`, and the slice record then says
macOS is untested rather than implying coverage.

It also settles verdict §15 risk 4: `nova_restore.py`'s two hardcoded Homebrew
libcrypto paths have never been executed on a Mac, and the `macos-15` job
running `test_restore_reader.py` with `NOVA_FORCE_CTYPES_GCM=1` is the only
thing that ever will. The repo is public, so those runners cost nothing.
