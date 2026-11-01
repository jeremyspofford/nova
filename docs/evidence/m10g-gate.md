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
- The first full run, before the roll-back asked the failing hub to stand down, failed the drill with two nodes taking a change in the same tick (see Guards); that is fixed and the drill passed in every run since.
- `scripts/ui-test.sh`: **108 tests: 108 pass** (Chromium and WebKit, in the Playwright image), `tests/ui/m10g-promotion.test.ts` among them. Its screenshots are in `docs/screenshots/m10g/`; the other evidence screenshots the run rewrote were put back as they were.
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
- **The automatic roll-back at epoch + 2.** "the new hub fails its checks (the stable name didn't
  move)…" (two cores: epoch 1 → 2 → 3) and the drill's case 3 (epoch 2 → 3 → 4): the old hub, now
  the standby, sees three failing probes, asks the failing hub to stand down, copies what it took,
  takes the role back at epoch + 2 by itself (tier 1: a problem says so), points the name back, and
  the new hub steps down and copies it afresh as its standby. Ledger: "Promotion rolled back: this
  node is the hub again" done; "Checks of “…” as the hub" failed, with the failing probe and "stopped
  taking changes first".

### 2. Emergency promotion from the latest backup

The drill's case 6, on N2 (a hub candidate that had stepped down: not the standby, no live copy),
with N1 killed: the sheet (`GET /mesh/promotion/cold`) states the backup's number and time, "What is
lost: Everything written after <that time>…", "Connectors need signing in again. The backup holds
your saved secrets encrypted but never their key, and Nova keeps no copy of that key anywhere…", the
devices, the epoch (6, max + 1), the stable name and tier 3. `confirm` is required (400 without it).
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
backup folder and the tap (`NOVA_DRILL_TAP`: every decrypted sync batch, the handover, every ready and
transfer answer and hello, as the receiving node read them) is scanned for each of the six private
keys (Ed25519 and X25519 of three devices) as JWK `d`, hex and base64; none is found outside its own
key file (and its own node's checkpoints, which never leave it). `tests/core/mesh-promotion.test.ts`
"the hub's calls to the candidate and the handover are signed, fresh, used once, and carry no key"
checks a signed call and a handover the same way. **Said plainly:** the vault's key is not a device
key; it still reaches a live standby sealed to that standby's key, as since M5b (that is how a
planned promotion keeps connectors working), so the tap holds it; no backup does.

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
  refuses, so nothing changes: 409 refused, 400 taken); the core roll-back test does the same every
  few milliseconds. Neither saw both take one. This is sampling, not a proof.
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
- **The regression eval suite** (`tests/acceptance/evals-regression.test.ts`): 25 of 25 regression tasks passed (100%), and the negative control failed every task, as it must. Nothing M10g changed is an agent outcome, so no task was added; the promotion claims are softened to what the tests show (item 6).


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
- **The window** is 30 minutes unless `NOVA_PROMOTION_WINDOW_S` says otherwise (the drill and the
  tests use seconds); there is no setting for the person, so nothing stops that variable shortening it.
- **The stable name** moves only through `NOVA_MESH_NAME_CONTROL`, and only a loopback stand-in was
  ever behind it; there is no DNS or tailnet driver. Without one, the sheet says the person moves it
  and the window doesn't check it. M10d's change chain isn't used for it (see the plan).
- **A partition:** a new hub cut off from the old one during a roll-back can't be asked to stand down,
  and an old hub cut off from every peer acts as hub until it hears of the higher epoch. Devices
  refuse its lower epoch, but anything reaching it directly could write there. Two nodes have no
  third vote; this is ADR-11's one-active-hub rule as M4 built it, not solved here.
- **The drain's bound:** work stopped at the bound is left active for the new hub, but a worker that
  ignores its stop signal can still write to the old hub's own tables after the hold (not logged, so
  never replicated; it stays on that node until the new hub's copy overwrites the row).
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

Recorded with `node scripts/promotion-drill.ts --record <file>` under the no-Kubernetes tripwire, at the branch head before this evidence was committed:

Run 2026-11-01T02:28:04.719Z on linux (Node 26.3.1), in 17 s. Every case asserts as it runs: this record exists only if each one held.

**Case 0.** Two Nova homes, a standby enrolled with its own command at the stable name, a computer and a phone paired there (1.7 s)
- N1 (hub) http://127.0.0.1:20187, N2 (standby “Spare”) http://127.0.0.1:31473, the stable name http://127.0.0.1:43463 pointing at N1
- the computer 08e860d0-ee9e-49a3-94ea-b27451907d97 pinned 2 keys at epoch 1

**Case 1.** The pre-checks refuse an ineligible candidate, for each reason the drill can make (0.2 s)
- the phone: “Pocket phone” is a phone: a screen onto Nova, never a hub.
- the computer: “Desk computer” isn’t a hub candidate. Making it one is its own explicit confirmation, in its roles.
- the standby with no backup: There is no backup. Back up now (Settings › Backups), then try again.

**Case 2.** A planned promotion N1 → N2: every step ledgered, no data lost, devices re-pointed through the stable name, N1 a live standby, the window passed (7.6 s)
- backup 1 of 2026-11-01T02:28:06.719Z, its drill passed; every pre-check passed (role, follows, disk, memory, version, schema, backup)
- ledger: “Promotion pre-checks for “Spare””: done
- ledger: “Copied to the candidate”: done
- ledger: “Running work finished or handed over”: done
- ledger: “Hub handed over to this node”: done
- ledger: ““Hub” is the standby now”: done
- ledger: “Checks of this node as the hub”: done
- content hashes equal on both: {"memory":"1a9ef0bc0dfbace857d3dc3c2d7ecc6cef6febafee8eb38679c2eb540591fbd9","profile":"de8dd8415990a79f6dcb43c3b74078da32e7633d83f4ea800eae7e91add13cde","messages":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945","plan":"118d4acfd69763e68a2d74a7e4a102a2bfacfc42ab41026b193c53ae2b875965"}
- the computer: epoch 2 at http://127.0.0.1:43463; the phone: session 200 at the stable name
- window: 15 probes over 6 s, the last passed

**Case 3.** A planned promotion N2 → N1 whose new hub fails its checks (the stable name didn’t move): N2 hub again by itself at epoch 4 = 2 + 2; N1 stepped down to copy it (2.6 s)
- ledger: “Promotion pre-checks for “Hub””: done
- ledger: “Copied to the candidate”: done
- ledger: “Running work finished or handed over”: done
- ledger: “Hub handed over to this node”: done
- ledger: ““Spare” is the standby now”: done
- ledger: “Promotion rolled back: this node is the hub again”: done
- ledger: “Checks of “Hub” as the hub”: failed
- failing probe: http://127.0.0.1:43463 doesn’t lead to “Hub” (it answers as this node).
- the computer follows N2 at epoch 4

**Case 4.** N2 killed; N1, its live standby, made the hub (M4’s promotion, epoch 5); N2 back and fenced (0.8 s)
- N2 says: This node isn’t the hub any more: “Hub” at http://127.0.0.1:20187 became the hub (epoch 5) while it was away, so this one only reads. “Hub” at http://127.0.0.1:20187 is the hub.
- asked to become the hub with what it had: This node isn’t the hub any more: “Hub” at http://127.0.0.1:20187 became the hub (epoch 5) while it was away, so this one only reads. “Hub” at http://127.0.0.1:20187 is the hub. It has no copy of the hub’s latest data, so it can’t take over. Enroll it again as the standby first.

**Case 6.** An emergency promotion from the latest backup onto N2 (a hub candidate, not the standby), with N1 unreachable (2.7 s)
- sheet: The backup: Backup 3, made 2026-11-01T02:28:17.629Z.
- sheet: What is lost: Everything written after 2026-11-01T02:28:17.629Z: changes, conversations, memories and tasks from then on are not in the backup.
- sheet: Connectors: Connectors need signing in again. The backup holds your saved secrets encrypted but never their key, and Nova keeps no copy of that key anywhere, so they can’t be opened.
- sheet: Devices: Devices paired before the backup find this node without pairing again: its key is in the roster they hold. A device paired after it needs pairing again.
- sheet: Epoch: This node becomes the hub at epoch 6, higher than any it knows of, so a hub that comes back steps down.
- sheet: The stable name: Devices look for the hub at http://127.0.0.1:43463.
- sheet: Why it asks: It changes which computer runs Nova and holds your data, so it needs your explicit confirmation every time (tier 3).
- ledger: “Emergency promotion from the backup of 2026-11-01T02:28:17.629Z”: done
- ledger: “Promoted from a backup: this node is the hub”: done
- memory written after the backup: absent on N2 (lost, as said); the connector secret: not in N2’s vault (1 secrets)
- the computer follows N2 at epoch 6 with no new pairing; the phone signs in at the stable name

**Case 5.** The old hub back while the new one is down: the computer refuses its lower epoch (0.7 s)
- the computer says: http://127.0.0.1:43463 can’t be reached (UND_ERR_SOCKET). http://127.0.0.1:20187 says it is hub at epoch 5, older than 6; it was replaced.

**Case 7.** N1 returns, finds N2 at epoch 6 (a pinned candidate), and steps down before it takes any change (1.1 s)
- N1 says: This node isn’t the hub any more: “Spare” at http://127.0.0.1:31473 became the hub (epoch 6) while it was away, so this one only reads. “Spare” at http://127.0.0.1:31473 is the hub.

**Case 10.** A node with a valid signature from a key that isn’t pinned, at epoch 99, can’t take the role (0.0 s)
- the computer says: http://127.0.0.1:43463: Its key isn’t one this device pinned.

**Case 8.** Throughout: both nodes asked to take a change at the same moment, every 100 ms (0.1 s)
- 161 ticks; N1 took 51, N2 took 78; both in the same tick: 0

**Case 9.** No private key left its device (0.1 s)
- key files byte-identical before and after: n1 58f260b852c8…, n2 976ceb2bd871…, computer bbbb995b656e…
- scanned 229 files (6976 KB): both homes, the computer’s home, every backup and 43 tapped messages (handover, hello, ready-answer, stand-down-answer, start, sync, transfer-answer), for 6 private keys in 3 encodings each: none found outside its own key file
- no backup in the drill’s backup folder (a temp folder) holds the vault’s key

**Write probe:** 161 ticks; N1 took a change in 51, N2 in 78, both in the same tick in 0.

**Key files** (SHA-256 before and after): n1 58f260b852c8f2a9… → 58f260b852c8f2a9…; n2 976ceb2bd87114c7… → 976ceb2bd87114c7…; computer bbbb995b656e7c86… → bbbb995b656e7c86…. Scanned 229 files (6976 KB) and 43 tapped messages; private keys found outside their own key file: 0.

