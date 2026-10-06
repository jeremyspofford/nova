# S42b — carries

- **No retired-key table (P13):** an old key still running after a re-pair
  retries with "signature did not verify" until it is stopped by hand.
- **No self-revoke (P21):** `uninstall` keeps the identity and says to
  revoke it in Settings.
- **An eval case for acting on the facts (P29):** a declared device is
  read-only to the device tools, so "retire the old agent" cannot be scored
  in the corpus; it waits for a fixture that can answer `device_run`.
- **The WSL look runs as each distro's default user only;** a Nova agent
  under another user's unit is seen as a process (`novad` pid), not as a
  unit.
- **`sudo -n` can write an auth-log line at each probe** (connect and
  refresh only).
- **The public paths' limit is per door, not per address** (Task 26): the
  hub's loopback, the tailnet and any other address core sees each get
  their own 30-a-minute budget for the downloads, and a visitor through a
  relay (`Cf-Connecting-IP` present, or funnel) is counted apart, per door.
  Enroll's own limit is 5 wrong codes per 15 minutes per bucket, counted
  before the handler awaits, so a burst cannot exceed 5 checks. What is
  still carried: a stranger through a relay can still lock pairing from
  that door for up to 15 minutes, and anyone sharing that relay's bucket
  can renew the lock — the owner's own way round is the tailnet or the hub
  machine itself, whose buckets a stranger cannot reach.
- **She stated causes she never checked** (turn `01faf3b7`: "likely a sudo
  prompt" and a procedure for him, 2026-09-28). The owner SHELVED the
  reply-level handback guard on 2026-09-29 (it is not this slice's, and not
  "the coordinator's `fix/handback-guard`" — that lane is parked, not on
  main). S42b's own answer is the facts: P29 gives her what she needs to
  act unaided, and the evals score whether she does, rather than a guard
  correcting her reply after the fact.
- **Task 10c's Windows half, on Task 1's branch T3 only:** the agent could
  not take the terminal away from `wsl.exe`'s Linux side; the readings and
  the owner question go here. Until it lands, a Windows child novad starts
  for her keeps S42a's behaviour — it can still wait on a prompt nobody can
  answer, up to the timeout.
- **The admin helper (S42c) is PAUSED**, alongside S46a:
  `platform.AdminInstallDir` is declared, nothing uses it. The standing admin path
  the owner chose instead is the doing lane's **S30b** (his answer to Q17:
  one OS prompt at setup, then any command as root/admin, recorded, never
  refused) — not S42c, and not scheduled next. Nothing in this slice's
  wording promises a future admin path, names "only named fixes," or says
  "never": elevation is stated only as what is true today (Ruling S42b ×
  Q17).
- **The macOS walk:** until the owner walks a Mac, `platform_walks.json`
  says "not walked," and the eval pins that she says so. The owner's only
  Mac is his work device, so this may stay a standing carry rather than a
  temporary one.
- **A reminder can fire up to about two minutes late** during a stalled
  update: the scheduler runs firings one after another, and the
  `agent_updates` job can hold it for as long as a single unanswered
  command's bound (120 s) while it waits on a stalled agent, only while it
  is sending (Ruling Task 20 concern 8). Carried to the doing lane's **S30**
  (long jobs) as a requirement: a timer's firing must never wait behind a
  job's device wait.
- **Close-out backlog, pre-existing (not S42b's, carried here):**
  - a frozen audit chain's single replay frame grows one entry per command,
    and past uvicorn's 16 MiB `ws_max_size` every handshake closes;
  - the Governance page renders no break meta, so a refusal, a gap and a
    tamper look identical.
- **`install.ps1` under Windows' default execution policy never reaches its
  own message.** A native Windows machine (no WSL yet) has nothing else to
  run — the hub itself needs WSL — so `install.ps1` at the repo root states
  that and gives `wsl --install`, then exits; but PowerShell's default
  policy blocks a `.ps1` file before it can print anything.
  `deploy/README.md` now gives the script's own words directly, and
  `powershell -ExecutionPolicy Bypass -File .\install.ps1` for running it.
  Carried: the script itself does not detect or work around the policy.
