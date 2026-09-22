# S41 requirements map — portable hub + verified backup/restore drill

Read-only reconciliation of every document that specifies or constrains S41,
made 2026-09-19. **Read [`rulings.md`](rulings.md) first**: it settles open
questions 1, 2 and 5 below, and arc 8 now wins wherever it contradicts the
plain-tar bullets.

**Slice-numbering trap:** round 1 numbers differently. In `hub/r1-integration.md`,
"S41" (`:363`) is the *inference node* slice and backup/restore is r1's **S42a**
(`hub/r1-integration.md:461`, `hub/r1-hubmove-design.md`). `hub-topology.md`
(approved 2026-09-18) and `hub/r2-integration.md` renumber backup/restore to
**S41**; `hub/r2-integration.md:395` ("Scope. The baseline S42a, plus:") scopes
today's S41 against r1's S42a. Reading r1's "S41" literally will mislead.

## 1. What S41 must ship

1. MUST — a complete **encrypted** bundle (owner ruling, v3 #31/#32). [`ARCS.md:381`, `hub-topology.md:284`]
2. MUST — the passphrase comes through a **resolver seam**, never hardcoded. [`ARCS.md:381-382`, `hub-topology.md:284-285`]
3. MUST — the standalone restore script travels **inside every bundle**. [`ARCS.md:383`, `hub-topology.md:286`]
4. MUST — coverage **derived from the compose file**; an unclassified volume **refuses** rather than silently skipping. [`ARCS.md:384-385`, `hub-topology.md:287-289`]
5. MUST — build the restore-drill **verb**; the weekly schedule may land later. [`ARCS.md:382-383`, `hub-topology.md:290`]
6. MUST — `backup`: stop the writers and verify they stopped. [`hub-topology.md:300`]
7. MUST — `backup`: per-table row counts and md5s. [`hub-topology.md:301`, `hub/r1-hubmove-design.md:8`]
8. MUST — `backup`: `pg_dump -Fc` **inside** the postgres container (client/server match by construction). [`hub-topology.md:302`, `hub/r1-hubmove-design.md:6,469`]
9. MUST — `backup`: self-test restore into `nova_verify_*` before a backup counts as written. [`hub-topology.md:303`, `hub/r1-hubmove-design.md:7,174`]
10. MUST — `backup`: tar the volumes with sha256 listings. [`hub-topology.md:304`, `hub/r1-hubmove-design.md:175`]
11. MUST — `backup`: write the MANIFEST (r2 adds a `transport` field). [`hub-topology.md:305`, `hub/r2-integration.md:402`]
12. MUST — `restore`: `decide_subnet` **first** (the 172.18 collision) via `${NOVA_SUBNET}` / `NOVA_SUBNET_GATEWAY`. [`hub-topology.md:308`, `hub-p0-measurements.md:65`, `hub/r2-integration.md:399`]
13. MUST — `restore`: verify hashes. [`hub-topology.md:309`]
14. MUST — `restore`: refuse a non-empty target or an older `pg_restore`. [`hub-topology.md:310`, `hub/r1-hubmove-design.md:181`]
15. MUST — `restore`: `--single-transaction`. [`hub-topology.md:311`, `hub/r1-hubmove-design.md:184`]
16. MUST — `restore`: re-verify counts, md5s and the signing-key fingerprint. [`hub-topology.md:312`]
17. MUST — `--drill` restores into throwaway volumes. [`hub-topology.md:313`]
18. MUST — `--move` / `undo-move` write `MOVED_TO`; the sidecar refuses to start while it is present. [`hub-topology.md:313`]
19. MUST — novad `repoint`. [`hub-topology.md:314`, `hub/r2-integration.md:404`]
20. MUST — `deploy/backup.sh` + `install.sh` bash-3.2 portable. [`hub-topology.md:298`, `hub/r2-integration.md:396`]
21. MUST — `sha256_of`: `sha256sum`, else `shasum -a 256`. [`hub/r2-integration.md:397`]
22. MUST — `host_routes_in_use`: `ip -4 route`, else `netstat -rn`. [`hub/r2-integration.md:398`]
23. MUST — `decide_subnet` exports `NOVA_SUBNET_GATEWAY`. [`hub/r2-integration.md:399`]
24. MUST — tars built inside throwaway containers. [`hub/r2-integration.md:400`]
25. MUST — a mode-probe replaces the hardcoded `/mnt/[a-z]/`. [`hub/r2-integration.md:401`]
26. MUST — an archive path that cannot hold mode 0600 is refused. [`hub/r2-integration.md:410`]
27. MUST — CI runs `install_test.sh` and `backup_test.sh` on `macos-15` under `/bin/bash`. [`hub-topology.md:316`, `hub/r2-integration.md:406`]
28. MUST — walk: back up on the Dell, `restore --drill` on the mini PC; counts, md5s and the key fingerprint equal. [`hub-topology.md:318`, `hub/r2-integration.md:409`]
29. MUST — `install.sh` refuses when a foreign `nova` compose project is on the target, naming its containers. [`slice-40-carries.md:65-66`, `hub-p0-measurements.md:58-66`] — **extended by ruling 1**: it then offers to delete what it named.
30. CARRIED — S41 is operator tooling: **no chat step, no new tool, no guard, no eval**; the move's chat walk is S45. [`hub/r2-integration.md:411,224,346`]
31. CARRIED — no core or gateway migrations in S41. [`hub/r2-integration.md:346`]
32. CARRIED (illustrative; superseded by #4's compose-derived coverage) — r1's volume list: carries the three DB dumps, `v4_memdata`, `v4_workspace`, `v4_tailscale` (move only) and `.env` secret keys (empty target only); excludes raw `v4_pgdata`, `v4_ollama`, `v4_models`, `data/hardware.json`, host-specific `.env` keys, searxng state, novad's files. [`hub/r1-hubmove-design.md:83-97`]
33. CARRIED — D21 keeps "every backup/restore/move verb" and the code card out of her context. [`hub-topology.md:141`, `hub/r2-integration.md:67`]

## 2. Arc 8 vs the plain-tar bullets — the conflict, now ruled

Arc 8 (`ARCS.md:380-388`) requires the encrypted bundle, the resolver seam, the
weekly drill, the restore script inside every bundle, and compose-derived
coverage that refuses on an unclassified volume. It rests on the owner's
2026-08-02 ruling (v3 #31, `ARCS.md:375-378`): a "100% backup and restore
process … spin Nova up on a different machine and keep configurations, secrets,
conversation and memories".

The operative S41 bullets (`hub-topology.md:298-318`,
`hub/r2-integration.md:393-411`) describe a **plain** pipeline with no
encryption, no passphrase and no resolver seam, and still list
`BACKUP_EXCLUDE_DATA` as a deliverable.

Four conflicts, all resolved by ruling 2 in favour of arc 8:
- **Encryption**: required; absent from the bullets.
- **Coverage**: arc 8 replaces the hand-kept list; the bullets still build it.
- **Secrets in the bundle**: encryption reverses D15 (`hub-topology.md:135`) and
  the S43b "backups exclude `network_credentials`" text
  (`hub-topology.md:411`, `hub/r2-integration.md:61,550`), neither of which was
  edited. Dormant at S41 (the table arrives with S43a), live by S43b.
- **Proposal A sequencing**: `map-roadmap-decisions.md:8,116` puts it after S26;
  arc 8 and `hub-topology.md:294-296` say plan it with S41. Ruled: seam only.

## 3. Owner rulings that bind S41

- **2026-08-02 (v3 #31):** "a 100% backup and restore process … if a computer
  crashes, spin Nova up on a different machine and keep configurations, secrets,
  conversation and memories, so it's like we only lost what happened since the
  last backup." [`ARCS.md:375-378`]
- **v3 #32:** built-in encrypted store first; `{{secret:name}}` resolved only at
  the outbound call; agents list names, never values; 1Password/Bitwarden as
  later resolvers behind the same seam. [`ARCS.md:386-388`]
- **2026-09-18, decision 5:** migrate the Dell's Nova to the mini PC, with
  backup and restore both verified. [`hub-topology.md:50`]
- **Round 2 wins** wherever the rounds conflict. [`hub-topology.md:6-8`]
- **2026-09-21:** delete the mini PC's old `nova` stack and its volumes; ship
  the encrypted bundle in S41. [`rulings.md`]

## 4. Measured facts that bind S41

- Mini PC: N150, 4 cores, 16 GB (15.4 GiB total, **12.5 GiB free** beside
  minecraft), 351 GB free disk, Pop!_OS 24.04, Docker 29.8, compose v5.5.1,
  linger on, AC sleep `nothing`. [`hub-topology.md:76-82`, `hub-p0-measurements.md:49-54`]
- ~~**172.18/16 is already taken on the mini PC**~~ — **superseded 2026-09-21.**
  After the cleanup only **172.17** (docker0) and **172.19** (jobhunter) are
  allocated there, so v4's pinned 172.18 is free and the r1 prediction of
  172.22 is stale. `decide_subnet` is still required as a general mechanism,
  and 172.19 still has to be avoided, but the collision is not a live blocker
  for this install. [`s41/map-minipc-measured.md`, "After the cleanup"]
- ~~The stopped platform-line `nova` project on the mini PC~~ — **gone,
  2026-09-21.** Archived and removed on the owner's instruction, together with
  the `docker` (nova-ai-platform) and `project` stacks. There is no foreign
  `nova` project on that machine any more, so requirement 29's refusal cannot
  be walked against a real one; it is proven by fixtures plus a **synthetic**
  foreign project the walk builds itself (`rulings.md`). The pre-cleanup
  reading in `s41/map-minipc-measured.md` is kept verbatim because the
  fixtures are built from it.
- pg client/server matching is solved **by construction** (dump with the
  container's own `pg_dump`); the MANIFEST records `pg_server_version` and
  `pg_dump_major`; restore refuses a lower major.
  [`hub/r1-hubmove-design.md:6,74,181`]
- **Postgres minor parity on the mini PC was never measured** — listed as a
  check (`hub/r1-integration.md:276`) and an assumption (M2,
  `hub/r1-hubmove-design.md:405`); no reading in `hub-p0-measurements.md`.
- Runners available: `macos-15`, `macos-15-intel`, `windows-2025`,
  `windows-11-arm`, `ubuntu-24.04-arm`. [`hub-topology.md:101`]

## 5. Open questions

1. ~~Encryption mechanics~~ — **ruled**: mine v3's `backup_crypto.py` /
   `backup_passphrase.py`; seam only, no secrets store.
2. ~~`BACKUP_EXCLUDE_DATA` vs compose-derived coverage~~ — **ruled**:
   compose-derived, refusing on unclassified.
3. **`network_credentials` in the bundle** — ruled carried (schema-driven
   coverage picks it up at S43a); the contradicting text is corrected by S41.
4. **Proposal A sequencing** — ruled out of S41; the seam is what lands.
5. ~~The mini PC's stray `nova` stack~~ — **ruled**: the installer names it and
   offers to delete containers and volumes.
6. **Postgres minor parity** — still open: measure it on the mini PC, or rely
   only on the runtime major-version refusal?
