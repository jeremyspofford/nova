# S42a — carries

- The Windows config dir is Roaming `%AppData%` (per spec). A roaming profile
  would carry the device key; `%LocalAppData%` is the alternative, and is the
  owner's call.
- macOS available memory is "unknown" until `vm_stat` is parsed.
- Windows console programs other than `wsl.exe` print in the OEM code page.
  Non-ASCII output from them may mangle.
- SmartScreen or Smart App Control on the unsigned exe is measured by P0-20
  (S42b).
- The facts frame carries only `net` and `unreadable`. power, ollama,
  compute, hold and overlay arrive with S46a, S44 and S43a (P1).
- `WSL_DISTRO_NAME` is absent under the systemd unit, so an in-WSL agent's
  `distro` is `""` there.
- A pre-S42a agent sends no facts: invisible to `duplicate_agent`, and
  retired by hand in the walk (P14).
- Core has no caller of `facts.refresh` yet. S46a is the first.
- CI jobs outside novad that were red on the first run (Task 19). `rebuild-ci`
  was turned on for this branch by owner ruling P17 ("both halves or
  neither"); before that it triggered only on `rebuild/**` (`ROADMAP.md`'s
  housekeeping note: "CI does not cover `main`"), so this is several of
  these suites' first time actually running in CI. Final per-job result of
  that run (`gh run view`; three of the specifics below — the exact ruff
  errors, the web test name, the backup_test.sh block — were independently
  confirmed against the referenced files, not just relayed):
  - `installer`, `backup`, `novad`, and `novad-native` on
    `ubuntu-24.04-arm`/`macos-15`/`macos-15-intel` — **success**.
  - `novad-native` on `windows-2025` and `windows-11-arm` — **failure**: two
    Unix-only fault-injection tests assumed an ENOTDIR-shaped error was
    possible on Windows; there it is indistinguishable from "missing"
    (`syscall.Errno.Is` maps it to `oserror.ErrNotExist` on that platform),
    so the tests' premise was false, not the product code. Already fixed
    and split by OS in a later commit on this branch (`aff62866`, landed
    after this task's own commits) — a second CI run should show these
    green. Not carried further; it is resolved on this branch already.
  - `services (core)` — **failure**, at `ruff check .`: 3 pre-existing
    errors, none in a file S42a touched — `tests/test_chat_attachments.py`
    (F401, unused `tests.fakes` import), `tests/test_recall_sources.py`
    (F401, unused `uuid` import), `tests/test_tools_skills.py` (E501, one
    101-character line at 109). Confirmed by running `ruff check` on those
    three files directly.
  - `services (gateway)` — **cancelled**, per the run's final result — not a
    failure of its own steps. (`ci-run-1.log`'s own mid-run capture, taken
    before the run resolved, had shown it red at `pytest` with a green
    `ruff check`; `rebuild-ci.yml` has no `concurrency`/`cancel-in-progress`
    setting, so why the final state reads "cancelled" rather than that
    isn't explained by anything checked here.)
  - `services (memory)` — **cancelled**, per the run's final result — the
    same shape as `services (gateway)`, two lines above: the
    `Initialize containers` step never completed and every step after it is
    marked skipped, so none of the job's own commands ran.
  - `web` — **failure**, at `ProvidersSection.test.tsx`'s "adding from the
    OpenRouter preset sends the preset shape and shows the new row": expected
    `''` to be `'https://openrouter.ai/api/v1'`. Passes locally, so this
    reads as a CI-environment difference, not a regression S42a caused.
  - `backup-macos` — **failure**, at `backup_test.sh`'s "coverage block" (28
    passed, 1 failed).
  - `e2e` — **skipped**, by design (Task 19: "the disabled e2e job").
  None of the outside-novad failures touch `apps/novad` or the S42a core
  files (`device_facts.py`, `devices_ws.py`, `tools/machines.py`, migration
  036); root-causing each is separate work, not S42a's. CI run 2's results
  belong at close-out (Task 21).

## From the build's reviews (appended at close-out)

From the final whole-branch review and its triage
(`.superpowers/sdd/plan/final-review-triage.md`). Named follow-ups first,
each a known gap; an owner slice is given only where the triage names one.
None of these duplicate a carry listed above this heading.

- A handler `WaitGroup` / sealed audit log: a late audit `Append` from a
  command still in its `WaitDelay` can recreate `audit.jsonl` after a
  revoke's wipe and continue the old chain (core then flags
  `DEVICE_AUDIT_BREAK` after a re-pair); also `main` returns without waiting
  for in-flight handlers on SIGTERM (`Setpgid` children can be orphaned).
  README's "never replays" holds barring this race.
- A Windows Job object: descendants survive when the root exited before
  Cancel (`taskkill /T` cannot walk from a dead root).
- A test that the reconnect backoff resets ONLY after an authenticated
  session (the behavior is built; nothing pins it).
- Device-aware state guard: `_checked_a_device` credits per turn, not per
  device (inherited from `device_*` spans); a `machine_status` filtered to
  agent A, or a shown agent's fact, can back a claim about agent B.
- Core signs a revoked proof before the device proves its key (anyone
  presenting a revoked id can collect proofs over core's nonces and learn the
  id is revoked; matters only after a DB restore) — verify the auth signature
  against the revoked row's key first; and `envelope.go`'s comment overclaims
  the nonce's replay protection (the peer chooses the challenge nonce).
- Engine facts are not clip-filtered (S44): once S44 lists more engines, a
  long list could clip engine lines the same way a device's own line could be
  clipped before this build's I2 fix.
- The I2 filter fails closed in two rare cases (an agent-reported text with a
  newline — novad trims them; one device name being another's prefix followed
  by " (") — a shown line's fact can be dropped and an honest claim
  corrected.
- The `device_run` capability row still fires on some purpose/possessive
  phrasings with kept verbs ("I can't access a Windows machine's GPU for
  models yet") and misses some disowning forms ("I don't have access to
  Windows machines", "I can't reach any Mac"); capability patterns guard-wide
  have no hypothetical/quoted-speech detection.
- `Paths.Enrolled()` treats any `Stat` error as "not enrolled" in `cmdEnroll`
  (an unreadable config dir spends a pairing code and leaves an orphan row;
  `Save` would fail, so no overwrite) — use `checkEnrolled` there instead.
- The Windows `TerminateProcess` path, the DACL read-back, the invalid-name
  test twins and the toast/apps mechanisms are verified by CI's native
  runners and by reading, not yet by a human on the machine — the Dell walk
  is their first human-observed run.

Carries with reasons (fine to ship):

- Near-miss revoke reason tests send no proof (the proof check is the real
  boundary; six proof cases pin it).
- The clock-jump test can fail falsely (never pass falsely) if its setup
  outlasts a 120 ms settle.
- Pre-existing, guard-wide: capability patterns fire on hypothetical or
  quoted denials.
- "2 machine(s)" for one PC plus its WSL distro (P13 grouping kept) — the
  label is an owner wording call.
- Main's regex timing edge on the N150: `_IN_USE_AFTER_GAP`, `_IN_USE_DENIED`,
  `_READING_LINE` fail every run here (~52-75 ms vs a 50 ms budget);
  `_IN_USE_CONJUNCT`, `_SUBJECT_KEY_LINE`, `_LINE_LABEL` intermittently under
  load. Not S42a's; the budget was never raised. The sweep now reaches 221+
  patterns (was 162) — none of the newly swept ones is slow.
- The raw websocket frame is bounded only by uvicorn's 16 MiB default before
  `json.loads` (pre-existing; the auth frame is parsed before identity).
- Cosmetic/test-only minors from the per-task reviews (comment wording, test
  hygiene: hijacked test handlers parked for the binary's life, the `WSL()`
  stub duplicated darwin/windows, Linux notify's `LookPath` bypassing the
  Runner, a few coverage gaps) — recorded in the SDD ledger
  (`.superpowers/sdd/plan/progress.md`), none affects behavior.

## From the walk and the eval (appended at close-out)

- CI's `web` job: `deploy/tailscale/start_test.sh`'s "MOVED_TO: states the
  flap it is preventing" fails against main's own `start.sh` (expects "node
  key" in the refusal) — pre-existing, and had been masked earlier while the
  job stopped first at the flaky `ProvidersSection` test.
- The desktop guess (walk turn 2): she read `C:\Users\Public\Desktop`
  instead of `device_info`'s own `desktop=` line — it looked right because
  Windows shows both desktops together. -> **S42b:** resolve "Desktop" on
  the agent so there is nothing to guess.
- The WSL-advice eval failure: `points-wsl-at-the-windows-agent` failed 0/3
  because she reaches for `device_list` before `machine_status`, and
  `device_list` carries no WSL role reason. -> **S42b:** deliver the WSL
  fact through `device_list`'s own line and the device tools too.
- The WSL agent the owner chose to keep running on the Dell is the
  pre-S42a build: it sends no facts, carries none of S42a's fixes, and Nova
  cannot update it yet. -> **S42b:** update it in place, or retire it — the
  Windows agent already reaches WSL through `wsl.exe`, proven in the walk.
