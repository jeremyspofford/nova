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
  - `services (memory)` — **failure**, at the `Initialize containers` step
    itself, before any of the job's own commands ran.
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
