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

@@SUITE@@

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

@@GATE@@
