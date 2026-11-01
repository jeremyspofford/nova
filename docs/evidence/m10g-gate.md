# M10g gate evidence: hub promotion, planned and emergency, and the promotion drill

The ADR is `docs/plans/M10-orchestration.md` (Point 10, the M10g row of Order, the tiers table) with the
owner's Decisions 2 and 5 (`docs/builder-packet/INPUT-2026-10-31-ORCHESTRATION-DECISIONS.md`); the
plan is `docs/plans/M10g.md`. Everything here ran on 2026-10-31/11-01 (UTC) on this machine (WSL2,
Node 26.3.1), in temp folders made with `mkdtemp(os.tmpdir())`, on 127.0.0.1 only. No real device,
DNS name, tailnet, router or Tailscale setting was touched; the stable mesh name was a loopback
forwarder the drill controls (`scripts/stand-ins/stable-name.js`). The no-Kubernetes tripwire was
armed for every run and never fired.

The branch is `m10g/hub-promotion`, from main at `4685053d` (M10f merged). **No migration**: nothing
new is replicated (the promotion's shared record is its ledger tasks; each node's own progress is
`mesh/promotion.json`, which stays on its node), so `ADDED_COLUMNS` is unchanged.

## Suite

- `npm run check` at `8a2f24c3` (tokens, themes, typecheck, then `npm test` under the tripwire): **1456 tests: 1441 pass, 2 fail, 13 skipped**. The two are `tests/core/provider-guard.test.ts` › “a coding agent that changes more than Nova takes…” (the stand-in agent ended without a result) and `tests/skills-api.test.js` › “the email summary…” (timed out): the two load-sensitive Era 2/provider tests M10f’s evidence names too. Run alone right after, both files pass (17 of 17). Neither touches M10g’s code.
- After main was merged in at `250fa3aa` (#270, the iOS status bar; the only conflict was the LEDGER's
  Decisions, both entries kept): `npm run check`: **1460 tests: 1443 pass, 4 fail, 13 skipped**: the
  same two, plus `tests/ingest/round2.test.js` N1b ×2 (timed out), named as load-sensitive in M10f's
  evidence too. The three files alone: 31 of 31 pass. The drill, the promotion tests, the fresh-user
  test and the regression evals passed in that run.
- The first full run, before the roll-back asked the failing hub to stand down, failed the drill with two nodes taking a change in the same tick (see Guards); that is fixed and the drill passed in every run since.
- `scripts/ui-test.sh`: **108 tests: 108 pass** (Chromium and WebKit, in the Playwright image), `tests/ui/m10g-promotion.test.ts` among them. Its screenshots are in `docs/screenshots/m10g/`; the other evidence screenshots the run rewrote were put back as they were.
- **After the adversarial review**, at `a4c6f718` (main merged in at `bd3a1b45`: #273, the claim
  graduation; conflicts only in the LEDGER's Decisions and the claim backlog, both sides kept):
  `npm run check`: **1476 tests: 1459 pass, 4 fail, 13 skipped**. The four: `tests/ingest/round2.test.js`
  N1b ×2 and `tests/skills-api.test.js` "the email summary…" (timed out, as above), and
  `tests/core/design-api.test.ts` "the mode is set through the profile route…", which hung until its
  process was ended (another builder's suite on this machine hung on the same file at the same time).
  Alone, all three files pass (round2 14 of 14, design-api 9 of 9, skills-api with provider-guard 31 of
  31 earlier). Every M10g test passed in that run: the drill, `tests/acceptance/m10g-review.test.ts`
  (11 of 11), `tests/core/mesh-promotion.test.ts`, the fresh-user test (first win 4141 ms) and the
  regression evals (29 of 29; the negative control failed every task, as it must).
- `scripts/ui-test.sh` after the review: **111 tests: 111 pass** (Chromium and WebKit; main brought three more), `tests/ui/m10g-promotion.test.ts` among them, now with `NOVA_DRILL=1` for its short window.
- **After the second adversarial review** (main unchanged since `77c404ac`): `npm run check`: **1497
  tests: 1482 pass, 2 fail, 13 skipped**. The two are `tests/core/provider-guard.test.ts` "a coding
  agent that changes more than Nova takes…" and `tests/skills-api.test.js` "the email summary…", the
  load-sensitive pair named above; the two files alone: 17 of 17 pass. Every M10g test passed in that
  run: the drill (with case 11), `m10g-review.test.ts` (11 of 11), `m10g-review2.test.ts` (7 of 7), the
  device-agent safe-mode test, the promotion core tests, the fresh-user test (first win 10646 ms) and
  the regression evals.
- `scripts/ui-test.sh` after the second review: **112 tests: 112 pass** (Chromium and WebKit), `tests/ui/m10g-promotion.test.ts` among them; its screenshots in `docs/screenshots/m10g/` re-taken, the others put back.
- CI is the record: see the PR.


## Reused, and new

| Need | Reused | New |
|---|---|---|
| Who is hub | `MeshRole` (`promote`, `demote`, `fence`, the roster signed by its own key), `ledger.recover()` | `promote({ planned })` keeps the old hub as the standby; `follow()` makes a hub (or one that stepped down) a live copy of another; `hold()`/`held()` |
| Devices following | `trust.ts` (`checkProof`, `acceptRoster`), `boot.ts findHub` | `rosterKeys` with candidates; `bundleKeys`; `candidates()` with candidates' addresses |
| Copying | `Replica`, `role.json`, `SyncLog` (`lag`, `ack`, `fresh`, the log keeping the hub's seq) | a follower's cursor at the hand-over's last sequence |
| Drain | `ledger.halt()`, `uncancellable` (M10c), `stopHub()` | `ledger.drain()`, `ledger.resume()` |
| Writes held | the replica gate in `core.gate` | the hold, with the mesh's own calls passing |
| Backups | `backup.ts`, `drill.ts` (`drill()`), `backup_run`, `backup_drill` | backup freshness as a pre-check; the drill run on the backup before a cold promotion; `sealed` exported |
| Cold restore | `checkpoints.ts` staging and swap (`stageCopy`, `writeStaged`, `finishStaged`), `restore.ts carryOver`, `Restarter` | `stageCold`, `restartStaged`, the `cold` marker and `applyCold` |
| Records | `ledger.create`, `parent_id`, `verifier.registerConfirmation`, M4's `mesh` worker | worker `mesh-promotion`, confirmation system `nova-promotion` |
| Sheets | the approval sheet and Settings › Devices rows | `promotionSheet`, `coldPromotionSheet`, "Promote to hub", the promotion row |
| Proof | M4c's two processes (`m4c-support.ts`), `Joiner`, the real boot agent | the drill, the stable-name stand-in, the tap (`mesh/tap.ts`) |

## Gate items

### 1. Planned promotion, end to end, every step ledgered

- **The pre-checks refuse, for each reason, in words.** `tests/core/mesh-promotion.test.ts`:
  - "pre-checks: each reason refuses…" (pure): no such device, revoked, the hub itself, a phone, a
    computer that is no hub candidate, a candidate that isn't the standby ("Make it the standby
    first"), unreachable, not following this hub at its epoch, stepped down, too little disk (less
    than 3× the home), disk unknown, too little memory (under 2 GB), another release, another schema,
    no backup, a backup older than 24 h, a backup whose drill hasn't passed; and a good candidate
    passing all seven checks.
  - "pre-checks through the hub…" (two cores over HTTP): a phone, a computer with no candidacy, a
    candidate that isn't the standby, no fresh backup, then the candidate reporting 1 KB of disk and
    1 GB of memory (`disk`, `memory`), and a candidate on release 0.2.0 (`version`). The route without
    `confirm` is 400 (tier 3, every time); with it and a failing check, 409 with the reason, a failed
    "Promotion pre-checks" ledger task, and the hub unchanged.
  - The drill, case 1: the real phone, the real computer, and the standby with no backup refused.
- **Catch-up, drain, hold, transfer, demotion, verification.** "a planned promotion end to end…"
  (two cores) and the drill's case 2 (two processes): the chain on the new hub is six ledger tasks,
  all done and each checked by Nova (`nova-promotion` confirmations; the transfer is M4's own task
  under the chain): "Promotion pre-checks for “…”", "Copied to the candidate", "Running work finished
  or handed over", "Hub handed over to this node", "“…” is the standby now", "Checks of this node as
  the hub". A change made while the hub handed over was refused with "Nova is handing the hub over…"
  (409); the old hub then refuses changes as a standby and copies the new hub (a memory written on
  the new hub arrives on the old one); the stable name points at the new hub; the window passes and
  the new hub records it with the probe runs.
- **The drain** (`ledger.drain`): "the drain: nothing new starts but what is kept; running work gets
  the bound, then is handed over; work past its commit point is never cut": a running task is left
  active for the next hub's recovery, a task queued during the drain doesn't start until `resume()`,
  and a task past its commit point (`uncancellable`) is reported `stuck`, so the hand-over stops.
- **The automatic roll-back at epoch + 2, on positive evidence only** (after the review). "the new
  hub fails its checks (the stable name didn't move)…" (two cores: epoch 1 → 2 → 3) and the drill's
  case 3 (epoch 2 → 3 → 4): the new hub, asked over a signed request, answers three times running with
  a health report signed by its own key saying the stable name doesn't lead to it; the old hub asks it
  to stand down, it acknowledges, signed, and holds writes; the old hub copies what it took, takes the
  role back at epoch + 2 by itself (tier 1: a problem says so) and points the name back; the new hub
  steps down and copies it afresh as its standby. Ledger: "Promotion rolled back: this node is the hub
  again" done; "Checks of “…” as the hub" failed, with the failing check and "stopped taking changes
  first". A link that doesn't answer is never enough (R1, R2 and the drill's case 2, below).

### 2. Emergency promotion from the latest backup

The drill's case 6, on N2 (a hub candidate that had stepped down: not the standby, no live copy),
with N1 killed: the sheet (`GET /mesh/promotion/cold`) states the backup's number and time, "What is
lost: Everything written after <that time>…", "What may come back…" (revocations and forgets after
this node's own copy), "Connectors need signing in again. Backups never hold the key to your saved
secrets… The key stays only where it already was…", the devices, the epoch (6: above its own record,
the backup's and the computer's roster, which the computer showed it while looking for the hub), the
stable name and tier 3. `confirm` is required (400 without it), and the backup the sheet showed (409
for another).
The backup's restore drill runs first, the backup is staged, Nova restarts in place, and N2 is the hub
at epoch 6 with its own keys. A memory written on N1 after the backup is absent on N2; the connector
secret saved on N1 isn't in N2's vault; the ledger has "Emergency promotion from the backup of …" and
"Promoted from a backup: this node is the hub", both done; the computer and the phone, paired before
the backup, follow without pairing again. **Nothing escrowed:** case 9 scans every backup for the
vault's key in four encodings and finds none. The sheet's words are unit-tested in "the emergency
sheet says the backup's time, what was lost and that connectors sign in again…", which also shows a
hub and a live standby sent elsewhere.

### 3. The promotion drill, with two test devices

`node scripts/promotion-drill.ts --record <file>` and `tests/acceptance/m10g-drill.test.ts` run the
same code (`tests/acceptance/m10g-drill.ts`): two Nova homes in temp folders (N1, N2), real server
processes on loopback, a computer joined with the real `boot.ts join` and followed with the real
`findHub`, a phone (`Joiner`), the stable name as a loopback forwarder with a control port Nova's
driver uses (`NOVA_MESH_NAME_CONTROL`), and a backup folder. Its recorded run is in "The drill's
recorded run" below.

### 4. No private key leaves its device

The drill's case 9: N1's and N2's `mesh/identity.json` and the computer's `boot/keys.json` are
byte-identical (SHA-256) before and after. Every file under both homes, the computer's home, the
backup folder and the tap (`NOVA_DRILL_TAP`: every decrypted sync batch, the handover, every ready,
transfer, health and stand-down answer and hello, as the receiving node read them), every row of every
database read one by one, and everything the processes printed, is scanned for each of the six
private keys (Ed25519 and X25519 of three devices) as JWK `d`, hex in both cases, base64, a JSON byte
list, PKCS8 DER (bytes, hex, base64) and PEM, and as raw bytes; none is found outside its own key file
(and its own node's checkpoints, which never leave it). `tests/core/mesh-promotion.test.ts`
"the hub's calls to the candidate and the handover are signed, fresh, used once, and carry no key"
checks a signed call and a handover the same way. **Said plainly:** the vault's key is not a device
key; it still reaches a live standby sealed to that standby's key, as since M5b (that is how a
planned promotion keeps connectors working). The tap now writes it as its digest (review, minor), so
case 9 checks it too: it is only in the vault key files (N1's own, N2's as a standby) and those nodes'
own checkpoints; no backup, tapped message, database row or output holds it.

### 5. Fencing and split-brain

- "fencing covers every pinned hub candidate…": a computer made a hub candidate, proving its own key
  at a higher epoch, makes the hub step down (it then refuses changes); the same computer before its
  candidacy doesn't. `tests/core/mesh-sync.test.ts` "only the standby or a pinned hub candidate can
  make a hub step down…" (changed: see Guards).
- "trust widened to every pinned candidate, and only there…": a computer's agent accepts a
  candidate's roster at a higher epoch (and refused it with the pre-M10g key set), never an unpinned
  key with a valid signature, never a lower epoch; runtime bundles stay hub- and standby-signed.
- The drill: case 4 (N2 back after N1 took over: fenced, refuses changes, and can't be made the hub
  from its stale copy), case 5 (N1 back while N2 is down: the computer refuses its epoch 5 against
  the 6 it holds), case 7 (N1 back with N2 up: it finds N2, a pinned candidate, at epoch 6 and steps
  down before it takes a change), case 10 (a node with a valid signature from an unpinned key at
  epoch 99, behind the stable name: refused).
- **Never two hubs taking writes:** the drill's case 8 asks both nodes to take a change at the same
  moment every 100 ms through every case (a request the write gate decides and the handler then
  refuses, so nothing changes: 409 refused, 400 taken); the core roll-back test and R1, R2 do the
  same every few milliseconds. None saw both take one. This is sampling, not a proof.
- **Ties settle:** R3 makes two hubs at the same epoch (the reviewer's p3); fencing from either side
  leaves exactly one, the smaller device id. Devices never follow another hub at an equal epoch (R6).
- **A rolled-back promotion leaves one hub:** the core roll-back test and the drill's case 3 end with
  exactly one hub, the other its standby, copying it.

### 6. Tier 3, every time, and the closing rule

Both promotions refuse without `confirm: true` (core tests and the drill); the browser test
(`tests/ui/m10g-promotion.test.ts`) shows the sheet's button disabled until the box is ticked, a
refused pre-check offering no button, then the hub handing over and its own screen saying it is the
standby, and the Devices page saying the promotion is verified (screenshots in
`docs/screenshots/m10g/`). The automatic roll-back is tier 1 (Nova acts, then a problem and the ledger
say so). The sheets' words are built in `src/core/mesh/handover.ts`; eight of its claims are in the
register (`tests/evals/claims.ts`, "hub promotion (M10g)"), each worded to what the person will see
happen, with its stronger words held back for a named eval (`claim.promotion-*`,
`claim.cold-promotion-restores-backup`, `claim.no-vault-key-escrow`, `claim.never-two-hubs`), since no
golden task promotes a hub. The claims test and the closing rule pass (`tests/core/evals.test.ts`).

### 7. The fresh-user test and the regression evals

- **The fresh-user test** (`tests/acceptance/fresh-user.test.ts`, in `npm test`): passed, “fresh user: blank profile → conversational setup → a delegated task verified with evidence, local-only, durable across a restart”, with M10f’s timed first win (3095 ms measured; the human path estimated at 361 s).
- **The regression eval suite** (`tests/acceptance/evals-regression.test.ts`): 25 of 25 regression tasks passed (100%) before the review, 29 of 29 after main brought #273's four graduated cases, and the negative control failed every task, as it must. Nothing M10g changed is an agent outcome, so no task was added; the promotion claims are softened to what the tests show (item 6).


## The review of #272

The adversarial review at `761fa24b` found two blocking findings and seven should-fix, with probes in
the reviewer's scratch folder (`pN-*.ts`, each with its output). Each became a test built on its probe
(`tests/acceptance/m10g-review.test.ts`, two cores over HTTP with cuttable loopback links), or a drill
case; each fix was then undone on its own and its test run against it (`revert` below: what the test
said with the fix undone).

| # | Reproduced (the probe's output) | The fix | The test | With the fix undone |
|---|---|---|---|---|
| 1 | p1: the A → B link cut alone; A took the hub back at 2.6 s while B stayed hub; both took writes in 494 of 503 ticks; B's write was on neither node at the end. p2: the old hub cut off took the role and B's 5 changes were lost silently | Roll-back by itself only after three authenticated `unhealthy` reports and a signed stand-down; `unknown` (no answer, clock off) moves nothing, says so once, offers tier-3 "take the hub back"; a node stepping down puts what the other never copied into a named checkpoint and lists it; at restart a stale `promotion.json` is checked against the node's mesh state before any probe | R1, R2, "a clock off by two minutes…", the drill's case 2 (link cut inside the window) | R1 and R2 fail ("no roll-back on a broken link"); with the checkpoint step undone R1 fails ("the problem names what wasn't carried over"); with the facts check undone the stale-record test fails |
| 2 | p3: two hubs at epoch 2, three fencing rounds settled nothing, both took writes, a computer accepted the second | The emergency epoch is max + 1 over its own, the backup's and every roster a device showed it (`POST /mesh/seen`, kept only if signed by a key it trusts to be hub), and the sheet says when none did; fencing breaks equal epochs to the smaller id; devices refuse an equal-epoch roster from another signer | R3, R3b, R6, the drill's case 6 (the computer's roster raises the epoch) | R3 fails ("one hub: hub,hub"); R3b fails ("max + 1 over what the devices showed") |
| 3 | p9: B committed and then answered 409; A resumed as hub; both took writes in 284 of 285 ticks; A's write never reached B | Any answer but B's signed roster goes to settling: B's signed `transfer-status` says taken (A follows), declined (A carries on; B never takes it) or nothing (A keeps holding) | R9 | R9 fails ("no resume without the candidate's word") |
| 4 | p5: A restarted during the transfer and ran the handed-over task again while B ran it too | `restoreHold()` before `startHub()` (no `ledger.resume()` or `recover()` while held); Era 2 runs no work while a hold is pending | R5 | R5 fails ("it starts holding") |
| 5 | p4: a write landing during the hold stayed on A only, unreported | The gate holds first; requests past it finish; the log keeps recording (device sessions don't write last-seen while held); the last sequence moves up to what lands; Era 2's running work stops on `draining`; anything after the hand-over point is kept and said | R4 | R4 fails ("carried to the new hub, or kept and named") |
| 6 | p7: B died at the transfer; A held writes forever; promote, cold and a new promotion all refused | Released as soon as B says, signed, it didn't take it; tier-3 `POST /mesh/promotion/cancel`, which asks once more and otherwise carries on two epochs higher, saying what Nova can't know; a button for it in Settings › Devices | R7 (both halves) | R7 fails ("released: the candidate said, signed, it didn't take it") |
| 7 | p6: a computer accepted a candidate at its own epoch, then a bundle that candidate signed, and a roster at 2^53 | Another hub only at a strictly higher epoch, at most +3 unless the current hub signed it, never past 2^31 − 1; heartbeat answers carry the roster's digest and agents take a changed roster at once (a revoked candidate unpinned within a heartbeat), chosen over raising the epoch at each revocation, which would make a live standby copy afresh | R6, the device-agent and boot tests | R6 fails ("equal epoch, another signer: refused") |
| 8 | restore.ts keeps revocations and forgets from the backup and this node only | Unchanged merge (both sources); the sheet's "What may come back" says what can't be known, with this node's copy time, and so does the problem after | "the emergency sheet…" | it fails ("What may come back…") |
| 9 | p8: the vault key in the tap and in a checkpoint; the sheet said "Nova keeps no copy" | The sentence says where the key is; register entry and backlog (`claim.no-vault-key-escrow` blocked: false by design as first written) | "the emergency sheet…", `tests/core/evals.test.ts` | both fail (the sentence; "the claims register…") |
| 10 | the window and probe pace could be set to seconds in production | Shorter only with `NODE_TEST_CONTEXT` or `NOVA_DRILL=1` on a temp home; else ≥ 30 min and ≥ 5 s, with a warning | "outside a test or the drill…" | it fails (1800 expected) |
| minor | the name control took an unauthenticated POST; the tap wrote the vault key in clear; the emergency sheet wasn't bound to its backup; a problem could be logged to a closed database; M4 moved the name with no window; the key scan missed encodings | Token plus https or loopback; tap only in tests and the drill, vault key as digest; `backup` id required; `#problem()` guards closing; an automatic failover doesn't move the name (an M4 promotion by the person does, under its tier 3, with no window: stated below); the scan widened (item 4 above) | "outside a test or the drill…", the drill (case 6's 409, case 9) | the token and tap checks fail; the drill fails ("only the backup the sheet showed": 202) |

## The second review of #272

The second adversarial review at `53058d93` found five more (N1–N5) and four minor, with probes
p10–p15. The same method: each became a test built on its probe (`tests/acceptance/m10g-review2.test.ts`,
R10–R15, on the helpers now shared in `tests/acceptance/m10g-support.ts`, plus one device-agent test
and the drill's case 11), and each fix was undone on its own and its test run against it
(`revert2.py`, below: what the test said with the fix undone; every one failed).

**What M10g guarantees during a split, exactly:** during a split, two hubs can briefly accept writes;
when contact returns, it settles to one, and the loser's changes are kept and named, never merged
automatically. Whether ADR-11 is reworded or a lease or third vote is added is the owner's decision;
none is built (see Limits).

| # | Reproduced (the probe's output) | The fix | The test | With the fix undone |
|---|---|---|---|---|
| N1 | p13: a forwarder kept one honest signed "unhealthy" and replayed it three times: A asked B to stand down; later, with replayed answers, A took the role at epoch 3 while B held | Every signed answer (health, stand-down ack, `transfer-status`) carries its request's nonce and time; `answers()` takes it only for that request. Nonces taken are kept in `mesh/promotion-nonces.json` for the freshness window, so a used call is refused after a restart. The comment now says a forwarder can drop or delay answers, not forge or replay one | R13 (a proxy that captures and replays; a signed `ready` call re-sent after B restarts) | binding undone: R13 fails ("a replayed answer counted: unhealthy,unhealthy,unhealthy"); persistence undone: R13 fails (the re-sent call: 200, not 403) |
| N2 | p10: the old public roster replayed 54 times evicted the real one (max 4 → 1, the emergency epoch 2 under a live hub at 4); junk every 100 ms let a real device through 1 of 10 times; "from 2 devices" after three reports | `/mesh/seen` takes only a report signed by a paired device's own key (id, fresh time, the roster's digest), with the roster signed by a key this node trusts to be hub; `max` only rises; each device's id is kept; once a second per device, after the checks; the count is distinct devices. The boot agent signs its report | R10; the drill's case 6 (the computer's signed report counted once; an unsigned one refused, the max unchanged) | signature undone: R10 fails ("unsigned: refused"); monotonic max undone: fails ("a lower report never lowers it"); one limit for everyone, before the checks: fails; counting reports: fails (count ≠ 1) |
| N3 | p11: after a tie, A hub at 2, B standby; a computer holding B's roster at 2 refused A ("the same as the hub this device follows") and B (standby): no hub; B's 3 changes in no checkpoint | The winner of a tie raises its epoch by 1 at once, with a problem; every step-down (not only M10g's) keeps what it took that the winner never copied in a named checkpoint, said; the kept list starts where this node last became hub (`mesh/hub-since.json`), so seed rows aren't listed | R11 (either node may win: whichever loses is checked), R12 | raise undone: R11 fails ("the winner went one higher"); keep undone: R11 fails (its changes not named); the hub-since baseline undone: R11 and R12 fail ("no seed rows in the list") |
| N4 | p12: after a cancel and the heal, the name still led to B, now a standby (a phone's write: 409); p14: a take-back with the name stuck: once settled, the name led to the standby | Every step-down points the name at the winner; the hub checks every few probes' time that the name leads to it (or to a node that outranks it) and points it back; a cancel does so at once. A move to this node is read back through the name; one that didn't take is a problem said plainly | R12 (cancel), R14 (take-back with the name stuck) | settling undone: R12 and R14 fail ("the name leads to the hub once it settles"); read-back undone: R14 fails ("a name that can't be moved is a problem, said plainly") |
| N5 | p15: after five planned promotions a laptop holding epoch 1 refused the hub at 6 ("more than 3 past the 1 this device knows") | Each planned hand-over and each roll-back's stand-down adds a link signed by the hub handing over; each hub serves the chain (`GET /mesh/roster/chain`); a device follows a jump of any size if every link verifies back to the hub it knows; the 2^31 − 1 ceiling holds | R15 (five promotions; a forged first link refused); the drill's case 11 (the real boot agent, asleep since epoch 1, follows N2 at 6) | `chained` ignored: R15 fails; the chain not served: R15 fails ("the chain: 0 links") |
| found by case 11 | With case 11 added, the drill's case 4 failed: N2, whose last promotion record (verified, from N1) was over, met N1 as hub after an M4 promotion, took that for a take-back, wiped its copy to copy N1 afresh, and was refused by N1 ("This device isn't the standby"): an empty standby that said "Hub took the hub back", which it hadn't | Only an open promotion (verifying, transferring, failed) is taken back; a verified one is over, and the node keeps its data, read-only, as for any other step-down (what it took is still kept in a checkpoint) | the drill's case 4 (N2 kept its own copy; asked to promote with it: refused, "no copy of the hub's latest data") | with `verified` back in the list, case 4 fails (the refusal said "hasn't copied the hub's device registry", N2's registry empty) |
| minor | safe mode skipped the roster digest; `NOVA_MESH_NAME_TOKEN` reached the agent and wasn't a diagnostics secret; vault rows named by row; the ceiling enforced only by devices | Safe mode takes a changed roster; the token stripped in `src/agent.js` and added to `knownSecrets`; warnings for a short token and a plain-http control elsewhere; saved secrets named by name; the ceiling at `promote`, `raiseEpoch` and the emergency sheet | "in safe mode too…" (device-agent), "minor: the name token…" (review2) | each undone, its test fails (pinned key kept; token in the env; token not a secret; no exception; promote 200 at 2^31; no sheet reason; the summary) |

## Guards removed in turn

Each change below was undone on its own, and the named test run against it:
- **The stand-down before a roll-back** (the old hub calling an unknown step instead): "the new hub
  fails its checks…" failed in both of two runs: "two hubs took a change at the same moment"
  (`both: 3` of 109 ticks, then `both: 2` of 104). This is how the gap was found: the first full run
  of the suite, before the stand-down existed, failed the drill with `both: 1` of 227 ticks, in the
  roll-back.
- **Candidates as fencing successors** (`...candidates` taken out of `successors`): "fencing covers
  every pinned hub candidate" failed ("a pinned candidate is a possible successor (Decision 2)").
- **The hold in the write gate** (`role.held()` taken out of `core.gate`): "writes held…" and "a
  planned promotion end to end…" failed ("a change was refused while the hub handed over").
- **`replica().demoted` counting a role file that says hub** (back to M4's test): the drill failed at
  case 4: N2, fenced, with a role file left saying hub, was made the hub from its stale copy at epoch
  6. A pre-existing M4 gap, found by this drill.
- **The guard M10g removed on purpose:** a replaced standby proving a higher epoch used to be refused
  ("isn't this hub's standby"); it is a hub candidate, so it is a possible successor now (Decision 2).
  The test was changed to keep the refusal where it still holds: a computer that is no candidate.

## Limits

- **Step 0 isn't automated:** a candidate that isn't the live standby is refused with directions to
  make it the standby first (a pairing on that machine, with new keys in a new home).
- **A computer running only the device agent can't be promoted:** it has a pinned key but no Nova home.
- **No rehearsal from Settings › Devices on scratch copies:** the drill is a script and a test.
- **The window** is 30 minutes; shorter only in a test or the drill on a temp home; there is no
  setting for the person to lengthen it.
- **The stable name** moves only through `NOVA_MESH_NAME_CONTROL`, and only a loopback stand-in was
  ever behind it; there is no DNS or tailnet driver. Without one, the sheet says the person moves it
  and the window doesn't check it. M10d's change chain isn't used for it (see the plan).
- **A split, exactly:** during a split, two hubs can briefly accept writes; when contact returns, it
  settles to one, and the loser's changes are kept and named, never merged automatically. Nova no
  longer moves the role on a broken link, but the person can (take back, cancel), told plainly; then,
  and for an old hub cut off from every peer, two nodes can take writes until they meet. When they
  meet, the lower epoch (at a tie, the larger id, after the smaller goes one epoch higher) steps down
  and keeps what it took in a named checkpoint, said; the stable name is pointed at the one left.
  Devices refuse the lower epoch. Two nodes have no lease and no third vote, so ADR-11's "one active
  hub" holds only while they can reach each other; whether ADR-11 is reworded or a lease or third
  vote is added is the owner's decision, and none is built.
- **The chain of hand-overs** covers planned promotions and roll-backs only; after an emergency or M4
  promotion a device more than 3 epochs behind, not following the new hub's key, still can't follow
  until it is paired again or its hub signs the jump. The chain kept is the last 64 links.
- **The name's read-back** checks only a move to this node, three times over about a second: a real
  DNS driver slower than that would be reported as not taking (none exists in this build).
- **An M4 promotion by the person** moves the stable name under its own tier-3 confirmation, with no
  verification window (it is the emergency path with a live standby); an automatic failover doesn't
  move it.
- **Epoch evidence from devices** comes only from a computer that looks for its hub at this node;
  phones and browsers hold no roster, and the sheet says when no device has shown one.
- **What a restore can't know** (revocations and forgets on the old hub after this node's copy) is
  said, not recovered.
- **A revoked candidate** is unpinned by agents within a heartbeat; an agent offline since keeps the
  old roster until it next reaches its hub.
- **The drain's bound:** work stopped at the bound is left active for the new hub; a worker that
  ignores its stop signal and writes after the hand-over point has its change kept in a checkpoint on
  the old hub and listed, not carried over.
- **The closed-database guard** has no test of its own: the in-process restarts in R5 and R9 run
  through it without an uncaught error.
- **Disk and memory** are as the candidate reports them.
- **The emergency path** takes backup folders only (not the encrypted copy), checks the backup's seal
  only when this node's vault holds the seal's key (the sheet says when it couldn't), and records its
  ledger chain after the restart; a cold attempt refused before staging (its drill failed) is told on
  the sheet but not ledgered (a node that isn't hub runs no ledger).
- **Same-disk copies:** the staged swap (restore.ts, unchanged) carries this node's `mesh/` folder
  into the restored home by copying it on the same disk; the key file is byte-identical and never
  leaves the device.
- **Nothing real:** one machine, loopback, stand-ins. Promoting between the owner's own hub and a real
  computer is the owner's call (the ADR's Hard limits), as real pairing is (LEDGER).

## The drill's recorded run

Recorded after the second review's fixes, with `node scripts/promotion-drill.ts --record <file>` under the no-Kubernetes tripwire (it never fired). Case 11 runs after case 3, so the epochs of cases 4–10 are 2 higher than in the first recorded run.

Run 2026-11-01T06:45:43.660Z on linux (Node 26.3.1), in 33 s. Every case asserts as it runs: this record exists only if each one held.

**Case 0.** Two Nova homes, a standby enrolled with its own command at the stable name, a computer and a phone paired there (1.6 s)
- N1 (hub) http://127.0.0.1:20049, N2 (standby “Spare”) http://127.0.0.1:30555, the stable name http://127.0.0.1:42589 pointing at N1
- the computer a8b512c8-a39c-4017-ac97-66ea280ed697 pinned 2 keys at epoch 1

**Case 1.** The pre-checks refuse an ineligible candidate, for each reason the drill can make (0.2 s)
- the phone: “Pocket phone” is a phone: a screen onto Nova, never a hub.
- the computer: “Desk computer” isn’t a hub candidate. Making it one is its own explicit confirmation, in its roles.
- the standby with no backup: There is no backup. Back up now (Settings › Backups), then try again.

**Case 2.** A planned promotion N1 → N2: every step ledgered, no data lost, devices re-pointed through the stable name, N1 a live standby, the window passed (7.6 s)
- backup 1 of 2026-11-01T06:45:45.554Z, its drill passed; every pre-check passed (role, follows, disk, memory, version, schema, backup)
- ledger: “Promotion pre-checks for “Spare””: done
- ledger: “Copied to the candidate”: done
- ledger: “Running work finished or handed over”: done
- ledger: “Hub handed over to this node”: done
- ledger: ““Hub” is the standby now”: done
- ledger: “Checks of this node as the hub”: done
- content hashes equal on both: {"memory":"a56505614d1f438119790b96539ebfdb0f03b3b25697b66d638796b609087c47","profile":"97f89bbba3ce74df1fbe3b1cdf54bf8ab9d37be595db947a35087f53aa52ae11","messages":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945","plan":"118d4acfd69763e68a2d74a7e4a102a2bfacfc42ab41026b193c53ae2b875965"}
- the computer: epoch 2 at http://127.0.0.1:42589; the phone: session 200 at the stable name
- window: 15 probes over 6 s (3 unknown while the link was cut: no roll-back), the last passed
- while the link was cut, N1 said: Nova can’t reach “Spare”, the hub since the hand-over, to check it (“Spare” doesn’t answer: socket hang up). It stays the hub: a link that doesn’t answer is no proof it failed, and taking the role back by itself could leave two hubs. If “Spare” is gone for good, you can take the hub back here (Settings › Devices, tier 3).

**Case 3.** A planned promotion N2 → N1 whose new hub fails its checks (the stable name didn’t move): N2 hub again by itself at epoch 4 = 2 + 2; N1 stepped down to copy it (3.5 s)
- ledger: “Promotion pre-checks for “Hub””: done
- ledger: “Copied to the candidate”: done
- ledger: “Running work finished or handed over”: done
- ledger: “Hub handed over to this node”: done
- ledger: ““Spare” is the standby now”: done
- ledger: “Promotion rolled back: this node is the hub again”: done
- ledger: “Checks of “Hub” as the hub”: failed
- failing probe: http://127.0.0.1:42589 doesn’t lead to it (it answers as another node).
- the computer follows N2 at epoch 4

**Case 11.** Two more planned promotions (N2 → N1 at 5, N1 → N2 at 6); a computer asleep since epoch 1 follows the jump of 5 by the chain of hand-overs (15.7 s)
- N2 serves 5 hand-over links (epochs 2, 3, 4, 5, 6), each signed by the hub before it
- the computer, with the record it held at epoch 1 (N1 its hub), follows N2 at epoch 6: a jump of 5, past the +3 it takes without a chain

**Case 4.** N2 killed; N1, its live standby, made the hub (M4’s promotion, epoch 7); N2 back and fenced (0.7 s)
- N2 says: This node isn’t the hub any more: “Hub” at http://127.0.0.1:42091 became the hub (epoch 7) while it was away, so this one only reads. “Hub” at http://127.0.0.1:42091 is the hub.
- asked to become the hub with what it had: This node isn’t the hub any more: “Hub” at http://127.0.0.1:42091 became the hub (epoch 7) while it was away, so this one only reads. “Hub” at http://127.0.0.1:42091 is the hub. It has no copy of the hub’s latest data, so it can’t take over. Enroll it again as the standby first.

**Case 6.** An emergency promotion from the latest backup onto N2 (a hub candidate, not the standby), with N1 unreachable (2.2 s)
- sheet: The backup: Backup 5, made 2026-11-01T06:46:12.986Z. Nova checked its seal: Nova made it.
- sheet: What is lost: Everything written after 2026-11-01T06:46:12.986Z: changes, conversations, memories and tasks from then on are not in the backup.
- sheet: What may come back: Devices revoked and memories forgotten stay that way when the backup or this node knew of it (this node’s own copy is from 2026-11-01T06:46:12.314Z). Anything revoked or forgotten on the old hub after that isn’t known here: check Settings › Devices and Memory afterwards.
- sheet: Connectors: Connectors need signing in again. Backups never hold the key to your saved secrets, so they can’t be opened from this backup. The key stays only where it already was: on the old hub, on a standby that copied it, and in their own checkpoints, which never leave those computers.
- sheet: Devices: Devices paired before the backup find this node without pairing again: its key is in the roster they hold. A device paired after it needs pairing again.
- sheet: Epoch: This node becomes the hub at epoch 8: higher than its own record (7), the backup’s (7) and the newest roster your devices have shown it (epoch 7, from one device). A device that saw a newer one hasn’t told this node.
- sheet: The stable name: Devices look for the hub at http://127.0.0.1:42589.
- sheet: Why it asks: It changes which computer runs Nova and holds your data, so it needs your explicit confirmation every time (tier 3).
- ledger: “Emergency promotion from the backup of 2026-11-01T06:46:12.986Z”: done
- ledger: “Promoted from a backup: this node is the hub”: done
- memory written after the backup: absent on N2 (lost, as said); the connector secret: not in N2’s vault (1 secrets)
- the computer follows N2 at epoch 8 with no new pairing; the phone signs in at the stable name

**Case 5.** The old hub back while the new one is down: the computer refuses its lower epoch (0.5 s)
- the computer says: http://127.0.0.1:42589 can’t be reached (UND_ERR_SOCKET). http://127.0.0.1:42091 says it is hub at epoch 7, older than 8; it was replaced.

**Case 7.** N1 returns, finds N2 at epoch 8 (a pinned candidate), and steps down before it takes any change (0.9 s)
- N1 says: This node isn’t the hub any more: “Spare” at http://127.0.0.1:43313 became the hub (epoch 8) while it was away, so this one only reads. “Spare” at http://127.0.0.1:43313 is the hub.
- asked to become the hub with what it had: This node isn’t the hub any more: “Spare” at http://127.0.0.1:43313 became the hub (epoch 8) while it was away, so this one only reads. “Spare” at http://127.0.0.1:43313 is the hub. It has no copy of the hub’s latest data, so it can’t take over. Enroll it again as the standby first.

**Case 10.** A node with a valid signature from a key that isn’t pinned, at epoch 99, can’t take the role (0.0 s)
- the computer says: http://127.0.0.1:42589: Its key isn’t one this device pinned.

**Case 8.** Throughout: both nodes asked to take a change at the same moment, every 100 ms (0.1 s)
- 309 ticks; N1 took 127, N2 took 152; both in the same tick: 0

**Case 9.** No private key left its device (0.2 s)
- key files byte-identical before and after: n1 43936d154fcd…, n2 192aa56ad8a7…, computer 60f91eea283a…
- scanned 317 files (11289 KB), 4718 database rows read one by one, and 6 KB the processes printed: both homes, the computer’s home, every backup and 119 tapped messages (handover, health-answer, hello, ready-answer, stand-down-answer, start, sync, transfer-answer), for 6 private keys in 8 text encodings (JWK, hex both cases, base64, a byte list, PKCS8 DER as hex and base64, PEM) and 2 byte forms (raw, DER): none outside its own key file
- the vault’s key: no backup, tapped message, database row or output holds it; only the vault key files and their own checkpoints do

**Write probe:** 309 ticks; N1 took a change in 127, N2 in 152, both in the same tick in 0.

**Key files** (SHA-256 before and after): n1 43936d154fcd1ddc… → 43936d154fcd1ddc…; n2 192aa56ad8a79b8a… → 192aa56ad8a79b8a…; computer 60f91eea283aaa1a… → 60f91eea283aaa1a…. Scanned 317 files (11289 KB) and 119 tapped messages; private keys found outside their own key file: 0.
