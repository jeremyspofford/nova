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
- CI jobs outside novad that were red on the first run (Task 19), with their
  log excerpts. `rebuild-ci` was turned on for this branch by owner ruling
  P17 ("both halves or neither"); before that it triggered only on
  `rebuild/**` (`ROADMAP.md`'s housekeeping note: "CI does not cover
  `main`"), so several of these may be this workflow's first time actually
  running these suites rather than anything S42a caused. Every `novad` and
  `novad-native` (Linux arm, macOS ×2) leg was green; the two Windows
  `novad-native` legs were red — those gate the merge (Task 21), so they are
  not carried here. Outside novad, from `ci-run-1.log` (captured mid-run;
  `installer` and `e2e` had not finished when the capture ended):
  - `web` — red at `Run npm test -- --run`; `gate_test.sh` and the tailnet/
    tailscale shell tests never ran (skipped after the first failure).
  - `services (core)` — red at `Run uv run ruff check .` (before `pytest`
    ever ran). Consistent with context.md's own note that "v4 trees are not
    format-clean" — this looks like the first time `ruff check .` has run
    over the whole tree in CI, not a S42a regression, but it was not
    root-caused here.
  - `services (gateway)` — `ruff check` passed; red at `Run uv run pytest`.
  - `services (memory)` — red at the `Initialize containers` step itself,
    before any of the job's own commands ran.
  - `backup-macos` — red at `Run /bin/bash ./deploy/backup_test.sh` (the
    later `pytest`/in-bundle-reader steps never ran).
  None of these jobs touch `apps/novad` or the S42a core files
  (`device_facts.py`, `devices_ws.py`, `tools/machines.py`, migration 036);
  root-causing each is separate work, not S42a's.

## From the build's reviews (appended at close-out)
