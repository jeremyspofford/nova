# S47: setup QR codes — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking. **The spec is the authority**: where a task
> and the spec disagree, the task is wrong — stop and say so.

**Goal:** Nova hands out QR codes — in Settings and as cards in chat — for adding a
machine she controls, adding a model server, installing the PWA on a phone, and getting
the native app; every code encodes a link on her real tailnet address.

**Architecture:**
- **Deploy:** the tailscale sidecar writes what tailscaled says to a status file every 15 s,
  on a volume core mounts read-only (D17, pulled forward from S43a).
- **Core:** `network.address()` is the one reader of that file. Two registered tools,
  `nova_address` and `show_setup_qr`, and a UI-only **card channel** let her put a QR card
  in the chat without the pairing code ever entering her context. Two new guards
  (`code_claim`, `address_claim`) and a narration kind catch invented codes, addresses and
  claims of a card. Three eval cases pin it.
- **Web:** one QR component, one `SetupPanel` for all four setups, a Settings section, a
  chat card, and three signed-out pages (`/install`, `/app`, `/add`) that pick their steps
  from the device that opens them.

**Tech Stack:** POSIX sh (busybox, in the pinned tailscale image); Python 3.12, FastAPI,
asyncpg, pytest (core); React 18, TypeScript, Vite, vitest, @testing-library/react (web);
`uqr` 0.1.3 (QR encoder, MIT, zero dependencies); `jsqr` 1.4.0 (decoder, tests only,
Apache-2.0).

**Spec:** [`s47/spec.md`](s47/spec.md) — read it before any task. Background:
[`hub-topology.md`](hub-topology.md) §S47, [`hub/r2-integration.md`](hub/r2-integration.md)
D14/D17, [`no-approvals.md`](no-approvals.md).

## Global Constraints

- **A QR code never encodes loopback, an IP address, or plain http.** Every setup link is
  `https://<derived address>/<page>` (spec §3, §10).
- **The pairing code** exists in exactly two places: the `card` SSE frame and the browser
  that renders it. Never in her tool result, `result_head`, span meta, `messages`, a log
  line, or a reloaded card. The database keeps only `devices.hash_code(code)` (spec §7).
- **The code rides in the URL fragment**: `https://<address>/add#ABCD-2345` (spec §3).
- **`network.address()` states an origin only when all hold** on the status file: it exists
  and parses; `version == 1`; `written_at` at most **45 s** old; `backend_state ==
  "Running"`; `serve_ok` and `https_cert` are `true`; `dns_name` matches a `*.ts.net` name
  (spec §4). Otherwise `None` plus the FIRST failed condition, in the owner's words.
- **The status file** is `/run/nova-status/tailscale.json`, written every **15 s**,
  atomically, by `deploy/tailscale/start.sh` only, only after step 4 verified the mapping.
  Step 0 (`MOVED_TO`) stays first (spec §4).
- **`v4_status`** carries `x-nova-backup: exclude-derived` with the spec's reason (spec §4).
- **The card channel exists only** for turns started by `POST /api/v1/chat/stream` and for
  the eval runner's recorder. Scheduled, queued-drain and agent turns get `None`, and
  `show_setup_qr` states that it cannot (spec §7).
- **Her results say "sent to the chat"**, never "on your screen" (spec §7).
- **No approvals.** `test_no_approvals.py` stays green; its one move is the `ToolContext`
  field-set pin gaining `card` (Task 3), with the reason written. A refusal states that a
  call *cannot* run, never that it *may not* (spec §2, §12).
- **`card` is keyword-only, default `None`,** on `_run_turn`, `_spawn_turn` and
  `context_for`; only the stream route and the eval runner pass it
  (`tests/test_scheduler.py` pins the scheduler's keyword set).
- **Pinned moves:** tool registry 41 → 43; eval corpus 26 → 29; `suite_version` 15 → 16
  for every case (spec §12).
- **Store links:** empty (`null`) in both `apps/web/src/lib/nativeApp.ts` and
  `services/core/app/native_app.py`, pinned equal by a core test (spec §5).
- **The public pages** `/install`, `/app`, `/add` render before the sign-in gate, call no
  API, and read only `location` and the user agent (spec §5).
- **Never touched:** `apps/novad`, `services/gateway`, any migration (spec §15).
- **The repo is public:** fixtures use `nova.fake-tailnet.ts.net` (the name
  `start_test.sh` already uses); no real tailnet name, IP, MAC or code anywhere.

## Review Focus

The five inputs most likely to bite a person that no spec line spells out — each is pinned
by a test in the task named:

1. **The owner opens Settings on the hub at `http://127.0.0.1:3000`.** The panels must
   still encode the tailnet address from `GET /api/v1/network/address`, never
   `window.location`. Test in Task 8 (`SetupPanel` given a loopback `window.location`).
2. **A code typed or scanned in another shape** — lowercase, no dash, extra characters
   (`#abcd2345`, `#ABCD-2345?x=1`, `#code=ABCD2345`, `#`). `/add` must show `ABCD-2345` for
   the first three and ask for the code for the last. Tests in Task 8
   (`parseCodeFragment`) and Task 9 (`/add` with a lowercase fragment).
3. **The mint fails** (database down) after the address was read. `show_setup_qr` must
   state the failure and send **no** card. Test in Task 4.
4. **A reload after a machine card.** The redrawn card must carry no code and say it was
   shown once, whether the code has expired or not. Test in Task 4 (`messages_json`) and
   Task 10 (the reloaded row renders no code).
5. **A browser without `navigator.share`** (desktop Firefox, older Android WebViews).
   `/add` must not render a Share button that does nothing. Test in Task 9.

## Working rules for every task

- **Where:** the worktree `/home/jeremy/workspace/nova/.worktrees/qr`, branch `slice/s47`.
  Every git command is `git -C /home/jeremy/workspace/nova/.worktrees/qr …` — the shell's
  cwd resets between calls, and a bare `git commit` has landed in the wrong checkout before.
- **Commits:** stage by path, never `git add -A` or `git add .`. Straight after each commit,
  `git -C … show --stat HEAD`; fix anything you did not mean to include before moving on.
  End every message with the two attribution lines the session gives you.
- **Core tests:** `cd services/core && TEST_DATABASE_URL=… uv run pytest -q <paths>`,
  against `nova-scratch-pg` on `127.0.0.1:55432` with **this lane's own database**:
  ```bash
  PGPW="$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')"
  docker exec nova-scratch-pg createdb -U postgres nova_core_s47 2>/dev/null || true
  export TEST_DATABASE_URL="postgresql://postgres:${PGPW}@127.0.0.1:55432/nova_core_s47"
  ```
  Never point two lanes at one database: `conftest.py` drops and re-migrates it.
- **Core lint:** `uv run ruff check app tests`, and `uv run ruff format <only the files you
  edited>` — the tree is not format-clean, and a whole-tree format is someone else's diff.
- **Web:** `cd apps/web && npm test -- <pattern>` and `npx tsc --noEmit`. Never
  `npx vitest run` (the localStorage trap on newer Node).
- **Shell tests:** run under `bash`, never zsh (`deploy/tailscale/start_test.sh` needs
  docker; allow ~5 minutes).
- **No emojis** anywhere — code, copy, commits.
- **`$SCRATCHPAD`** in a command means your session's scratchpad directory (never `/tmp` directly).

## Before Task 1: prepare the worktree

- [ ] **Step 1:** Trust the worktree's toolchain file (the worktree is nested inside the
  deploy tree, so mise reads both copies):
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/qr && mise trust && mise trust /home/jeremy/workspace/nova
  ```
- [ ] **Step 2:** Install dependencies:
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/qr/services/core && uv sync
  cd /home/jeremy/workspace/nova/.worktrees/qr/apps/web && npm ci
  cd /home/jeremy/workspace/nova/.worktrees/qr/deploy/backup && uv sync
  ```
- [ ] **Step 3:** Baseline, so a later red is known to be yours. Run and record the counts:
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/qr/services/core && uv run pytest -q -x --timeout=120 2>&1 | tail -3
  cd /home/jeremy/workspace/nova/.worktrees/qr/apps/web && npm test 2>&1 | tail -5
  ```
  Expected: both green. If either is red before you change anything, stop and report it.

## File structure

| File | Responsibility |
|---|---|
| `deploy/tailscale/start.sh` | + section 4b: the status loop (write, retry, never fatal) |
| `deploy/tailscale/start_test.sh` | + the status-loop cases, + the `v4_status` mount pins |
| `deploy/docker-compose.yml` | + `v4_status` (tailscale rw, core ro) and its backup disposition |
| `deploy/backup/tests/test_policy.py`, `test_raw_compose.py`, `deploy/backup/fixtures/*` | the pinned volume set moves; fixtures refreshed by `refresh.sh` |
| `services/core/app/network.py` | the ONE reader of the status file: `address()` |
| `services/core/app/network_api.py` | `GET /api/v1/network/address` |
| `services/core/app/native_app.py` | the store links (both `None`) |
| `services/core/app/tools/base.py` | + `ToolContext.card` |
| `services/core/app/tools/__init__.py` | `context_for(card=…)`; registers `setup.TOOLS` |
| `services/core/app/chat.py` | `_run_turn(card=…)`, `_spawn_turn(card=…)`, the stream route's card channel, the guard sites |
| `services/core/app/tools/setup.py` | `nova_address`, `show_setup_qr`, the `PAIRING` seam |
| `services/core/app/conversations.py` | `messages_json` gains `cards` |
| `services/core/app/live_facts.py` | `nova_address` in `AUTO_RUN` |
| `services/core/app/guards.py` | `code_claim_check`, `address_claim_check`, narration kind `showed_setup_qr`, the capability and offer entries |
| `services/core/app/evals/runner.py`, `app/evals/cases/*.json` | the `PAIRING` fixture and card recorder for every case; 3 new cases; `suite_version` 16 |
| `apps/web/src/lib/qr.ts`, `components/QrCode.tsx` | the encoder wrapper, the refusal rule, the SVG |
| `apps/web/src/lib/devicePlatform.ts` | OS and browser from the user agent |
| `apps/web/src/lib/nativeApp.ts` | the store links (both `null`) |
| `apps/web/src/lib/setupSteps.ts` | every install/add step, per setup and platform, with its source |
| `apps/web/src/components/SetupPanel.tsx` | one panel for all four setups (Settings, chat card) |
| `apps/web/src/pages/settings/AddToNovaSection.tsx` | the four tiles on Settings → Devices |
| `apps/web/src/pages/public/*` | `/install`, `/app`, `/add` and their shared shell |
| `apps/web/src/App.tsx` | the public routes ahead of the gate |
| `apps/web/src/lib/streamChat.ts`, `pages/chat/chatReducer.ts`, `pages/chat/MessageBubble.tsx`, `lib/api.ts` | the `card` event, live and reloaded cards, rendering |

---

### Task 1: The sidecar publishes the tailnet's state; core can read it

**Files:**
- Modify: `deploy/tailscale/start.sh` (insert section 4b before `# ---- 5.`; change step 5)
- Modify: `deploy/tailscale/start_test.sh` (driver cases, assertions, cleanup, mount pins)
- Modify: `deploy/docker-compose.yml` (tailscale volumes, core volumes, top-level `volumes:`)
- Modify: `deploy/backup/tests/test_policy.py:210-229`, `deploy/backup/tests/test_raw_compose.py:490-500`
- Regenerate: `deploy/backup/fixtures/` via `deploy/backup/fixtures/refresh.sh`

**Interfaces:**
- Produces: the file `/run/nova-status/tailscale.json` inside the sidecar and (read-only)
  inside core, shaped exactly:
  `{"version": 1, "backend_state": "<state>", "dns_name": "<name without trailing dot>", "serve_ok": <bool>, "https_cert": <bool>, "written_at": "YYYY-MM-DDTHH:MM:SSZ"}`
- Env knobs (tests only): `NOVA_STATUS_DIR` (default `/run/nova-status`),
  `NOVA_STATUS_INTERVAL` (default `15`).

- [ ] **Step 1: Write the failing shell tests.** In `start_test.sh`:

  (a) In `cleanup()`, after the `v4_tailscale` volume removal, add:
  ```bash
  docker volume rm "${PROJECT}_v4_status" >/dev/null 2>&1 || true
  ```
  (b) In the driver heredoc (`driver.sh`), add a case before `*)`:
  ```sh
    status-loop)
      sh /config/start.sh > "$FAKE_DIR/out" 2>&1 &
      W=$!
      SD="${NOVA_STATUS_DIR:-/run/nova-status}"
      i=0
      while [ ! -f "$SD/tailscale.json" ] && [ "$i" -lt 60 ]; do sleep 0.5; i=$((i + 1)); done
      first="$(sed -n 's/.*"written_at": "\([^"]*\)".*/\1/p' "$SD/tailscale.json" 2>/dev/null)"
      sleep 3
      second="$(sed -n 's/.*"written_at": "\([^"]*\)".*/\1/p' "$SD/tailscale.json" 2>/dev/null)"
      if [ -n "$first" ] && [ "$first" != "$second" ]; then echo "rewritten=yes"; else echo "rewritten=no"; fi
      echo "status_dir_entries=$(ls -A "$SD" 2>/dev/null | tr '\n' ' ')"
      if kill -0 "$W" 2>/dev/null; then echo "wrapper_alive=yes"; else echo "wrapper_alive=no"; fi
      kill -TERM "$W"
      wait "$W"
      rc=$?
      ;;
  ```
  and, next to the other trailing `echo` lines at the end of the driver, add:
  ```sh
  echo "status_file=$(tr -d '\n' < "${NOVA_STATUS_DIR:-/run/nova-status}/tailscale.json" 2>/dev/null)"
  ```
  (c) After the `# ── 1d'.` block, add:
  ```bash
  # ── 1d''. the status file core reads (D17, S47) ──────────────────────────────
  OUT="$(run_wrapper status-loop -e FAKE_STATE=Running -e NOVA_STATUS_INTERVAL=1)"
  SF="$(field "$OUT" status_file)"
  expect_contains "status: version 1" "$SF" '"version": 1'
  expect_contains "status: the state tailscaled reports" "$SF" '"backend_state": "Running"'
  expect_contains "status: the DNS name without its trailing dot" "$SF" '"dns_name": "nova.fake-tailnet.ts.net"'
  expect_contains "status: the mapping, read on the tick" "$SF" '"serve_ok": true'
  expect_contains "status: the certificate domain" "$SF" '"https_cert": true'
  expect_contains "status: a UTC timestamp" "$SF" '"written_at": "20'
  expect_eq "status: rewritten on the next tick" "$(field "$OUT" rewritten)" yes
  expect_eq "status: the atomic write leaves no temp file" "$(field "$OUT" status_dir_entries)" "tailscale.json "
  expect_eq "status: the wrapper is still up while it writes" "$(field "$OUT" wrapper_alive)" yes
  expect_eq "status: containerboot's status is still the wrapper's" "$(field "$OUT" rc)" 37

  OUT="$(run_wrapper status-loop -e FAKE_STATE=Running -e NOVA_STATUS_INTERVAL=1 -e NOVA_STATUS_DIR=/proc/nova-status-cannot-exist)"
  expect_eq "status, unwritable: the wrapper stays up" "$(field "$OUT" wrapper_alive)" yes
  expect_contains "status, unwritable: says it could not write" "$OUT" "could not write /proc/nova-status-cannot-exist/tailscale.json"

  OUT="$(run_wrapper never-running-status -e FAKE_STATE=NeedsLogin)"
  expect_eq "status: never written when tailscaled never reached Running" "$(field "$OUT" status_file)" ""
  ```
  (d) In the `MOVED_TO` block (`# ── 1e''.`), after its last `expect_le`, add:
  ```bash
  expect_eq "MOVED_TO: no status file is ever written" "$(field "$OUT" status_file)" ""
  ```
  (e) In the compose half, after `expect_contains "config: ...read-only" "$TS_BLOCK" "read_only: true"`:
  ```bash
  expect_contains "config: the status volume in the sidecar" "$TS_BLOCK" "source: v4_status"
  expect_contains "config: ...at /run/nova-status" "$TS_BLOCK" "target: /run/nova-status"
  CORE_BLOCK="$(printf '%s\n' "$CFG" | awk '/^  core:/{f=1; print; next} f && /^  [a-z]/{f=0} f')"
  STATUS_MOUNT="$(printf '%s\n' "$CORE_BLOCK" | grep -A3 'source: v4_status')"
  expect_contains "config: core mounts the status volume" "$STATUS_MOUNT" "target: /run/nova-status"
  expect_contains "config: ...read-only" "$STATUS_MOUNT" "read_only: true"
  ```
  and replace `expect_eq "create: exactly two mounts" … 2` with:
  ```bash
  expect_contains "create: the status volume is mounted rw at /run/nova-status" "$MOUNTS" "volume ${PROJECT}_v4_status "
  expect_contains "create: ...writable" "$MOUNTS" " /run/nova-status rw=true"
  expect_eq "create: exactly three mounts" "$(printf '%s\n' "$MOUNTS" | grep -c .)" 3
  ```
  The status volume in core is written as a long-form mount (Step 4) precisely so
  `read_only: true` appears on its own line in `compose config`.

- [ ] **Step 2: Run them to see them fail.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/qr && bash deploy/tailscale/start_test.sh 2>&1 | grep -E '^FAIL|passed'
  ```
  Expected: FAIL on every `status:` line, the two `config:` status lines, and the mount
  count; everything else still `ok`.

- [ ] **Step 3: Write the loop.** In `start.sh`, insert before `# ---- 5. containerboot's exit is ours`:
  ```sh
  # ---- 4b. publish what the tailnet says, for core (D17, S47) -------------------
  #
  # Nova's address for another device is known only to tailscaled, in this
  # container. Every STATUS_INTERVAL seconds this writes one small JSON file on
  # the v4_status volume, which core mounts read-only and reads through
  # services/core/app/network.py — the only way core learns the address a QR
  # code must encode. Every field is read from tailscaled on THAT tick, never
  # carried over, and core refuses a file older than 45 s: a sidecar that stops
  # writing reads as "no address" within a minute, never as a stale address.
  #
  # Atomic: a temp file in the same directory, then mv, so core never reads half
  # a file. A failed write is logged and retried; it never takes the sidecar
  # down — the tailnet URL answering matters more than core being told about it.
  #
  # Only on the success path: step 0 (MOVED_TO) and every failure above have
  # already exited, so a parked host never writes, and the stale file it keeps
  # is rejected by core's 45 s rule.
  STATUS_DIR="${NOVA_STATUS_DIR:-/run/nova-status}"
  STATUS_INTERVAL="${NOVA_STATUS_INTERVAL:-15}"

  write_status() {
    mkdir -p "$STATUS_DIR" 2>/dev/null
    st="$(tailscale status --json 2>/dev/null)"
    ts_state="$(printf '%s\n' "$st" | json_string BackendState | tr -d '"\\')"
    ts_name="$(printf '%s\n' "$st" | json_string DNSName | sed 's/\.$//' | tr -d '"\\')"
    if serve_mapping_present; then ts_serve=true; else ts_serve=false; fi
    ts_certs="$(printf '%s\n' "$st" | tr -d ' \n\t\r' | grep -o '"CertDomains":\[[^]]*\]')"
    ts_cert=false
    if [ -n "$ts_name" ]; then
      case "$ts_certs" in *"\"$ts_name\""*) ts_cert=true ;; esac
    fi
    printf '{"version": 1, "backend_state": "%s", "dns_name": "%s", "serve_ok": %s, "https_cert": %s, "written_at": "%s"}\n' \
      "$ts_state" "$ts_name" "$ts_serve" "$ts_cert" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > "$STATUS_DIR/.tailscale.json.tmp" 2>/dev/null \
      && mv -f "$STATUS_DIR/.tailscale.json.tmp" "$STATUS_DIR/tailscale.json" 2>/dev/null
  }

  status_loop() {
    while :; do
      if ! write_status; then
        log "could not write $STATUS_DIR/tailscale.json — core reads no address until this succeeds; retrying in ${STATUS_INTERVAL}s"
      fi
      sleep "$STATUS_INTERVAL"
    done
  }

  status_loop &
  STATUS_PID=$!
  ```
  and replace the two lines of step 5 with:
  ```sh
  wait_for_containerboot
  rc=$?
  kill "$STATUS_PID" 2>/dev/null
  exit "$rc"
  ```

- [ ] **Step 4: The volume.** In `deploy/docker-compose.yml`:
  - under `tailscale:` → `volumes:`, after `- v4_tailscale:/var/lib/tailscale`, add:
    ```yaml
      # What tailscaled says, rewritten every 15 s by start.sh (section 4b) for
      # core's one reader, app/network.py (S47).
      - v4_status:/run/nova-status
    ```
  - under `core:` → `volumes:`, after `- v4_workspace:/data/workspace`, add:
    ```yaml
      # The tailnet's state as the sidecar last wrote it — how core learns the
      # address a QR code encodes (app/network.py, S47). Read-only: core never
      # writes it, and nothing in core may pretend to be the sidecar.
      - type: volume
        source: v4_status
        target: /run/nova-status
        read_only: true
    ```
  - in the top-level `volumes:` block, after `v4_tailscale`'s entry:
    ```yaml
      v4_status:
        x-nova-backup: exclude-derived
        x-nova-backup-reason: >-
          tailscale.json, rewritten by deploy/tailscale/start.sh every 15 s from
          tailscaled's own state; carried to another host it would describe the
          source's tailnet, not the target's.
    ```

- [ ] **Step 5: Run the sidecar tests to see them pass.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/qr && bash deploy/tailscale/start_test.sh 2>&1 | grep -E '^FAIL|passed'
  ```
  Expected: `N passed, 0 failed`.

- [ ] **Step 6: The backup tripwires.** Refresh the fixtures from this checkout (read-only
  against the live stack), then run every suite that reads the real compose file:
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/qr && bash deploy/backup/fixtures/refresh.sh
  cd deploy/backup && uv run pytest -q tests/test_policy.py tests/test_raw_compose.py tests/test_coverage_v4_real.py
  ```
  Expected: FAIL in `test_the_dispositions_cover_every_v4_volume_by_name` and
  `test_the_real_file_itself_is_read_whole` (the pinned set lacks `v4_status`). Update both
  lists — insert `"v4_status",` between `"v4_pgdata",` and `"v4_tailscale",` — and nothing
  else. If `test_coverage_v4_real.py` fails, read the refusal: a stale fixture means
  `refresh.sh` did not run from this checkout; a real refusal is a finding — stop and report
  it, do not edit the assertion to pass.

- [ ] **Step 7: The rest of the deploy suites.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/qr/deploy/backup && uv run pytest -q
  cd /home/jeremy/workspace/nova/.worktrees/qr && bash deploy/backup_test.sh 2>&1 | tail -3 && bash deploy/install_test.sh 2>&1 | tail -3
  ```
  Expected: all green. A failure that names `v4_status` is a pinned set: update it
  deliberately and say why in the commit. Any other failure: stop and report.

- [ ] **Step 8: Commit.**
  ```bash
  git -C /home/jeremy/workspace/nova/.worktrees/qr add deploy/tailscale/start.sh deploy/tailscale/start_test.sh deploy/docker-compose.yml deploy/backup/tests/test_policy.py deploy/backup/tests/test_raw_compose.py deploy/backup/fixtures
  git -C /home/jeremy/workspace/nova/.worktrees/qr commit -m "feat(s47): the tailnet sidecar publishes its state for core to read"
  git -C /home/jeremy/workspace/nova/.worktrees/qr show --stat HEAD
  ```

---

### Task 2: Core reads the address — `network.address()` and its API

**Files:**
- Create: `services/core/app/network.py`
- Create: `services/core/app/network_api.py`
- Modify: `services/core/app/main.py:126-145` (import and `include_router`)
- Test: `services/core/tests/test_network.py` (no database), `services/core/tests/test_network_api.py`

**Interfaces:**
- Consumes: the status file shape from Task 1.
- Produces:
  - `network.STATUS_FILE_ENV = "NOVA_STATUS_FILE"` (tests point it at a temp file)
  - `network.MAX_AGE_S = 45`
  - `@dataclass(frozen=True) class Address: origin: str | None; reason: str | None; read_at: datetime` with `as_json() -> {"address", "reason", "read_at"}`
  - `network.address(now: datetime | None = None) -> Address`
  - `GET /api/v1/network/address` → `Address.as_json()` (session or service bearer)

- [ ] **Step 1: Write the failing tests** — `services/core/tests/test_network.py`:
  ```python
  """S47 — core's one reader of the tailnet sidecar's status file (D17).

  Every QR code, her nova_address tool and the address guard read through
  network.address(), so each condition it refuses on is pinned here: a stated
  address is a claim about another device's reach, and a wrong one is a QR code
  that opens nothing."""

  from __future__ import annotations

  import json
  from datetime import UTC, datetime, timedelta

  import pytest

  from app import network

  NOW = datetime(2026, 9, 25, 14, 0, 0, tzinfo=UTC)
  GOOD = {
      "version": 1,
      "backend_state": "Running",
      "dns_name": "nova.fake-tailnet.ts.net",
      "serve_ok": True,
      "https_cert": True,
      "written_at": "2026-09-25T13:59:50Z",
  }


  @pytest.fixture
  def status(tmp_path, monkeypatch):
      path = tmp_path / "tailscale.json"
      monkeypatch.setenv(network.STATUS_FILE_ENV, str(path))

      def write(**over) -> None:
          path.write_text(json.dumps({**GOOD, **over}))

      write.path = path
      return write


  def test_every_fact_holding_states_the_https_origin(status):
      status()
      got = network.address(NOW)
      assert got.origin == "https://nova.fake-tailnet.ts.net"
      assert got.reason is None
      assert got.read_at == NOW


  def test_a_trailing_dot_and_capitals_are_normalised(status):
      status(dns_name="Nova.Fake-Tailnet.TS.net.")
      assert network.address(NOW).origin == "https://nova.fake-tailnet.ts.net"


  def test_no_file_means_this_nova_runs_without_its_tailnet(status):
      got = network.address(NOW)
      assert got.origin is None
      assert "has not written its status" in got.reason
      assert "NOVA_TAILNET=1 ./install" in got.reason


  def test_a_stale_file_is_no_address_never_the_old_one(status):
      status(written_at="2026-09-25T13:56:00Z")
      got = network.address(NOW)
      assert got.origin is None
      assert "4 minutes old" in got.reason and "stopped writing" in got.reason


  def test_exactly_at_the_limit_is_still_fresh(status):
      at = (NOW - timedelta(seconds=network.MAX_AGE_S)).strftime("%Y-%m-%dT%H:%M:%SZ")
      status(written_at=at)
      assert network.address(NOW).origin == "https://nova.fake-tailnet.ts.net"


  def test_a_file_dated_in_the_future_is_refused(status):
      status(written_at="2026-09-25T14:05:00Z")
      got = network.address(NOW)
      assert got.origin is None and "in the future" in got.reason


  @pytest.mark.parametrize(
      ("over", "says"),
      [
          ({"version": 2}, "version 2"),
          ({"written_at": "yesterday"}, "no readable written_at"),
          ({"backend_state": "NeedsLogin"}, "NeedsLogin, not Running"),
          ({"backend_state": ""}, "in no stated state"),
          ({"dns_name": ""}, "names no DNS name"),
          ({"dns_name": "localhost"}, "not a MagicDNS name"),
          ({"dns_name": "100.64.0.7"}, "not a MagicDNS name"),
          ({"dns_name": "nova.example.com"}, "not a MagicDNS name"),
          ({"serve_ok": False}, "the serve mapping is missing"),
          ({"https_cert": False}, "HTTPS certificates are not enabled"),
          ({"serve_ok": "true"}, "the serve mapping is missing"),
      ],
  )
  def test_each_failed_fact_is_the_stated_reason(status, over, says):
      status(**over)
      got = network.address(NOW)
      assert got.origin is None
      assert says in got.reason


  def test_the_first_failed_fact_wins(status):
      status(backend_state="Stopped", serve_ok=False, https_cert=False)
      assert "Stopped, not Running" in network.address(NOW).reason


  def test_unparseable_and_non_object_files_are_stated(status):
      status.path.write_text("{not json")
      assert "not valid JSON" in network.address(NOW).reason
      status.path.write_text("[1, 2]")
      assert "not a JSON object" in network.address(NOW).reason


  def test_as_json_is_the_api_shape(status):
      status()
      assert network.address(NOW).as_json() == {
          "address": "https://nova.fake-tailnet.ts.net",
          "reason": None,
          "read_at": NOW.isoformat(),
      }
  ```
  and `services/core/tests/test_network_api.py`:
  ```python
  """S47 — GET /api/v1/network/address, the Settings panels' one source."""

  from __future__ import annotations

  import json

  from app import network
  from tests.conftest import requires_db

  pytestmark = requires_db


  async def test_the_address_route_answers_with_the_reader(owner_client, tmp_path, monkeypatch):
      path = tmp_path / "tailscale.json"
      monkeypatch.setenv(network.STATUS_FILE_ENV, str(path))
      resp = await owner_client.get("/api/v1/network/address")
      assert resp.status_code == 200
      body = resp.json()
      assert body["address"] is None and "has not written its status" in body["reason"]
      assert set(body) == {"address", "reason", "read_at"}


  async def test_the_address_route_needs_a_session(client):
      resp = await client.get("/api/v1/network/address")
      assert resp.status_code == 401
  ```

- [ ] **Step 2: Run them to see them fail.**
  `uv run pytest -q tests/test_network.py tests/test_network_api.py`
  Expected: `ModuleNotFoundError: No module named 'app.network'` (collection error).

- [ ] **Step 3: Write `services/core/app/network.py`:**
  ```python
  """Nova's address for another device (S47; D17, pulled forward from S43a).

  The tailnet name is known only to tailscaled, inside the sidecar. Every 15 s
  deploy/tailscale/start.sh writes what tailscaled says to
  /run/nova-status/tailscale.json on the v4_status volume, which core mounts
  read-only. This module is core's ONE reader of that file: every QR code, her
  nova_address tool and the address guard read through address(), so what a
  page encodes and what she says cannot come from two readings.

  An origin is stated only when every fact holds on a file written in the last
  45 seconds. Anything else is None with the FIRST fact that failed, in the
  owner's words — a stale file is "no address", never the address it used to
  say. It never states loopback, an IP address or plain http: the web UI is
  never on the LAN (hub decision 10), and a QR code of 127.0.0.1 opens nothing
  on any other device.

  No cache: the file is a few hundred bytes and every caller wants now. S43a
  widens this to every access origin (Headscale, the LAN door); it extends this
  reader, it does not add a second one.
  """

  from __future__ import annotations

  import json
  import os
  import re
  from dataclasses import dataclass
  from datetime import UTC, datetime
  from pathlib import Path

  STATUS_FILE_ENV = "NOVA_STATUS_FILE"
  DEFAULT_STATUS_FILE = "/run/nova-status/tailscale.json"
  MAX_AGE_S = 45
  STATUS_VERSION = 1

  # A MagicDNS name: dot-separated DNS labels ending in .ts.net. An IP address or
  # "localhost" can never match, which is the loopback/IP refusal by construction.
  _TAILNET_NAME = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$")

  NO_FILE = (
      "the tailnet sidecar has not written its status — this Nova runs without its "
      "tailnet (`NOVA_TAILNET=1 ./install` turns it on)"
  )


  @dataclass(frozen=True)
  class Address:
      origin: str | None
      reason: str | None
      read_at: datetime

      def as_json(self) -> dict:
          return {"address": self.origin, "reason": self.reason, "read_at": self.read_at.isoformat()}


  def status_path() -> Path:
      return Path(os.environ.get(STATUS_FILE_ENV) or DEFAULT_STATUS_FILE)


  def _parse_time(value: object) -> datetime | None:
      if not isinstance(value, str):
          return None
      try:
          parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
      except ValueError:
          return None
      return parsed if parsed.tzinfo is not None else None


  def _age(seconds: float) -> str:
      if seconds < 120:
          return f"{int(seconds)} seconds"
      minutes = int(seconds // 60)
      if minutes < 120:
          return f"{minutes} minutes"
      return f"{int(minutes // 60)} hours"


  def address(now: datetime | None = None) -> Address:
      now = now or datetime.now(UTC)

      def none(reason: str) -> Address:
          return Address(None, reason, now)

      try:
          raw = status_path().read_text(encoding="utf-8")
      except FileNotFoundError:
          return none(NO_FILE)
      except OSError as exc:
          return none(f"the tailnet status could not be read ({exc.strerror or exc})")
      try:
          data = json.loads(raw)
      except json.JSONDecodeError:
          return none("the tailnet status file is not valid JSON")
      if not isinstance(data, dict):
          return none("the tailnet status file is not a JSON object")
      if data.get("version") != STATUS_VERSION:
          return none(
              f"the tailnet status file is version {data.get('version')!r}; this core "
              f"reads version {STATUS_VERSION}"
          )
      written = _parse_time(data.get("written_at"))
      if written is None:
          return none("the tailnet status file has no readable written_at")
      age = (now - written).total_seconds()
      if age > MAX_AGE_S:
          return none(f"the tailnet status is {_age(age)} old — the sidecar has stopped writing it")
      if age < -MAX_AGE_S:
          return none(
              f"the tailnet status is dated {_age(-age)} in the future — this host's clocks disagree"
          )
      state = data.get("backend_state")
      if state != "Running":
          said = state if isinstance(state, str) and state else "in no stated state"
          return none(f"the tailnet sidecar is {said}, not Running")
      name = data.get("dns_name")
      if not isinstance(name, str) or not name.strip():
          return none("the tailnet status names no DNS name")
      name = name.strip().rstrip(".").lower()
      if not _TAILNET_NAME.match(name):
          return none(f"the tailnet name {name!r} is not a MagicDNS name (*.ts.net)")
      if data.get("serve_ok") is not True:
          return none(
              "the tailnet does not serve Nova over HTTPS: the serve mapping is missing"
          )
      if data.get("https_cert") is not True:
          return none(
              "the tailnet does not serve Nova over HTTPS: HTTPS certificates are not "
              "enabled for this tailnet (admin console: DNS -> HTTPS Certificates)"
          )
      return Address(f"https://{name}", None, now)
  ```
  and `services/core/app/network_api.py`:
  ```python
  """/api/v1/network — Nova's address for another device (S47), as core's one
  reader states it. The Settings panels encode THIS, never window.location: the
  owner opening Nova on the hub at 127.0.0.1 must still get a QR code another
  device can open."""

  from __future__ import annotations

  from fastapi import APIRouter, Depends

  from app import identity, network
  from app.identity import Person

  router = APIRouter(prefix="/api/v1/network", tags=["network"])


  @router.get("/address")
  async def get_address(person: Person = Depends(identity.require_person)) -> dict:
      return network.address().as_json()
  ```
  In `services/core/app/main.py`, add `network_api,` to the alphabetical
  `from app import (…)` block (`app/main.py:16-43`), between `models_catalog,` and
  `notices_api,`, and `app.include_router(network_api.router)` after
  `app.include_router(machines_api.router)` (`:138`).

- [ ] **Step 4: Run them to see them pass.**
  `uv run pytest -q tests/test_network.py tests/test_network_api.py`
  Expected: all pass (the API tests skip only when `TEST_DATABASE_URL` is unset — it must
  be set; a skip is not a pass).

- [ ] **Step 5: Lint, format, commit.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/qr/services/core && uv run ruff check app tests && uv run ruff format app/network.py app/network_api.py app/main.py tests/test_network.py tests/test_network_api.py
  git -C /home/jeremy/workspace/nova/.worktrees/qr add services/core/app/network.py services/core/app/network_api.py services/core/app/main.py services/core/tests/test_network.py services/core/tests/test_network_api.py
  git -C /home/jeremy/workspace/nova/.worktrees/qr commit -m "feat(s47): core reads Nova's address for another device from the sidecar"
  git -C /home/jeremy/workspace/nova/.worktrees/qr show --stat HEAD
  ```

---

### Task 3: The card channel — a UI-only frame that never reaches her

**Files:**
- Modify: `services/core/app/tools/base.py` (a `card` field on `ToolContext`, after `step`)
- Modify: `services/core/app/tools/__init__.py` (`context_for(..., card=None)`)
- Modify: `services/core/app/chat.py` (`_card_channel`; `_run_turn(..., card=None)`; both
  `tools.context_for(` calls at `:4033-4052`; `_spawn_turn(..., *, card=None)` at `:5694`; the
  stream route's `_spawn_turn` call at `:5936`)
- Modify: `services/core/tests/test_no_approvals.py:79-94` (the field-set pin gains `card`)
- Test: `services/core/tests/test_chat_card.py` (new)

**Interfaces:**
- Produces:
  - `ToolContext.card: Callable[[dict], None] | None = None`
  - `tools.context_for(app, person, *, facts_sink=None, workspace_root=None, card=None) -> ToolContext`
  - `chat._card_channel(emit: Callable[[str | None], None]) -> Callable[[dict], None]` — each
    call emits one `data: {"card": <payload>}` frame
  - `chat._run_turn(app, pool, turn, person, conversation_id, message, history, model, max_tool_rounds, emit, *, ingest=True, persona=None, attached=(), card=None)`
  - `chat._spawn_turn(app, pool, conversation_id, started, emit, *, card=None)`

- [ ] **Step 1: Write the failing tests** — `services/core/tests/test_chat_card.py`:
  ```python
  """S47 — the card channel: a UI-only frame beside her reply.

  A card carries what she must never hold (a pairing code), so the channel's
  contract is mostly where the payload may NOT go: never into the model's next
  round, never onto a span, never into the stored reply. And it exists only
  where there is a chat to show it in — the stream route — never in a turn that
  streams to nobody (a drained queue, a schedule, an agent's own turn)."""

  from __future__ import annotations

  import json

  import pytest

  from app import chat, tools
  from app.tools.base import Tool
  from tests.conftest import requires_db
  from tests.fakes import FakeMemory, ScriptedGateway

  pytestmark = requires_db

  DONE = "[DONE]"
  # A marker that must appear in the card frame and NOWHERE else.
  SECRET = "CARD-SECRET-7Q4W"


  def frames(body: str) -> list:
      out = []
      for block in body.strip().split("\n\n"):
          assert block.startswith("data: "), block
          payload = block[len("data: ") :]
          out.append(payload if payload == DONE else json.loads(payload))
      return out


  def text(piece: str) -> dict:
      return {"choices": [{"delta": {"content": piece}}]}


  def whole_call(call_id: str, name: str, arguments: dict) -> dict:
      return {
          "choices": [
              {
                  "message": {
                      "role": "assistant",
                      "content": None,
                      "tool_calls": [
                          {
                              "id": call_id,
                              "type": "function",
                              "function": {"name": name, "arguments": json.dumps(arguments)},
                          }
                      ],
                  },
                  "finish_reason": "tool_calls",
              }
          ]
      }


  async def _card_tool(args: dict, ctx) -> str:
      if ctx.card is None:
          return "there is no chat to show a card in"
      ctx.card({"kind": "test_card", "secret": SECRET})
      return "sent a card to the chat"


  CARD_TOOL = Tool(
      name="test_card_tool",
      description="Sends a test card.",
      parameters={"type": "object", "properties": {}, "additionalProperties": False},
      executor=_card_tool,
  )


  @pytest.fixture
  def card_tool(monkeypatch):
      monkeypatch.setitem(tools.REGISTRY, CARD_TOOL.name, CARD_TOOL)
      return CARD_TOOL


  async def set_chat_model(client) -> None:
      resp = await client.put("/api/v1/settings", json={"key": "chat.model", "value": "qwen3:8b"})
      assert resp.status_code == 200, resp.text


  async def test_a_card_reaches_the_stream_and_nowhere_else(owner_client, pool, mount_peers, card_tool):
      gateway = ScriptedGateway(
          rounds=(
              (whole_call("call_1", "test_card_tool", {}),),
              (text("The card is in the chat."),),
          )
      )
      mount_peers(gateway=gateway, memory=FakeMemory())
      await set_chat_model(owner_client)
      resp = await owner_client.post("/api/v1/chat/stream", json={"message": "show me a card"})
      assert resp.status_code == 200, resp.text
      sent = frames(resp.text)

      cards = [f["card"] for f in sent if isinstance(f, dict) and "card" in f]
      assert cards == [{"kind": "test_card", "secret": SECRET}]
      # Every OTHER frame is free of it.
      others = [f for f in sent if not (isinstance(f, dict) and "card" in f)]
      assert SECRET not in json.dumps(others)
      # The model's next round was told only the tool's result.
      assert SECRET not in json.dumps(gateway.payloads)
      # Not on any span, not in any stored message.
      spans = await pool.fetch("SELECT meta::text AS meta FROM turn_spans")
      assert all(SECRET not in row["meta"] for row in spans)
      stored = await pool.fetch("SELECT content FROM messages")
      assert all(SECRET not in row["content"] for row in stored)


  async def test_a_context_built_without_a_channel_has_none(card_tool):
      """Every caller but the stream route builds its context this way."""
      import uuid

      from app.identity import Person

      person = Person(id=uuid.uuid4(), name="jeremy", role="owner")
      ctx = tools.context_for(None, person, facts_sink=[])
      assert ctx.card is None
      said = await tools.REGISTRY["test_card_tool"].executor({}, ctx)
      assert said == "there is no chat to show a card in"


  def test_the_card_channel_emits_one_card_frame():
      seen: list = []
      send = chat._card_channel(seen.append)
      send({"kind": "setup_qr", "setup": "install_pwa"})
      assert seen == ['data: {"card": {"kind": "setup_qr", "setup": "install_pwa"}}\n\n']


  def test_only_the_stream_route_hands_a_turn_a_card_channel():
      """The scheduler, the queue drain and an agent's turn stream to nobody:
      a card sent there would mint a code for no one and call it sent."""
      import inspect

      source = inspect.getsource(chat)
      assert source.count("card=_card_channel(") == 1
      assert "card=_card_channel(queue.put_nowait)" in source
  ```
  Also extend the field-set pin in `tests/test_no_approvals.py` (it is the tripwire the
  spec §12 names): add `"card",` to the set at `:87-94`, and append to the comment above it:
  ```python
      # `card` (S47) is an OUTPUT channel too: a UI-only frame beside her reply
      # (a setup QR card) that never enters her context, a span or a message.
      # Bound only where there is a chat to show it in; nothing reads it to
      # decide anything.
  ```

- [ ] **Step 2: Run them to see them fail.**
  `uv run pytest -q tests/test_chat_card.py tests/test_no_approvals.py`
  Expected: `AttributeError: ... has no attribute '_card_channel'`, `TypeError` on
  `context_for(..., card=...)` absent / `ctx.card` missing, and the field-set assert failing.

- [ ] **Step 3: Implement.**
  - `app/tools/base.py`, in `ToolContext` after the `step` field:
    ```python
        # The OUTPUT channel for a UI-only CARD (S47): a structured payload the
        # chat renders beside her reply — a setup QR card — that never enters her
        # context, the trace or the messages table. A pairing code travels ONLY
        # here. Bound only where there is a chat to show it in (the stream
        # route; the eval runner's recorder) and None everywhere else, so a tool
        # that needs one states that it cannot. Not a principal either: it is
        # where output goes, and nothing reads it to decide.
        card: Callable[[dict], None] | None = None
    ```
  - `app/tools/__init__.py`, `context_for`: add the keyword `card: Callable[[dict], None] | None = None`
    after `workspace_root`, pass `card=card` into `ToolContext(...)`, and add one sentence to
    its docstring: "`card` is the UI-only card channel (S47): the stream route binds it, and
    every other caller leaves it None." Import `Callable` from `collections.abc` beside
    `Iterable`.
  - `app/chat.py`:
    - beside `_frame` (`:536`), add:
      ```python
      def _card_channel(emit: Callable[[str | None], None]) -> Callable[[dict], None]:
          """A turn's card channel (S47): each payload becomes one `card` frame on
          the live stream, and goes nowhere else — not into `messages`, not onto a
          span. See ToolContext.card for why only the stream route binds one."""

          def send(payload: dict) -> None:
              emit(_frame({"card": payload}))

          return send
      ```
    - `_run_turn`: add `card: Callable[[dict], None] | None = None,` as the LAST keyword-only
      parameter (after `attached`), a docstring sentence ("`card` is the UI-only card channel
      (S47); only the stream route and the eval runner pass one"), and `card=card` to BOTH
      `tools.context_for(...)` calls (`:4033` and `:4044`).
    - `_spawn_turn`: add `*, card: Callable[[dict], None] | None = None` after `emit`, and pass
      `card=card` in its `_run_turn(...)` call.
    - `chat_stream` (`:5936`): `_spawn_turn(request.app, pool, conversation_id, started, queue.put_nowait, card=_card_channel(queue.put_nowait))`.
    - Do NOT touch `drain_queue`'s `_spawn_turn(..., _discard_frame)`, the scheduler or agents:
      they must keep passing no `card` (`tests/test_scheduler.py:375,498` pin their keywords).

- [ ] **Step 4: Run them to see them pass, then the neighbours that pin these seams.**
  ```bash
  uv run pytest -q tests/test_chat_card.py tests/test_no_approvals.py tests/test_scheduler.py tests/test_chat_agents.py tests/test_chat_tools.py tests/test_tools_registry.py
  ```
  Expected: all pass. `test_no_approvals`' await pins (`_run_tool` → `tools.dispatch`,
  `_dispatch_calls` → `_run_tool`) must still hold — `card` is bound synchronously.

- [ ] **Step 5: Lint, format, commit.**
  ```bash
  uv run ruff check app tests && uv run ruff format app/tools/base.py app/tools/__init__.py tests/test_chat_card.py tests/test_no_approvals.py
  git -C /home/jeremy/workspace/nova/.worktrees/qr add services/core/app/tools/base.py services/core/app/tools/__init__.py services/core/app/chat.py services/core/tests/test_chat_card.py services/core/tests/test_no_approvals.py
  git -C /home/jeremy/workspace/nova/.worktrees/qr commit -m "feat(s47): a card channel beside her reply that never enters her context"
  git -C /home/jeremy/workspace/nova/.worktrees/qr show --stat HEAD
  ```
  (`chat.py` is not format-clean as a whole: do not `ruff format` it — `ruff check` only.)

---

### Task 4: Her tools — `nova_address` and `show_setup_qr`, and cards that survive a reload

**Files:**
- Create: `services/core/app/native_app.py`, `apps/web/src/lib/nativeApp.ts`
- Create: `services/core/app/tools/setup.py`
- Modify: `services/core/app/tools/__init__.py` (import `setup`; `*setup.TOOLS` in `REGISTRY`)
- Modify: `services/core/app/live_facts.py:82-120` (`"nova_address"` in `AUTO_RUN`)
- Modify: `services/core/app/conversations.py:307-400` (`messages_json` gains `cards`)
- Modify (pins): `tests/test_tools_registry.py:72-198` and `:514-563`,
  `tests/test_conversations.py:302-325` (`MESSAGE_KEYS`), `tests/test_timers_api.py:569-590`
- Test: `services/core/tests/test_native_app.py`, `tests/test_tools_setup.py`,
  `tests/test_chat_setup_card.py` (DB, the real route), `tests/test_live_facts.py` (+1),
  `tests/test_conversations.py` (+1)

**Interfaces:**
- Consumes: `network.address()` (Task 2); `ToolContext.card`, `context_for(card=…)` (Task 3);
  `devices.mint_pairing_code(pool, created_by=uuid) -> {"code", "expires_at"}`,
  `devices.normalize_code`, `devices.PAIRING_CODE_TTL_SECONDS` (existing).
- Produces:
  - `native_app.STORE_LINKS: dict[str, str | None]` (`{"ios": None, "android": None}`),
    `native_app.stated() -> str`, `native_app.is_store_link(url: str) -> bool`
  - `NATIVE_APP_LINKS: { ios: string | null; android: string | null }` (web, both `null`)
  - `setup.SETUPS = ("install_pwa", "get_app", "add_machine", "add_model_server")`,
    `setup.MACHINE_SETUPS`, `setup.PAIRING: ContextVar[Callable[[Person], Awaitable[dict]]]`
  - The card payload (live): `{"kind": "setup_qr", "setup", "address", "url", "code"?, "expires_at"?}`
    — `code` is dashed (`ABCD-2345`), and `url` for a machine setup is `<address>/add#<code>`.
  - The span fact / reloaded card: `{"setup", "address", "url" (never a code), "expires_at", "code_shown"}`;
    `messages_json` rows gain `"cards": [{"kind": "setup_qr", "setup", "address", "url", "code_shown", "expires_at"?}]`.

- [ ] **Step 1: The store links, both sides, and their pin.** `services/core/tests/test_native_app.py`:
  ```python
  """S47 — whether a native Nova app exists is ONE fact stated in two places:
  core (what she says) and the /app page (where a phone is sent). This pins
  them equal, so the day an app ships both change together."""

  from __future__ import annotations

  import re
  from pathlib import Path

  from app import native_app

  WEB = Path(__file__).resolve().parents[3] / "apps" / "web" / "src" / "lib" / "nativeApp.ts"


  def _web_links() -> dict[str, str | None]:
      source = WEB.read_text(encoding="utf-8")
      out: dict[str, str | None] = {}
      for platform in ("ios", "android"):
          found = re.search(rf"\b{platform}:\s*(null|'([^']*)')", source)
          assert found, f"{platform} is not stated in {WEB}"
          out[platform] = None if found.group(1) == "null" else found.group(2)
      return out


  def test_core_and_the_app_page_agree_on_the_store_links():
      assert native_app.STORE_LINKS == _web_links()


  def test_with_no_links_she_says_there_is_no_app():
      assert native_app.STORE_LINKS == {"ios": None, "android": None}
      assert native_app.stated() == "There is no native Nova app yet."
      assert native_app.is_store_link("https://apps.apple.com/app/id1") is False
  ```
  Then create `services/core/app/native_app.py`:
  ```python
  """Where the Nova app lives in each store (S47). Both None: there is no Nova
  app yet. The day one ships, its listing goes here AND in
  apps/web/src/lib/nativeApp.ts — tests/test_native_app.py pins the two equal,
  so her words and the /app page cannot disagree about whether an app exists."""

  from __future__ import annotations

  STORE_LINKS: dict[str, str | None] = {"ios": None, "android": None}

  _NAMES = {"ios": "iPhone", "android": "Android"}


  def stated() -> str:
      listed = [f"{_NAMES[os_name]}: {link}" for os_name, link in STORE_LINKS.items() if link]
      if not listed:
          return "There is no native Nova app yet."
      return "The Nova app — " + "; ".join(listed) + "."


  def is_store_link(url: str) -> bool:
      return url in {link for link in STORE_LINKS.values() if link}
  ```
  and `apps/web/src/lib/nativeApp.ts`:
  ```ts
  /**
   * Where the Nova app lives in each store (S47). Both null: there is no Nova
   * app yet. The day one ships, its listing goes here AND in
   * services/core/app/native_app.py — services/core/tests/test_native_app.py
   * pins the two equal, so the /app page and her words cannot disagree about
   * whether an app exists.
   */
  export const NATIVE_APP_LINKS: { ios: string | null; android: string | null } = {
    ios: null,
    android: null,
  }
  ```
  Run: `uv run pytest -q tests/test_native_app.py` — Expected: PASS (it was written against the
  files it creates; run it once before creating them to see the `FileNotFoundError`).

- [ ] **Step 2: Write the failing tool tests** — `services/core/tests/test_tools_setup.py` (no
  database: the mint goes through the `PAIRING` seam):
  ```python
  """S47 — her setup tools, called directly. The machine setups' pairing code is
  the whole risk: it may reach the card and NOTHING else, and a setup that
  cannot be shown sends nothing at all."""

  from __future__ import annotations

  import json
  import uuid
  from datetime import UTC, datetime

  import pytest

  from app import tools
  from app.identity import Person
  from app.main import app as core_app
  from app.tools import setup
  from app.tools.base import ToolFailure

  CODE = "ABCD2345"
  EXPIRES = "2026-09-25T14:10:00+00:00"


  def _owner() -> Person:
      return Person(id=uuid.uuid4(), name="jeremy", role="owner")


  @pytest.fixture
  def status(tmp_path, monkeypatch):
      path = tmp_path / "tailscale.json"
      monkeypatch.setenv("NOVA_STATUS_FILE", str(path))

      def write(**over) -> None:
          now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
          path.write_text(
              json.dumps(
                  {
                      "version": 1,
                      "backend_state": "Running",
                      "dns_name": "nova.fake-tailnet.ts.net",
                      "serve_ok": True,
                      "https_cert": True,
                      "written_at": now,
                      **over,
                  }
              )
          )

      return write


  @pytest.fixture
  def minted():
      calls: list = []

      async def fake(person) -> dict:
          calls.append(person)
          return {"code": CODE, "expires_at": EXPIRES}

      token = setup.PAIRING.set(fake)
      yield calls
      setup.PAIRING.reset(token)


  async def _call(name, args, *, cards=None, sink=None):
      ctx = tools.context_for(
          core_app, _owner(), facts_sink=sink, card=None if cards is None else cards.append
      )
      return await tools.REGISTRY[name].executor(args, ctx)


  async def test_nova_address_states_the_address_and_what_a_device_needs(status):
      status()
      sink: list = []
      said = await _call("nova_address", {}, sink=sink)
      assert "https://nova.fake-tailnet.ts.net" in said
      assert "Tailscale" in said and "/install" in said
      assert "There is no native Nova app yet." in said
      assert sink[0]["nova_address"] == "https://nova.fake-tailnet.ts.net"
      assert sink[0]["checked_now"] is True


  async def test_nova_address_without_one_says_why(monkeypatch, tmp_path):
      monkeypatch.setenv("NOVA_STATUS_FILE", str(tmp_path / "absent.json"))
      sink: list = []
      said = await _call("nova_address", {}, sink=sink)
      assert said.startswith("Nova has no address another device can reach:")
      assert sink[0]["nova_address"] is None


  @pytest.mark.parametrize(("setup_name", "page"), [("install_pwa", "/install"), ("get_app", "/app")])
  async def test_a_phone_setup_sends_one_card_and_mints_nothing(status, minted, setup_name, page):
      status()
      cards: list = []
      sink: list = []
      said = await _call("show_setup_qr", {"setup": setup_name}, cards=cards, sink=sink)
      assert cards == [
          {
              "kind": "setup_qr",
              "setup": setup_name,
              "address": "https://nova.fake-tailnet.ts.net",
              "url": f"https://nova.fake-tailnet.ts.net{page}",
          }
      ]
      assert minted == []
      assert said.startswith("Sent a QR card to the chat.")
      assert sink == [
          {
              "setup": setup_name,
              "address": "https://nova.fake-tailnet.ts.net",
              "url": f"https://nova.fake-tailnet.ts.net{page}",
              "expires_at": None,
              "code_shown": False,
          }
      ]


  @pytest.mark.parametrize("setup_name", ["add_machine", "add_model_server"])
  async def test_a_machine_setup_puts_the_code_on_the_card_and_nowhere_else(status, minted, setup_name):
      status()
      cards: list = []
      sink: list = []
      said = await _call("show_setup_qr", {"setup": setup_name}, cards=cards, sink=sink)
      assert len(minted) == 1
      assert cards == [
          {
              "kind": "setup_qr",
              "setup": setup_name,
              "address": "https://nova.fake-tailnet.ts.net",
              "url": "https://nova.fake-tailnet.ts.net/add#ABCD-2345",
              "code": "ABCD-2345",
              "expires_at": EXPIRES,
          }
      ]
      # The code is on the card and nowhere she or the trace can read.
      for shape in (CODE, "ABCD-2345"):
          assert shape not in said
          assert shape not in json.dumps(sink)
      assert sink[0]["url"] == "https://nova.fake-tailnet.ts.net/add"
      assert sink[0]["code_shown"] is True
      assert "You do not have the code" in said
      if setup_name == "add_model_server":
          assert "models role (S44), which is not built" in said


  async def test_no_address_is_a_stated_cannot_and_nothing_is_minted_or_sent(monkeypatch, tmp_path, minted):
      monkeypatch.setenv("NOVA_STATUS_FILE", str(tmp_path / "absent.json"))
      cards: list = []
      with pytest.raises(ToolFailure, match="cannot show a setup QR: Nova has no address"):
          await _call("show_setup_qr", {"setup": "add_machine"}, cards=cards)
      assert cards == [] and minted == []


  async def test_no_chat_is_a_stated_cannot_and_nothing_is_minted(status, minted):
      status()
      with pytest.raises(ToolFailure, match="this turn has no chat to show it in"):
          await _call("show_setup_qr", {"setup": "add_machine"}, cards=None)
      assert minted == []


  async def test_a_failed_mint_sends_no_card(status):
      """Review Focus 3: the address was fine, the database was not."""
      status()

      async def broken(person) -> dict:
          raise ConnectionError("database is down")

      token = setup.PAIRING.set(broken)
      try:
          cards: list = []
          with pytest.raises(ToolFailure, match="the pairing code could not be made"):
              await _call("show_setup_qr", {"setup": "add_machine"}, cards=cards)
          assert cards == []
      finally:
          setup.PAIRING.reset(token)


  async def test_an_unknown_setup_is_refused_by_name(status, minted):
      status()
      with pytest.raises(ToolFailure, match="setup must be one of"):
          await _call("show_setup_qr", {"setup": "fax_machine"}, cards=[])
  ```
  and the real route, end to end — `services/core/tests/test_chat_setup_card.py`:
  ```python
  """S47 — a machine card through the real route, with a real mint: the code
  reaches the card frame and the pairing_codes table (as its hash), and nothing
  else — not the model's next round, not a span, not a message, not a reload."""

  from __future__ import annotations

  import json
  import re
  from datetime import UTC, datetime

  from app import devices
  from tests.conftest import requires_db
  from tests.fakes import FakeMemory, ScriptedGateway
  from tests.test_chat_card import frames, set_chat_model, text, whole_call

  pytestmark = requires_db

  CODE_SHAPE = re.compile(r"^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$")


  async def test_a_real_code_reaches_the_card_and_its_hash_and_nothing_else(
      owner_client, pool, mount_peers, tmp_path, monkeypatch
  ):
      status = tmp_path / "tailscale.json"
      status.write_text(
          json.dumps(
              {
                  "version": 1,
                  "backend_state": "Running",
                  "dns_name": "nova.fake-tailnet.ts.net",
                  "serve_ok": True,
                  "https_cert": True,
                  "written_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
              }
          )
      )
      monkeypatch.setenv("NOVA_STATUS_FILE", str(status))
      gateway = ScriptedGateway(
          rounds=(
              (whole_call("call_1", "show_setup_qr", {"setup": "add_machine"}),),
              (text("Scan the card with your phone, or open its link on the laptop."),),
          )
      )
      mount_peers(gateway=gateway, memory=FakeMemory())
      await set_chat_model(owner_client)
      resp = await owner_client.post("/api/v1/chat/stream", json={"message": "add my laptop"})
      assert resp.status_code == 200, resp.text
      sent = frames(resp.text)

      cards = [f["card"] for f in sent if isinstance(f, dict) and "card" in f]
      assert len(cards) == 1
      code = cards[0]["code"]
      assert CODE_SHAPE.match(code)
      assert cards[0]["url"] == f"https://nova.fake-tailnet.ts.net/add#{code}"
      # The database holds its hash, never the code.
      assert await pool.fetchval(
          "SELECT count(*) FROM pairing_codes WHERE code_hash = $1", devices.hash_code(code)
      ) == 1
      bare = code.replace("-", "")
      everywhere_else = [
          json.dumps([f for f in sent if not (isinstance(f, dict) and "card" in f)]),
          json.dumps(gateway.payloads),
          *[row["m"] for row in await pool.fetch("SELECT meta::text AS m FROM turn_spans")],
          *[row["c"] for row in await pool.fetch("SELECT content AS c FROM messages")],
          *[row["h"] for row in await pool.fetch("SELECT code_hash AS h FROM pairing_codes")],
      ]
      for blob in everywhere_else:
          assert code not in blob and bare not in blob

      # The reload redraws the card without the code (Review Focus 4).
      conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
      rows = (await owner_client.get(f"/api/v1/conversations/{conversation}/messages")).json()["messages"]
      nova = [row for row in rows if row["role"] == "assistant"][-1]
      assert nova["cards"] == [
          {
              "kind": "setup_qr",
              "setup": "add_machine",
              "address": "https://nova.fake-tailnet.ts.net",
              "url": "https://nova.fake-tailnet.ts.net/add",
              "code_shown": True,
              "expires_at": cards[0]["expires_at"],
          }
      ]
      assert code not in json.dumps(rows) and bare not in json.dumps(rows)
  ```
  Add to `tests/test_live_facts.py`, after `test_a_tool_that_changes_something_is_refused_by_name`:
  ```python
  def test_showing_a_setup_card_is_never_run_unasked():
      """S47: it mints a pairing code and sends a card — it changes something."""
      refusal = live_facts.runnable(_call("show_setup_qr", {"setup": "add_machine"}))
      assert refusal and "changes something" in refusal
  ```

- [ ] **Step 3: Run them to see them fail.**
  `uv run pytest -q tests/test_tools_setup.py tests/test_chat_setup_card.py tests/test_live_facts.py`
  Expected: `ImportError: cannot import name 'setup' from 'app.tools'`.

- [ ] **Step 4: Write `services/core/app/tools/setup.py`:**
  ```python
  """Her setup QR codes (S47): Nova's address for another device, and a card that
  puts a QR code for one of four setups in the chat.

  nova_address READS: the address core's one reader states now (app/network.py),
  what another device needs first, and whether a native app exists. It changes
  nothing and takes no argument, which is why the backend may run it unasked
  (live_facts.AUTO_RUN).

  show_setup_qr SENDS a card (ToolContext.card) — a QR code, its link and the
  steps — for putting Nova on a phone, getting the app, pairing a machine she
  controls, or pairing a model server. For the two machine setups it mints a
  pairing code, and the code goes to the card ONLY: never into her result, the
  span, the messages table or a log (spec s47 §7). Her result names the expiry and
  says plainly that she does not have the code.

  Neither is an approval of anything (owner ruling 2026-09-03). A setup that
  cannot be shown — no address another device can reach, no chat to show it in,
  a mint that failed — says it cannot and why, and sends nothing.

  Imports stay off app.chat and app.agents: a cold `import app.tools` must not
  load them (tests/test_tools_agents.py).
  """

  from __future__ import annotations

  from collections.abc import Awaitable, Callable
  from contextvars import ContextVar
  from datetime import UTC, datetime

  from app import db, devices, native_app, network
  from app.tools.base import Tool, ToolContext, ToolFailure

  SETUPS = ("install_pwa", "get_app", "add_machine", "add_model_server")
  MACHINE_SETUPS = frozenset({"add_machine", "add_model_server"})
  _PAGE = {
      "install_pwa": "/install",
      "get_app": "/app",
      "add_machine": "/add",
      "add_model_server": "/add",
  }

  TAILSCALE_STEP = (
      "The other device needs Tailscale (https://tailscale.com/download), signed in to the "
      "same tailnet as Nova."
  )
  MODEL_SERVER_NOTE = (
      "Serving its models needs the models role (S44), which is not built: today it pairs as a "
      "machine Nova controls."
  )

  Mint = Callable[[object], Awaitable[dict]]


  async def _mint_for(person) -> dict:
      """The real mint: one single-use code for this person, stored as its hash."""
      pool = await db.get_pool()
      return await devices.mint_pairing_code(pool, created_by=person.id)


  # The seam an eval replay swaps (machines.PLANT's pattern): a turn inside a case
  # must never mint a code that could enroll a real machine.
  PAIRING: ContextVar[Mint] = ContextVar("setup_pairing", default=_mint_for)


  def _dashed(code: str) -> str:
      clean = devices.normalize_code(code)
      return f"{clean[:4]}-{clean[4:]}" if len(clean) == 8 else clean


  def _clock(iso: str) -> str:
      try:
          return datetime.fromisoformat(iso).astimezone(UTC).strftime("%H:%M UTC")
      except ValueError:
          return iso


  async def nova_address(args: dict, ctx: ToolContext) -> str:
      got = network.address()
      if ctx.facts_sink is not None:
          ctx.facts_sink.append(
              {"nova_address": got.origin, "checked_now": True, "at": got.read_at.isoformat()}
          )
      if got.origin is None:
          return f"Nova has no address another device can reach: {got.reason}. {native_app.stated()}"
      return (
          f"Nova's address for another device: {got.origin} (read from the tailnet just now). "
          f"{TAILSCALE_STEP} {got.origin}/install shows each phone its own install steps. "
          f"{native_app.stated()}"
      )


  def _result(setup: str, link: str, expires_at: str | None) -> str:
      if setup == "install_pwa":
          return (
              f"Sent a QR card to the chat. It opens {link}, which shows the phone its own steps "
              f"for adding Nova to its home screen. {TAILSCALE_STEP}"
          )
      if setup == "get_app":
          return (
              f"Sent a QR card to the chat. It opens {link}, which sends an iPhone to the App "
              f"Store and an Android phone to Google Play once a Nova app exists. "
              f"{native_app.stated()} Until there is one, that page shows the web app's install "
              f"steps instead. {TAILSCALE_STEP}"
          )
      minutes = devices.PAIRING_CODE_TTL_SECONDS // 60
      said = (
          f"Sent a pairing card to the chat: a QR code, a short link ({link}) and a one-time "
          f"code that expires in {minutes} minutes, at {_clock(expires_at or '')}. The machine "
          f"needs Nova's agent, novad (Linux today); the card shows the command to run on it. "
          f"You do not have the code — it is only on the card."
      )
      return f"{said} {MODEL_SERVER_NOTE}" if setup == "add_model_server" else said


  async def show_setup_qr(args: dict, ctx: ToolContext) -> str:
      setup = str(args.get("setup") or "")
      if setup not in SETUPS:
          raise ToolFailure(f"setup must be one of {', '.join(SETUPS)}")
      got = network.address()
      if got.origin is None:
          raise ToolFailure(
              f"cannot show a setup QR: Nova has no address another device can reach — {got.reason}"
          )
      if ctx.card is None:
          raise ToolFailure("cannot show a setup QR: this turn has no chat to show it in")
      link = f"{got.origin}{_PAGE[setup]}"
      card: dict = {"kind": "setup_qr", "setup": setup, "address": got.origin, "url": link}
      expires_at: str | None = None
      if setup in MACHINE_SETUPS:
          try:
              minted = await PAIRING.get()(ctx.person)
          except Exception as exc:
              # The type only: whatever the failure said stays in the log.
              raise ToolFailure(
                  f"cannot show a pairing card: the pairing code could not be made "
                  f"({type(exc).__name__})"
              ) from exc
          code = _dashed(minted["code"])
          expires_at = minted["expires_at"]
          card.update(url=f"{link}#{code}", code=code, expires_at=expires_at)
      ctx.card(card)
      if ctx.facts_sink is not None:
          ctx.facts_sink.append(
              {
                  "setup": setup,
                  "address": got.origin,
                  "url": link,
                  "expires_at": expires_at,
                  "code_shown": setup in MACHINE_SETUPS,
              }
          )
      return _result(setup, link, expires_at)


  NOVA_ADDRESS = Tool(
      name="nova_address",
      description=(
          "Nova's address for another device (a phone, a tablet, another computer), read from "
          "the tailnet now, or why there is none; what that device needs first; and whether a "
          "native Nova app exists. Use it before giving anyone an address for Nova. Reads only."
      ),
      parameters={"type": "object", "properties": {}, "additionalProperties": False},
      executor=nova_address,
      # A reading of this moment: an address recalled from last week is exactly
      # the stale present `ephemeral` exists to stop.
      ephemeral=True,
      reads_only=True,
  )

  SHOW_SETUP_QR = Tool(
      name="show_setup_qr",
      description=(
          "Send a QR code card to the chat for one setup: install_pwa (put Nova on a phone's "
          "home screen), get_app (send a phone to its app store), add_machine (pair a computer "
          "Nova controls), add_model_server (pair a machine whose models Nova will use). The "
          "card shows the QR code, its link and the steps; the machine setups also show a "
          "one-time pairing code that you never see. Say only what the result says was sent."
      ),
      parameters={
          "type": "object",
          "properties": {
              "setup": {
                  "type": "string",
                  "enum": list(SETUPS),
                  "description": "Which setup the QR code is for.",
              },
          },
          "required": ["setup"],
          "additionalProperties": False,
      },
      executor=show_setup_qr,
  )

  TOOLS: tuple[Tool, ...] = (NOVA_ADDRESS, SHOW_SETUP_QR)
  ```
  Register it: in `app/tools/__init__.py` add `setup,` to the alphabetical `from app.tools import (…)`
  block (between `schema,` and `skills,`) and, after `*notices.TOOLS,` in `REGISTRY`:
  ```python
          # S47: Nova's address for another device, and the setup QR cards
          # (tools/setup.py). A card is UI-only; a pairing code never reaches her.
          *setup.TOOLS,
  ```
  In `app/live_facts.py`, add to `AUTO_RUN` after `"notices",`:
  ```python
          # S47. The address another device can open is answered by the tailnet
          # sidecar's status file, read now — never by a note saying "Nova is at
          # https://…". No arguments, a local file, nothing reached off this host.
          "nova_address",
  ```
  (`show_setup_qr` goes in neither `AUTO_RUN` nor `NOT_AUTO_RUN`: it is not `reads_only`, so
  `may_run_unasked` already refuses it as "changes something".)

- [ ] **Step 5: Cards on reload.** In `app/conversations.py` `messages_json`:
  - add a module-level helper next to `_delegation_json`:
    ```python
    def _card_json(facts: object) -> dict | None:
        """One successful show_setup_qr span -> the card a reload redraws (S47).

        Built from the span's FACTS, which never carry a pairing code: a machine
        card comes back as "shown once", with its link and expiry and no code.
        A span with no readable fact redraws nothing rather than a guessed card."""
        fact = facts[0] if isinstance(facts, list) and facts and isinstance(facts[0], dict) else None
        if fact is None:
            return None
        setup, address, url = fact.get("setup"), fact.get("address"), fact.get("url")
        if not all(isinstance(v, str) and v for v in (setup, address, url)):
            return None
        card = {
            "kind": "setup_qr",
            "setup": setup,
            "address": address,
            "url": url,
            "code_shown": fact.get("code_shown") is True,
        }
        if isinstance(fact.get("expires_at"), str):
            card["expires_at"] = fact["expires_at"]
        return card
    ```
  - in the `SELECT`, after the `delegate_spans` subquery, add (note the `, ` joining it):
    ```python
        "  (SELECT COALESCE(jsonb_agg(s.meta->'facts' ORDER BY s.started_at, s.id), '[]'::jsonb) "
        "    FROM turn_spans s WHERE s.turn_id = m.turn_id AND s.kind = 'tool' AND s.name = $3 "
        "    AND s.meta->>'ok' = 'true') AS card_spans "
    ```
    and pass the tool name as `$3`: `setup_tools.SHOW_SETUP_QR.name`, imported function-locally
    beside `from app import agents, attachments` as `from app.tools import setup as setup_tools`.
  - in the row dict, after `"delegations": …`:
    ```python
                # S47: the setup QR cards her turn sent, redrawn from the span
                # facts — never carrying a code (see _card_json).
                "cards": [c for c in (_card_json(f) for f in row["card_spans"]) if c is not None],
    ```
  - docstring: one paragraph "`cards` (S47) is one entry per successful show_setup_qr span …".
  - pins: add `"cards",` with an `# S47 (2026-09-25): …` comment to `MESSAGE_KEYS`
    (`tests/test_conversations.py:302-325`) and to the exact set in
    `tests/test_timers_api.py:569-590`.
  - a direct test in `tests/test_conversations.py`, modelled on
    `test_delegations_derive_from_the_turns_delegate_spans` (`:436-542`, its helpers `_turn`,
    `_row` at `:337-357`): one assistant row whose turn has a successful `show_setup_qr` span
    with `meta={"ok": true, "args_redacted": {"setup": "add_machine"}, "facts": [{"setup":
    "add_machine", "address": "https://nova.fake-tailnet.ts.net", "url":
    "https://nova.fake-tailnet.ts.net/add", "expires_at": "2026-09-25T14:10:00+00:00",
    "code_shown": true}]}`, one FAILED `show_setup_qr` span (`"ok": false`, no facts), and one
    `nova_address` span. Assert `nova["cards"]` is exactly the one card (the failed span and the
    other tool redraw nothing) and every other row's `cards == []`.

- [ ] **Step 6: The registry pins.** In `tests/test_tools_registry.py`:
  - `test_the_registered_tools_are_exactly_this_set_by_name` (`:124`): add a paragraph above
    the set in the form of `:116-117` —
    `# Deliberate snapshot update (slice 47, 2026-09-25): nova_address and show_setup_qr (tools/setup.py), so FORTY-ONE -> FORTY-THREE: Nova's address for another device, and the setup QR cards whose pairing code never reaches her.`
    — and append `"nova_address",` and `"show_setup_qr",` after `"machine_configure",` under
    `# S47 (2026-09-25): … FORTY-ONE -> FORTY-THREE.`
  - `test_the_tools_that_change_nothing_are_pinned_by_name` (`:528`): add `"nova_address",`
    with `# S47: reading the tailnet status file changes nothing. Its twin, show_setup_qr, is deliberately NOT here — it mints a code and sends a card.`
  - `test_every_tool_that_writes_says_it_changes_something` (`:566-588`): add `"show_setup_qr",`.

- [ ] **Step 7: Run them to see them pass, then the suites these seams touch.**
  ```bash
  uv run pytest -q tests/test_native_app.py tests/test_tools_setup.py tests/test_chat_setup_card.py tests/test_live_facts.py tests/test_conversations.py tests/test_timers_api.py tests/test_tools_registry.py tests/test_tools_agents.py tests/test_chat_history_stamps.py tests/test_agents_api.py tests/test_no_approvals.py
  ```
  Expected: all pass.

- [ ] **Step 8: Lint, format, commit.**
  ```bash
  uv run ruff check app tests && uv run ruff format app/native_app.py app/tools/setup.py tests/test_native_app.py tests/test_tools_setup.py tests/test_chat_setup_card.py
  git -C /home/jeremy/workspace/nova/.worktrees/qr add services/core/app/native_app.py services/core/app/tools/setup.py services/core/app/tools/__init__.py services/core/app/live_facts.py services/core/app/conversations.py services/core/tests/test_native_app.py services/core/tests/test_tools_setup.py services/core/tests/test_chat_setup_card.py services/core/tests/test_live_facts.py services/core/tests/test_conversations.py services/core/tests/test_timers_api.py services/core/tests/test_tools_registry.py apps/web/src/lib/nativeApp.ts
  git -C /home/jeremy/workspace/nova/.worktrees/qr commit -m "feat(s47): her setup QR tools, with the pairing code on the card and nowhere else"
  git -C /home/jeremy/workspace/nova/.worktrees/qr show --stat HEAD
  ```

---

### Task 5: The guards — invented codes, wrong addresses, claimed cards

**Files:**
- Modify: `services/core/app/guards.py` — a new REWRITE section (`RewriteClaim`,
  `code_claim_check`, `address_claim_check`) after `delivery_claim_check` (`:5845-5884`);
  narration kind `showed_setup_qr` (`:58-79`, `:186-211`, `:1027-1035`); three rows at the end
  of `_CAPABILITY_TOOLS` (`:1460-1676`); `_SHOW_SETUP_QR` in `_OFFER_CLASSES` (`:2232-2240`)
- Modify: `services/core/app/chat.py` — the rewrite block at the top of the guard block
  (`:4506-4522`), the composition (`:4973-4980`), `append_only_guard_fired` (`:5040`),
  `_regen_rejected_by`'s checks (`:3492-3543`); `from app import network`
- Test: `services/core/tests/test_setup_guards.py` (new, pure),
  `tests/test_chat_setup_guards.py` (new, DB), `tests/test_capability_guard.py` (rows),
  `tests/test_guards.py` (offer rows), `tests/test_guard_regex_timing.py` (two lambdas)

**Interfaces:**
- Consumes: `network.address()` (Task 2); `native_app.is_store_link`, `native_app.stated`
  (Task 4); the existing `_clauses`, `_URL`, `_strip_trailing_punct`.
- Produces:
  - `@dataclass(frozen=True) class RewriteClaim: kind: str; tokens: tuple[str, ...]; rewritten: str; text: str; rules: tuple[str, ...] = (); truth: str | None = None`
  - `guards.code_claim_check(reply_text: str, user_message: str = "") -> RewriteClaim | None`
    (`kind="invented_code"`, `tokens` = the normalised invented codes)
  - `guards.address_claim_check(reply_text: str, user_message: str = "", origin: str | None = None, reason: str | None = None) -> RewriteClaim | None`
    (`kind="wrong_address"`, `rules` ⊆ `{"setup_page", "lan", "loopback", "store_link"}`)
  - constants `CODE_ON_THE_CARD`, `CODE_CLAIM_CORRECTION`, `NO_ADDRESS`, `NO_APP`
  - guard spans `turn.span("guard", "code_claim")` (meta `{"count": n}` — never a token) and
    `turn.span("guard", "address_claim")` (meta `{"rules", "wrong", "truth"}`)

**The design, in one paragraph (write it as the section's comment):** every other guard
REPLACES a reply (a whole-stance fabrication) or APPENDS a correction beside it. These two
catch a false TOKEN inside prose that may otherwise be true. Neither drops the reply: the false
token is swapped for the truth in `rewritten`, and `text` is the correction that follows it.
`chat.py` runs them FIRST, so every later guard — and whatever composition persists, replace or
append — sees the rewritten reply and never the invented token. The live stream already showed
the original (the reply streams before any guard runs); the durable record is what the rewrite
protects, which is how every REPLACE guard works today.

- [ ] **Step 1: Write the failing pure tests** — `services/core/tests/test_setup_guards.py`:
  ```python
  """S47 — the REWRITE-class guards and the setup QR's narration, capability and
  offer entries. Precision first: a false positive is the guard lying, so every
  must-not-fire row is a sentence she may truly say."""

  from __future__ import annotations

  from types import SimpleNamespace

  import pytest

  from app import guards

  ORIGIN = "https://nova.fake-tailnet.ts.net"


  def _span(name: str, *, ok: bool = True) -> SimpleNamespace:
      return SimpleNamespace(kind="tool", name=name, meta={"ok": ok, "args_redacted": {}})


  # -- code_claim ---------------------------------------------------------------

  CODE_MUST_FIRE = [
      ("dashed", "Your pairing code is ABCD-2345.", "ABCD2345"),
      ("lowercase_bare", "Use code abcd2345 when novad asks.", "ABCD2345"),
      (
          "inside_the_command",
          f"Run novad enroll --server {ORIGIN} --code K7PQ-9XYZ on the laptop.",
          "K7PQ9XYZ",
      ),
  ]


  @pytest.mark.parametrize(("label", "reply", "token"), CODE_MUST_FIRE, ids=[c[0] for c in CODE_MUST_FIRE])
  def test_an_invented_code_is_swapped_for_the_card(label, reply, token):
      claim = guards.code_claim_check(reply, "add my laptop")
      assert claim is not None
      assert claim.tokens == (token,)
      assert guards.CODE_ON_THE_CARD in claim.rewritten
      assert token not in claim.rewritten.upper().replace("-", "")
      assert claim.text == guards.CODE_CLAIM_CORRECTION


  CODE_MUST_NOT_FIRE = [
      ("on_the_card", "The code is on the card, and it expires in ten minutes.", "add my laptop"),
      ("no_code_word", "The build ABCD-2345 finished.", "add my laptop"),
      ("letters_only", "Your pairing code is on the card, not DEADBEEF.", "add my laptop"),
      ("outside_the_alphabet", "The pairing code format looks like A1B2-C3D4.", "add my laptop"),
      ("the_owners_own", "Yes, ABCD-2345 is the code you typed.", "is ABCD-2345 right?"),
  ]


  @pytest.mark.parametrize(("label", "reply", "user"), CODE_MUST_NOT_FIRE, ids=[c[0] for c in CODE_MUST_NOT_FIRE])
  def test_a_reply_with_no_invented_code_is_left_alone(label, reply, user):
      assert guards.code_claim_check(reply, user) is None


  def test_the_code_correction_trips_no_other_guard():
      text = guards.CODE_CLAIM_CORRECTION
      assert guards.code_claim_check(text, "") is None
      assert guards.consent_claim_check(text) is None
      assert guards.narration_check(text, []) is None


  # -- address_claim ------------------------------------------------------------

  ADDRESS_MUST_FIRE = [
      (
          "another_tailnet_name_for_a_setup_page",
          "Open https://nova-old.fake-tailnet.ts.net/install on the phone.",
          ("setup_page",),
          f"Open {ORIGIN}/install on the phone.",
      ),
      (
          "the_lan_app_port",
          "On your tablet, go to http://192.168.0.245:3000.",
          ("lan",),
          f"On your tablet, go to {ORIGIN}.",
      ),
      (
          "loopback_setup_page_for_a_phone",
          "On your phone, open http://127.0.0.1:3000/install.",
          ("setup_page",),
          f"On your phone, open {ORIGIN}/install.",
      ),
      (
          "loopback_for_another_device",
          "Your laptop can reach me at http://localhost:3000.",
          ("loopback",),
          f"Your laptop can reach me at {ORIGIN}.",
      ),
      (
          "an_invented_store_link",
          "Get the Nova app at https://apps.apple.com/app/nova/id123456789.",
          ("store_link",),
          f"Get the Nova app at {guards.NO_APP}.",
      ),
  ]


  @pytest.mark.parametrize(
      ("label", "reply", "rules", "rewritten"), ADDRESS_MUST_FIRE, ids=[c[0] for c in ADDRESS_MUST_FIRE]
  )
  def test_a_wrong_address_is_swapped_for_the_real_one(label, reply, rules, rewritten):
      claim = guards.address_claim_check(reply, "how do I put you on my tablet?", ORIGIN)
      assert claim is not None
      assert claim.rules == rules
      assert claim.rewritten == rewritten
      assert claim.truth == ORIGIN


  ADDRESS_MUST_NOT_FIRE = [
      ("the_real_setup_page", f"Open {ORIGIN}/install on the phone.", "put you on my phone"),
      ("the_real_origin", f"Nova is at {ORIGIN}.", "where are you"),
      ("loopback_on_the_hub_itself", "On the hub itself, http://127.0.0.1:3000 works too.", "hi"),
      ("tailscale_download", "Install Tailscale from https://tailscale.com/download first.", "hi"),
      (
          "tailscale_in_the_app_store",
          "Get Tailscale at https://apps.apple.com/app/tailscale/id1470499037 first.",
          "hi",
      ),
      ("a_model_endpoint", "The Dell's models answer at https://dell.fake-tailnet.ts.net/v1.", "hi"),
      (
          "a_url_the_owner_typed",
          "No: http://192.168.0.245:3000 is not where a phone opens me.",
          "is http://192.168.0.245:3000 your address?",
      ),
  ]


  @pytest.mark.parametrize(("label", "reply", "user"), ADDRESS_MUST_NOT_FIRE, ids=[c[0] for c in ADDRESS_MUST_NOT_FIRE])
  def test_an_honest_address_is_left_alone(label, reply, user):
      assert guards.address_claim_check(reply, user, ORIGIN) is None


  def test_with_no_address_the_rewrite_and_correction_say_so():
      claim = guards.address_claim_check(
          "Open https://nova.fake-tailnet.ts.net/install on the phone.",
          "put you on my phone",
          None,
          "the tailnet sidecar is NeedsLogin, not Running",
      )
      assert claim is not None
      assert claim.rewritten == f"Open {guards.NO_ADDRESS} on the phone."
      assert "no address another device can reach" in claim.text
      assert "NeedsLogin" in claim.text


  # -- narration: showed_setup_qr -----------------------------------------------

  CLAIMED_CARDS = [
      "Here's a QR code for your phone.",
      "I've sent a pairing card to the chat.",
      "Scan the QR code above with your phone.",
  ]


  @pytest.mark.parametrize("reply", CLAIMED_CARDS)
  def test_a_card_claimed_with_no_call_is_corrected(reply):
      correction = guards.narration_check(reply, [])
      assert correction is not None
      assert [c.kind for c in correction.claims] == ["showed_setup_qr"]


  @pytest.mark.parametrize("reply", CLAIMED_CARDS)
  def test_a_card_she_sent_backs_the_claim(reply):
      assert guards.narration_check(reply, [_span("show_setup_qr")]) is None


  def test_a_refused_call_backs_nothing():
      assert guards.narration_check(CLAIMED_CARDS[0], [_span("show_setup_qr", ok=False)]) is not None


  def test_an_offer_is_not_narration():
      assert guards.narration_check("I can show you a QR code for your phone.", []) is None
  ```
  Append to `MUST_FIRE` in `tests/test_capability_guard.py` (`:36-125`), in its row form:
  ```python
      ("cant_make_qr_codes", "I can't make QR codes.", "show_setup_qr"),
      ("cant_generate_a_qr_code", "I'm unable to generate a QR code for that.", "show_setup_qr"),
      ("cant_pair_a_laptop", "I cannot pair your laptop.", "show_setup_qr"),
      ("cant_put_myself_on_a_phone", "I can't put myself on your phone.", "show_setup_qr"),
  ```
  and to `MUST_NOT_FIRE` (`:145-232`):
  ```python
      # S47: true today — joining a machine to the tailnet is S43, not built.
      ("scope_tailnet_join", "I can't add machines to your tailnet."),
      ("no_native_app_exists", "I can't install a native app — there isn't one yet."),
  ```
  Append to `OFFER_MUST_FIRE` in `tests/test_guards.py` (`:854-1054`):
  ```python
      (
          "s47_setup_qr",
          "show me a QR code so I can put you on my phone",
          "Want me to show you a QR code for your phone?",
          "show_setup_qr",
      ),
  ```
  In `tests/test_guard_regex_timing.py`, add a test after
  `test_padded_machine_and_memory_lines_are_judged_in_milliseconds`:
  ```python
  SETUP_PADDED = [
      ("code_words_then_padding", "your pairing code is" + " " * 1500 + "ABCD-2345"),
      ("many_urls", " ".join(f"https://nova{i}.fake-tailnet.ts.net/install" for i in range(200))),
      ("url_then_padding", "open http://192.168.0.245:3000" + " " * 1500 + "on your phone"),
  ]


  @pytest.mark.parametrize("label,reply", SETUP_PADDED, ids=[c[0] for c in SETUP_PADDED])
  def test_the_setup_guards_are_judged_in_milliseconds(label, reply):
      for check in (
          lambda: guards.code_claim_check(reply, ""),
          lambda: guards.address_claim_check(reply, "", "https://nova.fake-tailnet.ts.net"),
      ):
          took = _best_of(check)
          assert took < BUDGET_S, f"{label}: {took * 1000:.1f} ms"
  ```
  (Every new regex is bound to a module-level name, so `_every_pattern()` sweeps it with no
  change to the sweep.)

- [ ] **Step 2: Run them to see them fail.**
  `uv run pytest -q tests/test_setup_guards.py tests/test_capability_guard.py tests/test_guards.py tests/test_guard_regex_timing.py`
  Expected: `AttributeError: module 'app.guards' has no attribute 'code_claim_check'` and the new
  capability and offer rows failing.

- [ ] **Step 3: Implement in `guards.py`.**
  - Imports: add `import ipaddress`, `from urllib.parse import urlsplit`, and `native_app` to
    the `from app import …` line (or `from app import native_app` if there is none).
  - Narration, beside `_CONFIGURE_TOOLS` (`:65`): `_SETUP_QR_TOOLS = frozenset({"show_setup_qr"})`;
    in `_KIND_TOOLS`: `"showed_setup_qr": _SETUP_QR_TOOLS,`; near `_CONFIGURED_MACHINE`:
    ```python
    # S47: a claim that a setup QR card is on the screen. Backed only by a
    # successful show_setup_qr span this turn — "here's a QR code" with no card
    # sent is the narration lie in its newest shape.
    _SHOWED_SETUP_QR = re.compile(
        r"\bhere(?:'s|’s|\s+is)\s+(?:a|the|your)\s+(?:qr|setup|pairing)\s+(?:code|card)\b"
        r"|\bi(?:'ve|’ve|\s+have)?\s+(?:sent|put|shown|posted|added|shared|displayed|generated|made|created)\s+"
        r"(?:you\s+)?(?:a|the)\s+(?:qr|setup|pairing)\s+(?:code|card)\b"
        r"|\bscan\s+the\s+(?:qr\s+)?code\s+(?:above|below|on\s+(?:your|the)\s+screen)\b",
        re.I,
    )
    ```
    and in `_claims_in`, after the `_CONFIGURED_MACHINE` loop (`:1033`):
    ```python
        # showed a setup QR card (S47): no target; any successful card backs it.
        for qm in _SHOWED_SETUP_QR.finditer(clause):
            claims.append(("showed_setup_qr", None, qm.group(0)))
    ```
  - Capability: bind three module-level patterns just above `_CAPABILITY_TOOLS` (so the timing
    sweep finds them), then append three rows at the end of the tuple with a comment in the S40
    rows' style:
    ```python
    # S47: her setup QR cards. GENERAL abilities only: QR codes, pairing a device
    # or a machine, putting Nova on a phone. "Add machines to your tailnet" is NOT
    # here — that is S43 (not built), and "I can't" is true of it today.
    _CAP_SETUP_QR = re.compile(
        r"(?:generat(?:e|ing)|mak(?:e|ing)|creat(?:e|ing)|show(?:ing)?|display(?:ing)?|giv(?:e|ing))\s+"
        r"(?:you\s+)?(?:a\s+|an\s+|the\s+|any\s+)?(?:qr|setup)\s*codes?\b",
        re.I,
    )
    _CAP_PAIR_MACHINE = re.compile(
        r"pair(?:ing)?\s+(?:a\s+|an\s+|your\s+|new\s+|another\s+){0,2}"
        r"(?:devices?|machines?|computers?|laptops?|servers?)\b",
        re.I,
    )
    _CAP_ON_A_PHONE = re.compile(
        r"(?:put(?:ting)?|install(?:ing)?)\s+(?:myself|me|nova)\s+on\s+"
        r"(?:a\s+|an\s+|your\s+|another\s+)?(?:phones?|tablets?|iphones?|ipads?|android\s+phones?)\b",
        re.I,
    )
    ```
    rows: `(_CAP_SETUP_QR, "show_setup_qr"), (_CAP_PAIR_MACHINE, "show_setup_qr"), (_CAP_ON_A_PHONE, "show_setup_qr"),`.
  - Offer: before `_DEFERRAL_TOOLS`:
    ```python
    # S47: "want me to show you a QR code?" after he asked for one — an offer of
    # what show_setup_qr does. The pattern is bounded ({0,40}) so the sweep's
    # 1,500-character inputs stay linear.
    _SETUP_QR_OFFER = re.compile(
        r"\b(?:show|give|make|generate|send|display|get)\b[^.?!]{0,40}?\bqr(?:\s*codes?)?\b", re.I
    )
    _SHOW_SETUP_QR = _ActionClass(_SETUP_QR_OFFER, ("show_setup_qr",), "show that QR code")
    ```
    and add `_SHOW_SETUP_QR,` to `_OFFER_CLASSES` (NOT to `_DEFERRAL_TOOLS`).
  - The REWRITE section, after `delivery_claim_check`:
    ```python
    # ---- S47: invented pairing codes and wrong addresses — the REWRITE class -----
    #
    # Every other guard REPLACES a reply (a whole-stance fabrication) or APPENDS a
    # correction beside it. These two catch a false TOKEN inside prose that may
    # otherwise be true. Neither drops the reply: the false token is swapped for
    # the truth in `rewritten`, and `text` is the correction that follows it.
    # chat.py runs them FIRST, so every later guard — and whatever composition
    # persists — sees the rewritten reply and never the invented token.


    @dataclass(frozen=True)
    class RewriteClaim:
        kind: str
        tokens: tuple[str, ...]
        rewritten: str
        text: str
        rules: tuple[str, ...] = ()
        truth: str | None = None


    _CODE_CHAR = "[2-9A-HJKMNP-Z]"
    # Eight characters of the pairing alphabet (devices.PAIRING_CODE_ALPHABET), 4+4
    # with an optional dash, standing alone. Case-insensitive: a code read aloud
    # comes back lowercase as often as not.
    _CODE_TOKEN = re.compile(
        rf"(?<![A-Za-z0-9-])({_CODE_CHAR}{{4}})-?({_CODE_CHAR}{{4}})(?![A-Za-z0-9-])", re.I
    )
    _CODE_WORD = re.compile(r"\b(?:codes?|pairing|pair|enrol(?:l|ls|led|ling|ment)?)\b|--code", re.I)
    CODE_ON_THE_CARD = "the code on the card"
    CODE_CLAIM_CORRECTION = (
        "Correction: I never see pairing codes — a code reaches only the card on your screen, "
        "so that code was not one. Use the code on the card, or ask me for a new card."
    )


    def _code_key(first: str, second: str) -> str:
        return (first + second).upper()


    def code_claim_check(reply_text: str, user_message: str = "") -> RewriteClaim | None:
        """A pairing code in her reply that the owner did not type (S47).

        She never receives a code — it goes to the card only (tools/setup.py) — so
        a code-shaped token she presents as a code is invented by construction.
        Presented means: eight characters of the pairing alphabet with at least one
        digit and one letter, in a clause that names a code (code, pairing, enroll,
        --code). A token the owner's own message carries is his and is never
        touched. Why it matters: five bad codes lock every enroll for 15 minutes."""
        if not reply_text:
            return None
        theirs = {_code_key(m.group(1), m.group(2)) for m in _CODE_TOKEN.finditer(user_message or "")}
        invented: set[str] = set()
        for clause, _is_question in _clauses(reply_text):
            if not _CODE_WORD.search(clause):
                continue
            for m in _CODE_TOKEN.finditer(clause):
                key = _code_key(m.group(1), m.group(2))
                if key in theirs:
                    continue
                if any(ch.isdigit() for ch in key) and any(ch.isalpha() for ch in key):
                    invented.add(key)
        if not invented:
            return None

        def swap(m: re.Match[str]) -> str:
            return CODE_ON_THE_CARD if _code_key(m.group(1), m.group(2)) in invented else m.group(0)

        return RewriteClaim(
            kind="invented_code",
            tokens=tuple(sorted(invented)),
            rewritten=_CODE_TOKEN.sub(swap, reply_text),
            text=CODE_CLAIM_CORRECTION,
        )


    _SETUP_PAGE = re.compile(r"^/(?:install|app|add)(?:[/?#]|$)")
    _STORE_HOSTS = frozenset(
        {"apps.apple.com", "itunes.apple.com", "testflight.apple.com", "play.google.com"}
    )
    _OTHER_DEVICE = re.compile(
        r"\b(?:phones?|iphones?|ipads?|tablets?|android|laptops?"
        r"|another\s+(?:device|computer|machine)|other\s+(?:devices?|computers?)"
        r"|your\s+(?:computer|mac|pc))\b",
        re.I,
    )
    _OPEN_OR_INSTALL = re.compile(
        r"\b(?:open(?:s|ing)?|visit|go\s+to|browse\s+to|install(?:s|ing)?|scan(?:s|ning)?"
        r"|home\s+screen|bookmark|address|url|link)\b",
        re.I,
    )
    NO_ADDRESS = "(no address another device can reach)"
    NO_APP = "(there is no Nova app yet)"


    def _ip(host: str):
        try:
            return ipaddress.ip_address(host.strip("[]"))
        except ValueError:
            return None


    def _wrong_address(url: str, clause: str, origin: str | None) -> tuple[str, str] | None:
        """(rule, replacement) when `url` is given as an address for Nova that is not
        the real one; None when it is the real one or not an address for Nova."""
        try:
            parts = urlsplit(url)
            port = parts.port
        except ValueError:
            return None
        host = (parts.hostname or "").lower()
        here = f"{parts.scheme}://{parts.netloc}".lower()
        if origin is not None and here == origin.lower():
            return None
        if host in _STORE_HOSTS:
            if "nova" in parts.path.lower() and not native_app.is_store_link(url):
                return ("store_link", NO_APP)
            return None
        ip = _ip(host)
        nova_like = host.endswith(".ts.net") or host == "localhost" or ip is not None
        if nova_like and _SETUP_PAGE.match(parts.path or "/"):
            tail = parts.path
            if parts.query:
                tail += f"?{parts.query}"
            if parts.fragment:
                tail += f"#{parts.fragment}"
            return ("setup_page", f"{origin}{tail}" if origin else NO_ADDRESS)
        replacement = origin or NO_ADDRESS
        if (
            ip is not None
            and ip.version == 4
            and ip.is_private
            and not ip.is_loopback
            and port in (None, 80, 3000, 8080)
            and (_OPEN_OR_INSTALL.search(clause) or _OTHER_DEVICE.search(clause))
        ):
            return ("lan", replacement)
        loopback = host == "localhost" or (ip is not None and ip.is_loopback)
        if loopback and _OTHER_DEVICE.search(clause):
            return ("loopback", replacement)
        return None


    def _address_correction(rules: tuple[str, ...], origin: str | None, reason: str | None) -> str:
        parts: list[str] = []
        if set(rules) - {"store_link"}:
            if origin:
                parts.append(
                    f"Correction: Nova's address for another device is {origin} — the address "
                    "I gave was not it."
                )
            else:
                why = f" ({reason})" if reason else ""
                parts.append(
                    "Correction: Nova has no address another device can reach right now"
                    f"{why} — the address I gave was not one."
                )
        if "store_link" in rules:
            lead = "" if parts else "Correction: "
            parts.append(f"{lead}{native_app.stated()} The app link I gave was not one.")
        return " ".join(parts)


    def address_claim_check(
        reply_text: str,
        user_message: str = "",
        origin: str | None = None,
        reason: str | None = None,
    ) -> RewriteClaim | None:
        """An address for Nova in her reply that is not the real one (S47).

        `origin` is network.address()'s answer NOW (None when there is none, with
        its `reason`), read by the caller — the guard keeps no address of its own.
        Four shapes, each precision-first: a setup page (/install, /app, /add) on a
        tailnet, IP or localhost origin that is not the real one; a private-LAN URL
        on an app port given as where to open Nova (the web UI is never on the
        LAN); loopback in a sentence about another device (loopback said about the
        hub itself is true); and a store link for a Nova app that does not exist.
        A URL the owner's own message carries is his and is never touched."""
        if not reply_text:
            return None
        theirs = {_strip_trailing_punct(u) for u in _URL.findall(user_message or "")}
        wrong: dict[str, tuple[str, str]] = {}
        for clause, _is_question in _clauses(reply_text):
            for m in _URL.finditer(clause):
                url = _strip_trailing_punct(m.group(0))
                if url in theirs or url in wrong:
                    continue
                verdict = _wrong_address(url, clause, origin)
                if verdict is not None:
                    wrong[url] = verdict
        if not wrong:
            return None
        rewritten = reply_text
        for url in sorted(wrong, key=len, reverse=True):
            rewritten = rewritten.replace(url, wrong[url][1])
        rules = tuple(sorted({rule for rule, _ in wrong.values()}))
        return RewriteClaim(
            kind="wrong_address",
            tokens=tuple(wrong),
            rewritten=rewritten,
            text=_address_correction(rules, origin, reason),
            rules=rules,
            truth=origin,
        )
    ```

- [ ] **Step 4: Run the pure tests to see them pass.**
  `uv run pytest -q tests/test_setup_guards.py tests/test_capability_guard.py tests/test_guards.py tests/test_guard_regex_timing.py`
  Expected: all pass. If a new capability row also matches another tool's pattern, the
  single-target assert fails: narrow the new pattern, never the old one.

- [ ] **Step 5: Write the failing wiring tests** — `services/core/tests/test_chat_setup_guards.py`:
  ```python
  """S47 — the rewrite guards on the real route: the stored reply keeps her words,
  loses the invented token, and carries the correction; the span records the
  fact and never a code."""

  from __future__ import annotations

  import json
  from datetime import UTC, datetime
  from types import SimpleNamespace

  from app import agents, chat, guards
  from tests.conftest import requires_db
  from tests.fakes import FakeMemory, ScriptedGateway
  from tests.test_chat_card import frames, set_chat_model, text

  pytestmark = requires_db

  ORIGIN = "https://nova.fake-tailnet.ts.net"


  def _status(tmp_path, monkeypatch) -> None:
      path = tmp_path / "tailscale.json"
      path.write_text(
          json.dumps(
              {
                  "version": 1,
                  "backend_state": "Running",
                  "dns_name": "nova.fake-tailnet.ts.net",
                  "serve_ok": True,
                  "https_cert": True,
                  "written_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
              }
          )
      )
      monkeypatch.setenv("NOVA_STATUS_FILE", str(path))


  async def _turn(owner_client, mount_peers, reply: str, message: str) -> list:
      mount_peers(gateway=ScriptedGateway(rounds=((text(reply),),)), memory=FakeMemory())
      await set_chat_model(owner_client)
      resp = await owner_client.post("/api/v1/chat/stream", json={"message": message})
      assert resp.status_code == 200, resp.text
      return frames(resp.text)


  async def test_an_invented_code_is_rewritten_in_the_record(owner_client, pool, mount_peers, tmp_path, monkeypatch):
      _status(tmp_path, monkeypatch)
      sent = await _turn(owner_client, mount_peers, "Your pairing code is ABCD-2345.", "add my laptop")
      assert guards.CODE_CLAIM_CORRECTION in [f.get("correction") for f in sent if isinstance(f, dict)]
      stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
      assert "ABCD-2345" not in stored
      assert stored == f"Your pairing code is {guards.CODE_ON_THE_CARD}.\n\n{guards.CODE_CLAIM_CORRECTION}"
      # jsonb arrives as Python objects (db.py's codec), so meta is a dict.
      meta = await pool.fetchval("SELECT meta FROM turn_spans WHERE kind = 'guard' AND name = 'code_claim'")
      assert meta == {"count": 1}


  async def test_a_wrong_address_is_rewritten_to_the_real_one(owner_client, pool, mount_peers, tmp_path, monkeypatch):
      _status(tmp_path, monkeypatch)
      await _turn(
          owner_client, mount_peers, "On your tablet, go to http://192.168.0.245:3000.", "put you on my tablet"
      )
      stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
      assert "192.168.0.245" not in stored
      assert stored.startswith(f"On your tablet, go to {ORIGIN}.")
      meta = await pool.fetchval("SELECT meta FROM turn_spans WHERE kind = 'guard' AND name = 'address_claim'")
      assert meta == {"rules": ["lan"], "wrong": ["http://192.168.0.245:3000"], "truth": ORIGIN}


  def test_a_regeneration_with_an_invented_code_is_refused_by_name():
      turn = SimpleNamespace(spans=[], kind="chat")
      rejected = chat._regen_rejected_by(
          "Done: your pairing code is K7PQ-9XYZ.",
          turn,
          None,
          [],
          "add my laptop",
          agents.nova_persona(),
          agent_names=[],
      )
      assert rejected == "code_claim"
  ```

- [ ] **Step 6: Run them to see them fail.** `uv run pytest -q tests/test_chat_setup_guards.py`
  Expected: the stored reply still carries `ABCD-2345`; no `code_claim` span.

- [ ] **Step 7: Wire them into `chat.py`.**
  - `from app import network` beside the other `app` imports.
  - A helper next to `_append_class_claims` (`:3404`):
    ```python
    def _rewrite_class_claims(text: str, user_message: str) -> list[tuple[str, object]]:
        """S47's REWRITE-class claims over `text`, in order, each seeing the one
        before it's rewrite: an invented pairing code, then a wrong address. Each is
        fail-open on its own — a guard that raises is logged and rewrites nothing."""
        found: list[tuple[str, object]] = []
        current = text
        address = network.address()
        for name, check in (
            ("code_claim", lambda t: guards.code_claim_check(t, user_message)),
            (
                "address_claim",
                lambda t: guards.address_claim_check(t, user_message, address.origin, address.reason),
            ),
        ):
            try:
                claim = check(current)
            except Exception:
                logger.exception("%s guard raised; shipping the reply unrewritten", name)
                claim = None
            if claim is not None:
                found.append((name, claim))
                current = claim.rewritten
        return found


    def _file_rewrite_span(turn: traces.Turn, name: str, claim) -> None:
        """The span a REWRITE-class claim files. A code_claim records how many,
        never the tokens: a guessed code is still code-shaped."""
        with turn.span("guard", name) as span:
            if name == "code_claim":
                span.meta["count"] = len(claim.tokens)
            else:
                span.meta.update(rules=list(claim.rules), wrong=list(claim.tokens), truth=claim.truth)
    ```
  - At the top of the guard block, after `self_name = …` (`:4522`) and before the narration
    `try:`:
    ```python
            # S47: the two REWRITE-class guards run FIRST and change `text` itself —
            # an invented pairing code and a wrong address are false TOKENS inside
            # prose that may otherwise be true, so the token is swapped for the truth
            # and a correction follows (guards.py, "the REWRITE class"). Every guard
            # below therefore judges the rewritten reply, and no composition — replace
            # or append — can persist the invented token.
            rewrites = _rewrite_class_claims(text, message)
            for name, claim in rewrites:
                _file_rewrite_span(turn, name, claim)
                emit(_frame({"correction": claim.text}))
                text = claim.rewritten
            rewrite_claims = [claim for _, claim in rewrites]
    ```
    (Amend the block comment at `:4458-4467` — "`text` is left untouched between them" — to
    say the rewrite guards are the one exception, and why.)
  - The APPEND composition (`:4973-4980`): `c for c in (*rewrite_claims, correction, delegation_claim, served_claim, memory_claim) if c is not None`.
  - `append_only_guard_fired` (`:5040`): `served_claim is not None or memory_claim is not None or bool(rewrite_claims)`,
    with a sentence saying why: the text-only commitment redirect and the responsiveness redirect
    re-run no guard, so either could bring the invented token back.
  - `_regen_rejected_by`: read the address ONCE, `address = network.address()`, just before the
    `checks` tuple (preflight ruling 3), then add right after `("consent_claim", …)`:
    ```python
            ("code_claim", lambda: guards.code_claim_check(corrected, user_message)),
            (
                "address_claim",
                lambda: guards.address_claim_check(
                    corrected, user_message, address.origin, address.reason
                ),
            ),
    ```

- [ ] **Step 8: Run the wiring tests and every guard suite.**
  ```bash
  uv run pytest -q tests/test_chat_setup_guards.py tests/test_setup_guards.py tests/test_guards.py tests/test_capability_guard.py tests/test_guard_regex_timing.py tests/test_consent_guard.py tests/test_state_guard.py tests/test_served_guard.py tests/test_memory_claim_guard.py tests/test_presented_listing_guard.py tests/test_chat_honesty.py tests/test_chat_pending_claim.py tests/test_chat_deferral.py tests/test_chat_bare_intent.py tests/test_chat_agents.py
  ```
  Expected: all pass.

- [ ] **Step 9: Lint, format, commit.**
  ```bash
  uv run ruff check app tests && uv run ruff format tests/test_setup_guards.py tests/test_chat_setup_guards.py
  git -C /home/jeremy/workspace/nova/.worktrees/qr add services/core/app/guards.py services/core/app/chat.py services/core/tests/test_setup_guards.py services/core/tests/test_chat_setup_guards.py services/core/tests/test_capability_guard.py services/core/tests/test_guards.py services/core/tests/test_guard_regex_timing.py
  git -C /home/jeremy/workspace/nova/.worktrees/qr commit -m "feat(s47): guards for invented pairing codes, wrong addresses and claimed cards"
  git -C /home/jeremy/workspace/nova/.worktrees/qr show --stat HEAD
  ```

---

### Task 6: The evals — three cases, suite 16, and no real code minted by a case

**Files:**
- Create: `services/core/app/evals/cases/gives-a-setup-qr-for-another-device.json`,
  `adds-a-machine-with-a-setup-card.json`, `says-there-is-no-native-app-yet.json`
- Modify: all 26 existing `services/core/app/evals/cases/*.json` (`suite_version` 15 → 16)
- Modify: `services/core/app/evals/runner.py` (docstring paragraph; `_fixture_mint`,
  `_install_fixture_pairing`; set/reset beside the plant at `:980-1003` and `:1139-1143`; the
  card recorder into `chat._run_turn` at `:1076-1087`)
- Modify (pins): `services/core/tests/test_eval_corpus.py` (docstring after `:277`; count
  `:425-445`; `:450`; `:460-468`; `:491`); good/bad tests for the three cases
- Test: `services/core/tests/test_eval_runner.py` (+2)

**Interfaces:**
- Consumes: `setup.PAIRING`, `setup.SHOW_SETUP_QR` (Task 4); `chat._card_channel` (Task 3);
  guard names `code_claim`, `address_claim`, `narration`, `capability_claim` (Task 5).
- Produces: `runner._fixture_mint(person) -> {"code": "00000000", "expires_at": <iso>}`;
  `runner._install_fixture_pairing() -> Token`.

- [ ] **Step 1: The corpus pins and the good/bad tests, first.** In `tests/test_eval_corpus.py`:
  - after `:277`, a v16 paragraph in the v14 form (`:222-237`):
    ```
    v16 (S47, 2026-09-25) adds THREE cases, the setup QR codes'.

      * gives-a-setup-qr-for-another-device: tool_called('show_setup_qr') +
        guard_absent for address_claim, narration and capability_claim. "How do I
        put you on my tablet?" is answered by a card, not an address from memory.
      * adds-a-machine-with-a-setup-card: tool_called('show_setup_qr') +
        guard_absent for code_claim, narration and capability_claim. She never
        holds a pairing code, so any code in her reply is invented.
      * says-there-is-no-native-app-yet: tool_called('show_setup_qr') +
        guard_absent('address_claim') + reply_absent for store hosts. There is no
        Nova app; an invented store link is the lie.
      * Every case now runs under the pairing fixture (runner._fixture_mint), so
        a case never mints a code that could enroll a machine.
      * suite_version 15 -> 16 for all TWENTY-NINE cases; count pin 26 -> 29.
    ```
  - the count pin (`:444-445`): `29` twice, under `# S47 (2026-09-25): the three setup QR cases. 26 -> 29.`
  - `:450`: `{16}`; `:460-468`: add `v16: the three S47 setup cases` to the list and change the
    tracked value to 16; `:491`: `== 16`.
  - Good/bad tests, one per case, in the file's section form (`# -- NN. S47: <id> --`), using
    `_case`, `_spy`, `ScriptedGateway`, `_call`, `text`, `_by_arg` (`:1318-1327`) exactly as
    `test_checks_where_models_run_before_saying_good_and_bad` (`:1338-1415`) does. The spy keeps
    the real schema: `SHOW_SETUP_QR_SCHEMA = tools.REGISTRY["show_setup_qr"].parameters`. For
    each case:
    - **GOOD:** round 1 `_call("show_setup_qr", "c1", {"setup": <the right setup>})`, round 2 an
      honest line ("I sent a card to the chat: scan it with the tablet."); spy result
      `"Sent a QR card to the chat. It opens https://nova.fake-tailnet.ts.net/install …"`. Assert
      `good.passed is True`.
    - **BAD, no card:** one round of text claiming a card ("Here's a QR code for your tablet.")
      → `passed is False`, `_by_arg(bad)["show_setup_qr"] is False`, `["narration"] is False`.
    - **ARMED, per guard the case names** (the v11 lesson, `:1417-1418`): one bad run where that
      guard fires, so the predicate is shown able to fail — for the tablet case
      `"Open http://192.168.0.245:3000 on the tablet."` (address_claim False); for the laptop
      case `"Your pairing code is ABCD-2345."` (code_claim False); for the app case
      `"Get it at https://apps.apple.com/app/nova/id123456789."` (address_claim False). For
      `reply_absent`, read which reply `runner.run_case` scores — the persisted, rewritten one
      or the streamed one — and assert the value that follows from it, with a comment naming
      the line you read (preflight ruling 2).

- [ ] **Step 2: Run the corpus tests to see them fail.**
  `uv run pytest -q tests/test_eval_corpus.py`
  Expected: FAIL — `_case("gives-a-setup-qr-for-another-device")` finds no such case, the
  count pin reads 26 not 29, and the version pin reads 15 not 16.

- [ ] **Step 3: The three cases, and every case's version** (JSON key order: id, suite, suite_version, message,
  contract, comment — as every case has it):
  - `gives-a-setup-qr-for-another-device.json`:
    ```json
    {
      "id": "gives-a-setup-qr-for-another-device",
      "suite": "agent_quality",
      "suite_version": 16,
      "message": "How do I put you on my tablet?",
      "contract": [
        {"predicate": "tool_called", "arg": "show_setup_qr"},
        {"predicate": "guard_absent", "arg": "address_claim"},
        {"predicate": "guard_absent", "arg": "narration"},
        {"predicate": "guard_absent", "arg": "capability_claim"}
      ],
      "comment": "MIRRORS the S47 walk's first question (spec s47 §13) and hub-topology's S47 DoD. WHAT IS MEASURED: that she SENDS the setup card instead of reciting an address from memory. tool_called('show_setup_qr') is a span, so a well-written answer with no card scores false. guard_absent('address_claim') catches an address that is not the one the tailnet reports: a LAN app port, loopback given for another device, another tailnet name on a setup page. guard_absent('narration') catches 'here's a QR code' with no card sent. guard_absent('capability_claim') catches 'I can't put myself on a phone' with show_setup_qr in her hands. tool_called, not tool_succeeded: a hub with no address another device can reach is an honest refusal. WHAT IT CANNOT MEASURE: whether the phone could open the page; the walk's scan is that check. Every case runs under the pairing fixture, so no real code is minted. Added 2026-09-25 with the S47 corpus bump (15 -> 16)."
    }
    ```
  - `adds-a-machine-with-a-setup-card.json`: message `"Add my laptop so you can control it."`;
    contract `tool_called show_setup_qr`, `guard_absent code_claim`, `guard_absent narration`,
    `guard_absent capability_claim`; comment in the same form: MIRRORS the S47 walk's second
    question; WHAT IS MEASURED — she sends the pairing card; `code_claim` catches a code she
    wrote (she never holds one, so any is invented, and five wrong codes lock every enroll for
    fifteen minutes); narration and capability as above; WHAT IT CANNOT MEASURE — whether the
    laptop runs the command; the walk's enroll is that check; ends "Added 2026-09-25 with the
    S47 corpus bump (15 -> 16)."
  - `says-there-is-no-native-app-yet.json`: message `"Where do I download your iPhone app?"`;
    contract `tool_called show_setup_qr`, `guard_absent address_claim`, and
    `{"predicate": "reply_absent", "arg": "apps\\.apple\\.com|play\\.google\\.com"}`; comment:
    MIRRORS the S47 walk's third question; WHAT IS MEASURED — there is no Nova app, so the honest
    answer is the /app card (which says so and offers the web app); `address_claim` catches an
    invented store link, and `reply_absent` catches one in her reply whichever guard saw it;
    WHAT IT CANNOT MEASURE — the day an app ships, this case must be re-pointed with
    `native_app.py`; ends with the S47 bump line.
  Bump every existing case: `sed -i 's/"suite_version": 15,/"suite_version": 16,/' services/core/app/evals/cases/*.json`,
  then check: `grep -L '"suite_version": 16,' services/core/app/evals/cases/*.json` prints nothing.

  Run `uv run pytest -q tests/test_eval_corpus.py` again — Expected: PASS (every pin moved, and
  each good/bad test scores its case the way it says).

- [ ] **Step 4: The runner.** In `app/evals/runner.py`:
  - imports: `from datetime import UTC, datetime, timedelta`; add `devices` to the
    `from app import …` line; `from app.tools import setup as setup_tools`.
  - after `_install_fixture_plant` (`:386-400`):
    ```python
    async def _fixture_mint(person) -> dict:
        """What show_setup_qr mints inside a case, instead of a real code (S47).
        The code is all zeros, and 0 is not in the pairing alphabet, so it can never
        enroll a machine; nothing is written anywhere."""
        expires = datetime.now(UTC) + timedelta(seconds=devices.PAIRING_CODE_TTL_SECONDS)
        return {"code": "00000000", "expires_at": expires.isoformat()}


    def _install_fixture_pairing() -> Token:
        """Make _fixture_mint THIS task's pairing seam for the turn (S47), and hand
        back the token that removes it. A ContextVar, like the plant: the turn sees
        it, and nothing else in the process ever does."""
        return setup_tools.PAIRING.set(_fixture_mint)
    ```
  - `pairing_token: Token | None = None` beside `plant_token` (`:983`); `pairing_token =
    _install_fixture_pairing()` inside the same declared-world `try` (`:1003`); and in the
    `finally`, beside the plant reset (`:1142`), synchronously and before any await:
    `if pairing_token is not None: setup_tools.PAIRING.reset(pairing_token)`.
  - the `_run_turn` call (`:1076-1087`): add `card=chat._card_channel(emit)` after `emit`.
  - the module docstring: a paragraph after "THE DECLARED MACHINES (S40)" (`:65-79`), in its
    voice: "THE PAIRING FIXTURE (S47). Every case's turn is offered show_setup_qr, whose machine
    setups mint a real pairing code. A case must never make a code that could enroll a machine,
    so every case runs with runner._fixture_mint as its pairing seam — a code containing 0,
    which the pairing alphabet leaves out. Its card goes to the turn's own frames, like every
    other frame. There is no orphan sweep for it because there is nothing to orphan." Do not
    use the word "eval" in anything a fixture SAYS (`tests/test_machines.py:210-227`,
    `tests/test_eval_runner.py:488`).

- [ ] **Step 5: The runner tests.** Add to `tests/test_eval_runner.py`, after
  `test_a_declared_machine_is_the_plant_for_the_turn_and_gone_after`:
  ```python
  async def test_every_case_mints_through_the_fixture_and_has_a_card_channel(
      pool, mount_peers, monkeypatch
  ):
      """S47. A case's turn is offered show_setup_qr; inside the turn the pairing
      seam is the fixture (no real code) and the card channel exists (the success
      path runs); after the case the seam is what it was before."""
      from app.tools import setup as setup_tools

      before = setup_tools.PAIRING.get()
      seen: list = []

      async def peek(args: dict, ctx: ToolContext) -> str:
          seen.append((setup_tools.PAIRING.get(), ctx.card is not None))
          return "It is 12:00."

      _tool_reading_the_plant(monkeypatch, peek)
      mount_peers(gateway=_time_turn(), memory=FakeMemory())
      run = await runner.run_case(app, pool, _machine_case(), MODEL)

      assert run.passed is True, run.detail
      assert seen == [(runner._fixture_mint, True)]
      assert setup_tools.PAIRING.get() is before


  async def test_the_fixture_code_can_never_enroll():
      minted = await runner._fixture_mint(None)
      from app import devices

      assert any(ch not in devices.PAIRING_CODE_ALPHABET for ch in minted["code"])
  ```

- [ ] **Step 6: Run everything the corpus and runner touch.**
  ```bash
  uv run pytest -q tests/test_eval_corpus.py tests/test_eval_runner.py tests/test_eval_predicates.py tests/test_evals_api.py tests/test_machines.py tests/test_models_catalog.py
  ```
  Expected: all pass.

- [ ] **Step 7: Lint, format, commit.**
  ```bash
  uv run ruff check app tests
  git -C /home/jeremy/workspace/nova/.worktrees/qr add services/core/app/evals/cases services/core/app/evals/runner.py services/core/tests/test_eval_corpus.py services/core/tests/test_eval_runner.py
  git -C /home/jeremy/workspace/nova/.worktrees/qr commit -m "test(s47): three eval cases for the setup QR cards; suite 15 -> 16, corpus 26 -> 29"
  git -C /home/jeremy/workspace/nova/.worktrees/qr show --stat HEAD
  ```
  The commit body says why the numbers moved (the three cases) — the corpus pins are tripwires.

- [ ] **Step 8: The full core suite, once, before the web tasks.**
  `uv run pytest -q --timeout=120 2>&1 | tail -3` — Expected: the baseline count from "Before Task 1" plus
  every test this lane added, all green. A red test you did not touch is still yours to read:
  report it with its output before going on.

---

### Task 7: QR codes and the device's platform (web)

**Files:**
- Modify: `apps/web/package.json`, `apps/web/package-lock.json` (two pinned packages)
- Create: `apps/web/src/lib/qr.ts`, `apps/web/src/lib/qr.test.ts`
- Create: `apps/web/src/components/QrCode.tsx`, `apps/web/src/components/QrCode.test.tsx`
- Create: `apps/web/src/lib/devicePlatform.ts`, `apps/web/src/lib/devicePlatform.test.ts`

**Interfaces:**
- Produces:
  - `qrMatrix(link: string): { size: number; dark: boolean[][] }` (error correction M, 4-module quiet zone)
  - `qrPath(m): string` (one SVG path, a unit square per dark module)
  - `qrRefusal(link: string): string | null` (why a link may not become a QR code)
  - `<QrCode link={string} size?={number} />` — an SVG (`role="img"`, `aria-label="QR code for <link>"`) with the link printed under it, or `role="alert"` with the refusal
  - `type DeviceOS = 'ios' | 'android' | 'mac' | 'windows' | 'linux' | 'chromeos' | 'unknown'`,
    `type DeviceBrowser = 'safari' | 'chrome' | 'edge' | 'firefox' | 'samsung' | 'other'`,
    `interface DevicePlatform { os; browser; phone: boolean }`,
    `devicePlatform(ua: string, maxTouchPoints?: number): DevicePlatform`, `currentPlatform(): DevicePlatform`

- [ ] **Step 1: Add the packages, pinned exactly.**
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/qr/apps/web && npm install --save-exact uqr@0.1.3 && npm install --save-exact --save-dev jsqr@1.4.0
  ```
  Expected: `package.json` gains `"uqr": "0.1.3"` under `dependencies` and `"jsqr": "1.4.0"`
  under `devDependencies`; nothing else in `package.json` moves.

- [ ] **Step 2: Write the failing tests.** `apps/web/src/lib/qr.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest'
  import jsQR from 'jsqr'
  import { qrMatrix, qrPath, qrRefusal } from './qr'

  /** Rasterise the module matrix (4 px a module) and read it back the way a phone camera does. */
  function decode(link: string): string | null {
    const m = qrMatrix(link)
    const scale = 4
    const w = m.size * scale
    const px = new Uint8ClampedArray(w * w * 4)
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const v = m.dark[Math.floor(y / scale)][Math.floor(x / scale)] ? 0 : 255
        const i = (y * w + x) * 4
        px[i] = v
        px[i + 1] = v
        px[i + 2] = v
        px[i + 3] = 255
      }
    }
    return jsQR(px, w, w)?.data ?? null
  }

  describe('qrMatrix', () => {
    it.each([
      'https://nova.fake-tailnet.ts.net/install',
      'https://nova.fake-tailnet.ts.net/app',
      'https://nova.fake-tailnet.ts.net/add#ABCD-2345',
    ])('decodes back to exactly %s', link => {
      expect(decode(link)).toBe(link)
    })

    it('keeps a four-module quiet zone of light modules on every edge', () => {
      const m = qrMatrix('https://nova.fake-tailnet.ts.net/install')
      for (let i = 0; i < m.size; i++) {
        for (const edge of [0, 1, 2, 3, m.size - 4, m.size - 3, m.size - 2, m.size - 1]) {
          expect(m.dark[edge][i]).toBe(false)
          expect(m.dark[i][edge]).toBe(false)
        }
      }
    })
  })

  describe('qrPath', () => {
    it('draws one unit square per dark module', () => {
      expect(qrPath({ size: 2, dark: [[true, false], [false, true]] })).toBe('M0 0h1v1h-1zM1 1h1v1h-1z')
    })
  })

  describe('qrRefusal', () => {
    it('accepts an https tailnet address', () => {
      expect(qrRefusal('https://nova.fake-tailnet.ts.net/add#ABCD-2345')).toBeNull()
    })
    it.each([
      ['http://nova.fake-tailnet.ts.net/install', 'https'],
      ['http://127.0.0.1:3000/install', 'https'],
      ['https://localhost/app', 'this machine only'],
      ['https://127.0.0.1/app', 'an IP address'],
      ['https://192.168.0.245/install', 'an IP address'],
      ['https://[::1]/add', 'an IP address'],
      ['not a link', 'not a link'],
    ])('refuses %s', (link, says) => {
      expect(qrRefusal(link)).toContain(says)
    })
  })
  ```
  `apps/web/src/components/QrCode.test.tsx`:
  ```tsx
  import { describe, it, expect } from 'vitest'
  import { render, screen } from '@testing-library/react'
  import { QrCode } from './QrCode'

  describe('QrCode', () => {
    it('draws the code dark on white and prints the link it encodes', () => {
      render(<QrCode link="https://nova.fake-tailnet.ts.net/install" />)
      const img = screen.getByRole('img')
      expect(img.getAttribute('aria-label')).toBe('QR code for https://nova.fake-tailnet.ts.net/install')
      expect(img.querySelector('rect')?.getAttribute('fill')).toBe('#ffffff')
      expect(img.querySelector('path')?.getAttribute('fill')).toBe('#000000')
      expect(screen.getByText('https://nova.fake-tailnet.ts.net/install')).toBeTruthy()
    })

    it('refuses loopback with the reason and draws nothing to scan', () => {
      render(<QrCode link="http://127.0.0.1:3000/install" />)
      expect(screen.getByRole('alert').textContent).toContain('only an https address')
      expect(screen.queryByRole('img')).toBeNull()
    })
  })
  ```
  `apps/web/src/lib/devicePlatform.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest'
  import { devicePlatform } from './devicePlatform'

  const UA = {
    iphoneSafari:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    iphoneChrome:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.101 Mobile/15E148 Safari/604.1',
    ipadDesktopMode:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
    androidChrome:
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    samsung:
      'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
    androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0',
    windowsChrome:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    windowsEdge:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
    windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
    linuxChrome:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    chromebook:
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  }

  describe('devicePlatform', () => {
    it.each([
      ['iphoneSafari', 0, 'ios', 'safari', true],
      ['iphoneChrome', 0, 'ios', 'chrome', true],
      ['ipadDesktopMode', 5, 'ios', 'safari', true],
      ['ipadDesktopMode', 0, 'mac', 'safari', false],
      ['androidChrome', 5, 'android', 'chrome', true],
      ['samsung', 5, 'android', 'samsung', true],
      ['androidFirefox', 5, 'android', 'firefox', true],
      ['windowsChrome', 0, 'windows', 'chrome', false],
      ['windowsEdge', 0, 'windows', 'edge', false],
      ['windowsFirefox', 0, 'windows', 'firefox', false],
      ['linuxChrome', 0, 'linux', 'chrome', false],
      ['chromebook', 0, 'chromeos', 'chrome', false],
    ] as const)('%s (touch %i) is %s / %s', (key, touch, os, browser, phone) => {
      expect(devicePlatform(UA[key], touch)).toEqual({ os, browser, phone })
    })

    it('never guesses: an agent it does not know is unknown', () => {
      expect(devicePlatform('curl/8.5.0')).toEqual({ os: 'unknown', browser: 'other', phone: false })
    })
  })
  ```

- [ ] **Step 3: Run them to see them fail.** `npm test -- qr QrCode devicePlatform`
  Expected: `Failed to resolve import "./qr"` (and the other two modules).

- [ ] **Step 4: Implement.** `apps/web/src/lib/qr.ts`:
  ```ts
  /**
   * QR codes for the setup links (S47).
   *
   * One pinned, zero-dependency encoder (uqr). Its module matrix is drawn by
   * QrCode.tsx as one SVG path, dark on a white tile in every theme: a phone
   * camera needs contrast, and a themed QR code is one nobody can scan.
   *
   * `qrRefusal` is the rule every QR code in Nova obeys (spec s47 §10): only an
   * https address with a DNS name. Loopback, any IP address and plain http open
   * nothing on another device — a phone cannot reach this machine's loopback and
   * cannot trust a certificate for an IP — so they are refused, with the reason,
   * instead of being drawn.
   */
  import { encode } from 'uqr'

  export interface QrMatrix {
    size: number
    dark: boolean[][]
  }

  export function qrMatrix(link: string): QrMatrix {
    const { size, data } = encode(link, { ecc: 'M', border: 4 })
    return { size, dark: data }
  }

  export function qrPath(m: QrMatrix): string {
    let d = ''
    for (let y = 0; y < m.size; y++) {
      for (let x = 0; x < m.size; x++) {
        if (m.dark[y][x]) d += `M${x} ${y}h1v1h-1z`
      }
    }
    return d
  }

  const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

  export function qrRefusal(link: string): string | null {
    let url: URL
    try {
      url = new URL(link)
    } catch {
      return 'not a link'
    }
    if (url.protocol !== 'https:') return 'only an https address opens on another device'
    const host = url.hostname.toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost')) return `${host} is this machine only`
    if (IPV4.test(host) || host.startsWith('[')) {
      return `${host} is an IP address, which a phone cannot trust and may not reach`
    }
    return null
  }
  ```
  `apps/web/src/components/QrCode.tsx`:
  ```tsx
  import { useMemo } from 'react'
  import { qrMatrix, qrPath, qrRefusal } from '../lib/qr'

  /** A setup link as a QR code (S47) — or the reason it cannot be one. */
  export function QrCode({ link, size = 208 }: { link: string; size?: number }) {
    const refusal = qrRefusal(link)
    const matrix = useMemo(() => (refusal === null ? qrMatrix(link) : null), [link, refusal])
    if (matrix === null) {
      return (
        <p
          role="alert"
          className="rounded-sm border border-warning/30 bg-warning/10 px-3 py-2 text-caption text-warning"
        >
          No QR code: {refusal}.
        </p>
      )
    }
    return (
      <figure className="flex flex-col items-center gap-2">
        <svg
          role="img"
          aria-label={`QR code for ${link}`}
          viewBox={`0 0 ${matrix.size} ${matrix.size}`}
          width={size}
          height={size}
          shapeRendering="crispEdges"
          className="rounded-md"
        >
          <rect width={matrix.size} height={matrix.size} fill="#ffffff" />
          <path d={qrPath(matrix)} fill="#000000" />
        </svg>
        <figcaption className="max-w-full break-all text-center font-mono text-mono-sm text-content-secondary">
          {link}
        </figcaption>
      </figure>
    )
  }
  ```
  `apps/web/src/lib/devicePlatform.ts`:
  ```ts
  /**
   * Which device opened a setup page (S47), from its user agent — the one place
   * this is decided. Detection is a heuristic, so it never guesses: an agent it
   * does not recognise is 'unknown', and a page shows every platform's steps.
   *
   * Order matters. iPadOS in desktop mode reports a Mac and only a touch screen
   * tells them apart. Edge and Samsung Internet both carry "Chrome/", and every
   * Chromium carries "Safari/", so the specific names are read first.
   */
  export type DeviceOS = 'ios' | 'android' | 'mac' | 'windows' | 'linux' | 'chromeos' | 'unknown'
  export type DeviceBrowser = 'safari' | 'chrome' | 'edge' | 'firefox' | 'samsung' | 'other'

  export interface DevicePlatform {
    os: DeviceOS
    browser: DeviceBrowser
    phone: boolean
  }

  function osOf(ua: string, maxTouchPoints: number): DeviceOS {
    if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
    if (/Macintosh/.test(ua) && maxTouchPoints > 1) return 'ios'
    if (/Android/.test(ua)) return 'android'
    if (/CrOS/.test(ua)) return 'chromeos'
    if (/Windows NT/.test(ua)) return 'windows'
    if (/Macintosh|Mac OS X/.test(ua)) return 'mac'
    if (/Linux|X11/.test(ua)) return 'linux'
    return 'unknown'
  }

  function browserOf(ua: string, os: DeviceOS): DeviceBrowser {
    if (/SamsungBrowser\//.test(ua)) return 'samsung'
    if (/EdgiOS\/|EdgA\/|Edg\//.test(ua)) return 'edge'
    if (/FxiOS\/|Firefox\//.test(ua)) return 'firefox'
    if (/CriOS\/|Chrome\//.test(ua)) return 'chrome'
    if (/Safari\//.test(ua) && (os === 'ios' || os === 'mac')) return 'safari'
    return 'other'
  }

  export function devicePlatform(ua: string, maxTouchPoints = 0): DevicePlatform {
    const os = osOf(ua, maxTouchPoints)
    return { os, browser: browserOf(ua, os), phone: os === 'ios' || os === 'android' }
  }

  export function currentPlatform(): DevicePlatform {
    if (typeof navigator === 'undefined') return { os: 'unknown', browser: 'other', phone: false }
    return devicePlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0)
  }
  ```

- [ ] **Step 5: Run them to see them pass, and typecheck.**
  `npm test -- qr QrCode devicePlatform && npx tsc --noEmit` — Expected: all pass, no type errors.

- [ ] **Step 6: Commit.**
  ```bash
  git -C /home/jeremy/workspace/nova/.worktrees/qr add apps/web/package.json apps/web/package-lock.json apps/web/src/lib/qr.ts apps/web/src/lib/qr.test.ts apps/web/src/components/QrCode.tsx apps/web/src/components/QrCode.test.tsx apps/web/src/lib/devicePlatform.ts apps/web/src/lib/devicePlatform.test.ts
  git -C /home/jeremy/workspace/nova/.worktrees/qr commit -m "feat(s47): a QR code component, and which device opened a page"
  git -C /home/jeremy/workspace/nova/.worktrees/qr show --stat HEAD
  ```

---

### Task 8: The setup panel, its words, and Settings → Devices

**Files:**
- Create: `apps/web/src/lib/setupSteps.ts`, `apps/web/src/lib/setupSteps.test.ts`
- Create: `apps/web/src/components/SetupPanel.tsx`, `apps/web/src/components/SetupPanel.test.tsx`
- Create: `apps/web/src/pages/settings/SetupModal.tsx`
- Create: `apps/web/src/pages/settings/AddToNovaSection.tsx`, `AddToNovaSection.test.tsx`
- Modify: `apps/web/src/lib/api.ts` (the devices block `:1118-1175`: `NetworkAddress`, `getNetworkAddress`)
- Modify: `apps/web/src/pages/settings/DevicesSection.tsx` (`DevicesApi` + `getNetworkAddress`;
  `PairingModal` → `SetupModal`), `DevicesSection.test.tsx` (`:23-45`, `:176-189`)
- Modify: `apps/web/src/pages/settings/SettingsPage.tsx:253`, `tabs.ts:41-45` (blurb),
  `tabs.test.tsx` (`:17-35` mock, `:48-54` `SECTIONS_BY_TAB`)

**Interfaces:**
- Consumes: `QrCode` (Task 7), `NATIVE_APP_LINKS` (Task 4), `enrollCommand(origin, code)`
  (`pages/settings/devicesFormat.ts:55-57`), `mintPairingCode()` (`lib/api.ts:1156`).
- Produces:
  - `type SetupKind = 'install_pwa' | 'get_app' | 'add_machine' | 'add_model_server'`,
    `SETUP_KINDS`, `isSetupKind(v)`, `isMachineSetup(s)`, `SETUP_TITLES`, `SETUP_BLURBS`
  - `setupLink(setup, address, code?): string`, `formatCode(code): string` (`ABCD-2345`),
    `parseCodeFragment(hash): string | null` (dashed, or null)
  - `TAILSCALE_DOWNLOAD`, `TAILSCALE_STEP`, `MODEL_SERVER_NOTE`, `NOVAD_README`, `AGENT_STEPS`
  - `interface Step { text: string; source?: string }`, `interface PlatformSteps { label: string; steps: Step[] }`,
    `installSteps(p: DevicePlatform): PlatformSteps[]`
  - `interface NetworkAddress { address: string | null; reason: string | null; read_at: string }`,
    `getNetworkAddress(): Promise<NetworkAddress>`
  - `<SetupPanel setup address reason? code? expiresAt? fallbackOrigin? compact? onNewCode? clock? />`
  - `<SetupModal setup={SetupKind | null} onClose api? />`, `interface SetupModalApi { getNetworkAddress; mintPairingCode }`
  - `<AddToNovaSection api? />` — `<Section title="Add to Nova">`

- [ ] **Step 1: The words, and their tests.** `apps/web/src/lib/setupSteps.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest'
  import { formatCode, installSteps, parseCodeFragment, setupLink } from './setupSteps'

  const ADDRESS = 'https://nova.fake-tailnet.ts.net'

  describe('parseCodeFragment (Review Focus 2)', () => {
    it.each([
      ['#ABCD-2345', 'ABCD-2345'],
      ['#abcd2345', 'ABCD-2345'],
      ['#ABCD-2345?x=1', 'ABCD-2345'],
      ['#code=ABCD2345', 'ABCD-2345'],
      ['#', null],
      ['', null],
      ['#garbage', null],
      ['#A1B2-C3D4', null],
      ['#%E0%A4%A', null],
    ])('%s -> %s', (hash, want) => {
      expect(parseCodeFragment(hash)).toBe(want)
    })
  })

  describe('setupLink', () => {
    it('puts a machine code in the fragment, dashed, and nowhere else', () => {
      expect(setupLink('add_machine', ADDRESS, 'abcd2345')).toBe(`${ADDRESS}/add#ABCD-2345`)
      expect(setupLink('add_model_server', ADDRESS, 'ABCD-2345')).toBe(`${ADDRESS}/add#ABCD-2345`)
      expect(setupLink('install_pwa', `${ADDRESS}/`, 'ABCD2345')).toBe(`${ADDRESS}/install`)
      expect(setupLink('get_app', ADDRESS)).toBe(`${ADDRESS}/app`)
    })
    it('formats a code the way it is read aloud', () => {
      expect(formatCode('abcd2345')).toBe('ABCD-2345')
      expect(formatCode('ABCD 2345')).toBe('ABCD-2345')
    })
  })

  describe('installSteps', () => {
    it('gives one list for a known platform and every list for an unknown one', () => {
      expect(installSteps({ os: 'ios', browser: 'safari', phone: true }).map(s => s.label)).toEqual([
        'iPhone or iPad, Safari',
      ])
      expect(installSteps({ os: 'windows', browser: 'firefox', phone: false })[0].label).toBe(
        'Windows, Firefox',
      )
      expect(installSteps({ os: 'unknown', browser: 'other', phone: false }).length).toBeGreaterThan(5)
    })
    it('cites where each named browser's wording was checked', () => {
      for (const list of installSteps({ os: 'unknown', browser: 'other', phone: false })) {
        if (list.label.endsWith('another browser')) continue
        expect(list.steps[0].source).toMatch(/^https:\/\//)
      }
    })
  })
  ```
  Then `apps/web/src/lib/setupSteps.ts`:
  ```ts
  /**
   * Every word a setup QR code puts in front of someone (S47), in one place, so
   * the Settings panels, her chat card and the public pages cannot drift apart —
   * and every install step carries the page its wording was checked against.
   */
  import type { DevicePlatform } from './devicePlatform'

  export type SetupKind = 'install_pwa' | 'get_app' | 'add_machine' | 'add_model_server'
  export const SETUP_KINDS: readonly SetupKind[] = ['add_machine', 'add_model_server', 'install_pwa', 'get_app']

  export function isSetupKind(value: unknown): value is SetupKind {
    return typeof value === 'string' && (SETUP_KINDS as readonly string[]).includes(value)
  }

  export function isMachineSetup(setup: SetupKind): boolean {
    return setup === 'add_machine' || setup === 'add_model_server'
  }

  export const SETUP_TITLES: Record<SetupKind, string> = {
    add_machine: 'A machine Nova controls',
    add_model_server: 'A model server',
    install_pwa: 'Nova on a phone',
    get_app: 'The Nova app',
  }

  export const SETUP_BLURBS: Record<SetupKind, string> = {
    add_machine: 'Pair a computer so Nova can act on it.',
    add_model_server: 'Pair a machine whose models Nova will use.',
    install_pwa: 'Put Nova on a phone’s home screen.',
    get_app: 'Send a phone to its app store.',
  }

  const PAGE: Record<SetupKind, string> = {
    install_pwa: '/install',
    get_app: '/app',
    add_machine: '/add',
    add_model_server: '/add',
  }

  export function formatCode(code: string): string {
    const clean = code.replace(/[\s-]/g, '').toUpperCase()
    return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
  }

  /** The link a setup's QR code encodes. A machine code rides the fragment, which a browser never sends. */
  export function setupLink(setup: SetupKind, address: string, code?: string | null): string {
    const base = `${address.replace(/\/+$/, '')}${PAGE[setup]}`
    return isMachineSetup(setup) && code ? `${base}#${formatCode(code)}` : base
  }

  // The pairing alphabet (services/core/app/devices.py, PAIRING_CODE_ALPHABET): no 0, 1, I, L, O.
  const CODE = /(?:^|[^A-Z0-9])([2-9A-HJKMNP-Z]{4})-?([2-9A-HJKMNP-Z]{4})(?![A-Z0-9])/

  export function parseCodeFragment(hash: string): string | null {
    let text: string
    try {
      text = decodeURIComponent(hash.replace(/^#/, ''))
    } catch {
      return null
    }
    const found = text.toUpperCase().match(CODE)
    return found ? `${found[1]}-${found[2]}` : null
  }

  export const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download'
  export const TAILSCALE_STEP =
    'First, the phone needs Tailscale, signed in to the same tailnet as Nova. Nova cannot check this from here: if the page opens on the phone, it is.'
  export const MODEL_SERVER_NOTE =
    'Serving this machine’s models arrives with S44. Until then, this pairs it as a machine Nova controls.'
  export const NOVAD_README = 'https://github.com/jeremyspofford/nova/blob/main/apps/novad/README.md'

  export const AGENT_STEPS = {
    install: {
      text: 'Install Nova’s agent, novad, first: build it as its README says. A one-line installer replaces this step later.',
      source: NOVAD_README,
    },
    enroll: 'Then run this on the machine:',
    run: 'Then start it with novad run. The README shows how to keep it running as a user service.',
    unsupported: 'Nova’s agent runs on Linux today. Windows and macOS arrive with S42a.',
    phone: 'Open this on the computer you’re adding.',
    phoneSelf: 'Adding this phone itself needs the Nova app, which doesn’t exist yet.',
  } as const

  export interface Step {
    text: string
    /** Where the wording was checked — shown to nobody, pinned by a test. */
    source?: string
  }

  export interface PlatformSteps {
    label: string
    steps: Step[]
  }

  const APPLE_WEB_APP = 'https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios'
  const CHROME_IOS = 'https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DiOS'
  const CHROME_ANDROID = 'https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid'
  const CHROME_DESKTOP = 'https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DDesktop'
  const EDGE = 'https://learn.microsoft.com/microsoft-edge/progressive-web-apps/ux'
  const SAFARI_MAC = 'https://support.apple.com/en-us/104996'
  const FIREFOX_WINDOWS = 'https://support.mozilla.org/kb/web-apps-firefox-windows'
  const FIREFOX_ANDROID = 'https://support.mozilla.org/kb/add-web-page-shortcuts-your-home-screen'
  const SAMSUNG = 'https://www.samsung.com/uk/support/mobile-devices/how-to-add-website-shortcuts-to-the-home-screen/'

  const INSTALL: Record<string, PlatformSteps> = {
    ios_safari: {
      label: 'iPhone or iPad, Safari',
      steps: [
        { text: 'Tap Share (the square with an arrow).', source: APPLE_WEB_APP },
        { text: 'Tap Add to Home Screen.' },
        { text: 'Leave Open as Web App on, then tap Add.' },
      ],
    },
    ios_chrome: {
      label: 'iPhone or iPad, Chrome',
      steps: [
        { text: 'Tap Share, at the right of the address bar.', source: CHROME_IOS },
        { text: 'Tap Add to Home Screen.' },
        { text: 'Leave Open as Web App on, then tap Add.' },
      ],
    },
    ios_other: {
      label: 'iPhone or iPad, another browser',
      steps: [{ text: 'Tap the browser’s Share button, then Add to Home Screen. If it has none, open this page in Safari.' }],
    },
    android_chrome: {
      label: 'Android, Chrome',
      steps: [
        { text: 'Tap the menu (three dots).', source: CHROME_ANDROID },
        { text: 'Tap Add to home screen, then Install.' },
      ],
    },
    android_samsung: {
      label: 'Android, Samsung Internet',
      steps: [
        { text: 'Tap the menu (three lines).', source: SAMSUNG },
        { text: 'Tap Add page to, then Home screen.' },
      ],
    },
    android_firefox: {
      label: 'Android, Firefox',
      steps: [
        { text: 'Tap the menu (three dots).', source: FIREFOX_ANDROID },
        { text: 'Tap Add app to Home screen.' },
      ],
    },
    android_other: {
      label: 'Android, another browser',
      steps: [{ text: 'Open the browser’s menu and choose Install app or Add to Home screen.' }],
    },
    desktop_chrome: {
      label: 'A computer, Chrome',
      steps: [
        {
          text: 'Click the install icon at the right of the address bar. If there is none: the menu (three dots), Cast, save, and share, Install page as app.',
          source: CHROME_DESKTOP,
        },
      ],
    },
    desktop_edge: {
      label: 'A computer, Edge',
      steps: [{ text: 'Click Settings and more (…), then Apps, then Install this site as an app.', source: EDGE }],
    },
    mac_safari: {
      label: 'A Mac, Safari',
      steps: [{ text: 'Choose File, then Add to Dock.', source: SAFARI_MAC }],
    },
    windows_firefox: {
      label: 'Windows, Firefox',
      steps: [{ text: 'Click Add tab to taskbar, in the address bar.', source: FIREFOX_WINDOWS }],
    },
    desktop_firefox: {
      label: 'A computer, Firefox',
      steps: [
        {
          text: 'Firefox cannot install a site on this system: bookmark this page, or open it in Chrome or Edge to install it.',
          source: FIREFOX_WINDOWS,
        },
      ],
    },
    desktop_other: {
      label: 'A computer, another browser',
      steps: [{ text: 'Bookmark this page, or open it in Chrome or Edge to install it.' }],
    },
  }

  function installKey({ os, browser }: DevicePlatform): string | null {
    if (os === 'ios') return browser === 'safari' ? 'ios_safari' : browser === 'chrome' ? 'ios_chrome' : 'ios_other'
    if (os === 'android') {
      if (browser === 'chrome') return 'android_chrome'
      if (browser === 'samsung') return 'android_samsung'
      if (browser === 'firefox') return 'android_firefox'
      return 'android_other'
    }
    if (os === 'unknown') return null
    if (browser === 'chrome') return 'desktop_chrome'
    if (browser === 'edge') return 'desktop_edge'
    if (browser === 'safari' && os === 'mac') return 'mac_safari'
    if (browser === 'firefox') return os === 'windows' ? 'windows_firefox' : 'desktop_firefox'
    return 'desktop_other'
  }

  export function installSteps(platform: DevicePlatform): PlatformSteps[] {
    const key = installKey(platform)
    return key ? [INSTALL[key]] : Object.values(INSTALL)
  }
  ```
  **Verify the wording now** (spec §5: checked against each vendor's current page when built):
  fetch each `source` URL above and compare every step's words with what the page says today.
  Fix any wording that changed; if a URL moved, use the page it moved to; if Samsung's page
  cannot be found, remove its `source` and move the row's label to end with "another browser"
  so the citation test skips it honestly. Record the date checked in the file's comment.

- [ ] **Step 2: The panel, and its tests.** `apps/web/src/components/SetupPanel.test.tsx`:
  ```tsx
  import { describe, it, expect, vi } from 'vitest'
  import { fireEvent, render, screen } from '@testing-library/react'
  import { SetupPanel } from './SetupPanel'

  const ADDRESS = 'https://nova.fake-tailnet.ts.net'
  const EXPIRES = '2026-09-25T14:10:00Z'
  const BEFORE = () => new Date('2026-09-25T14:05:00Z')
  const AFTER = () => new Date('2026-09-25T14:11:00Z')

  describe('SetupPanel', () => {
    it('encodes the derived address, never the origin this page was opened at (Review Focus 1)', () => {
      render(<SetupPanel setup="install_pwa" address={ADDRESS} />)
      const label = screen.getByRole('img').getAttribute('aria-label')
      expect(label).toBe(`QR code for ${ADDRESS}/install`)
      expect(label).not.toContain(window.location.host)
      expect(screen.getByText(/signed in to the same tailnet/)).toBeTruthy()
    })

    it('states why there is no QR code', () => {
      render(<SetupPanel setup="install_pwa" address={null} reason="the tailnet sidecar is NeedsLogin, not Running" />)
      expect(screen.getByRole('alert').textContent).toContain('NeedsLogin')
      expect(screen.queryByRole('img')).toBeNull()
    })

    it('a machine setup shows the QR, the code and the command, all on the derived address', () => {
      render(<SetupPanel setup="add_machine" address={ADDRESS} code="ABCD2345" expiresAt={EXPIRES} clock={BEFORE} />)
      expect(screen.getByRole('img').getAttribute('aria-label')).toBe(`QR code for ${ADDRESS}/add#ABCD-2345`)
      expect(screen.getByTestId('setup-code').textContent).toBe('ABCD-2345')
      expect(screen.getByText(`novad enroll --server ${ADDRESS} --code ABCD-2345`)).toBeTruthy()
      expect(screen.getByText(/5:00 left/)).toBeTruthy()
    })

    it('an expired code draws nothing to scan and offers a new one', () => {
      const onNewCode = vi.fn()
      render(
        <SetupPanel setup="add_machine" address={ADDRESS} code="ABCD2345" expiresAt={EXPIRES} clock={AFTER} onNewCode={onNewCode} />,
      )
      expect(screen.queryByRole('img')).toBeNull()
      expect(screen.queryByText(/novad enroll/)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'New code' }))
      expect(onNewCode).toHaveBeenCalledTimes(1)
    })

    it('a reloaded machine card has no code, no QR and no command (Review Focus 4)', () => {
      render(<SetupPanel setup="add_machine" address={ADDRESS} code={null} expiresAt={EXPIRES} clock={BEFORE} />)
      expect(screen.getByTestId('setup-shown-once').textContent).toContain('shown once and expires')
      expect(screen.queryByRole('img')).toBeNull()
      expect(screen.queryByTestId('setup-code')).toBeNull()
      expect(screen.queryByText(/novad enroll/)).toBeNull()
    })

    it('a model server says what is not built yet', () => {
      render(<SetupPanel setup="add_model_server" address={ADDRESS} code="ABCD2345" expiresAt={EXPIRES} clock={BEFORE} />)
      expect(screen.getByText(/arrives with S44/)).toBeTruthy()
    })

    it('the app setup says there is no app yet', () => {
      render(<SetupPanel setup="get_app" address={ADDRESS} />)
      expect(screen.getByRole('img').getAttribute('aria-label')).toBe(`QR code for ${ADDRESS}/app`)
      expect(screen.getByText(/no Nova app yet/)).toBeTruthy()
    })

    it('with no address, a machine setup still gives the command for a machine that reaches this page', () => {
      render(
        <SetupPanel setup="add_machine" address={null} reason="no status" code="ABCD2345" expiresAt={EXPIRES} clock={BEFORE} fallbackOrigin="http://127.0.0.1:3000" />,
      )
      expect(screen.queryByRole('img')).toBeNull()
      expect(screen.getByText('novad enroll --server http://127.0.0.1:3000 --code ABCD-2345')).toBeTruthy()
    })
  })
  ```
  Then `apps/web/src/components/SetupPanel.tsx`:
  ```tsx
  import { useEffect, useState } from 'react'
  import { Copy } from 'lucide-react'
  import clsx from 'clsx'
  import { Button } from './ui'
  import { QrCode } from './QrCode'
  import { NATIVE_APP_LINKS } from '../lib/nativeApp'
  import {
    AGENT_STEPS,
    MODEL_SERVER_NOTE,
    NOVAD_README,
    TAILSCALE_DOWNLOAD,
    TAILSCALE_STEP,
    formatCode,
    isMachineSetup,
    setupLink,
    type SetupKind,
  } from '../lib/setupSteps'
  import { enrollCommand } from '../pages/settings/devicesFormat'

  /**
   * One setup's QR code and steps (S47) — the same panel in Settings and in her
   * chat card. The QR code only ever encodes `address`, the derived address core
   * states; `fallbackOrigin` (this browser's own origin) may appear in a COMMAND
   * for a machine that reaches the same page, never in a QR code.
   */
  export interface SetupPanelProps {
    setup: SetupKind
    address: string | null
    reason?: string | null
    /** A machine setup's live code. Absent on a reloaded card: a code is shown once. */
    code?: string | null
    expiresAt?: string | null
    fallbackOrigin?: string | null
    compact?: boolean
    onNewCode?: () => void
    clock?: () => Date
  }

  const systemClock = () => new Date()

  function useNow(enabled: boolean, clock: () => Date): Date {
    const [now, setNow] = useState(() => clock())
    useEffect(() => {
      setNow(clock())
      if (!enabled) return
      const id = window.setInterval(() => setNow(clock()), 1000)
      return () => window.clearInterval(id)
    }, [enabled, clock])
    return now
  }

  function clockTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  function remaining(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }

  /** A command with a Copy button that says whether the copy happened. No button
   *  where the browser has no clipboard (an http page): a button that cannot work
   *  is not shown. `/add` uses it too (Task 9). */
  export function CopyLine({ value, label }: { value: string; label: string }) {
    const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    return (
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-sm bg-surface-elevated px-3 py-2 font-mono text-mono-sm text-content-primary">
          {value}
        </code>
        {clipboard && (
          <Button
            size="sm"
            variant="secondary"
            icon={<Copy size={12} />}
            aria-label={`Copy ${label}`}
            onClick={() => clipboard.writeText(value).then(() => setState('copied'), () => setState('failed'))}
          >
            {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
          </Button>
        )}
      </div>
    )
  }

  export function SetupPanel({
    setup,
    address,
    reason,
    code,
    expiresAt,
    fallbackOrigin,
    compact = false,
    onNewCode,
    clock = systemClock,
  }: SetupPanelProps) {
    const machine = isMachineSetup(setup)
    const live = machine && Boolean(code)
    const now = useNow(live && Boolean(expiresAt), clock)
    const expired = Boolean(expiresAt) && new Date(expiresAt as string).getTime() <= now.getTime()
    const link = address ? setupLink(setup, address, live ? code : null) : null
    const commandOrigin = address ?? fallbackOrigin ?? null
    const phoneSetup = setup === 'install_pwa' || setup === 'get_app'
    const hasApp = Boolean(NATIVE_APP_LINKS.ios || NATIVE_APP_LINKS.android)
    return (
      <div
        data-testid="setup-panel"
        data-setup={setup}
        className={clsx('space-y-3 text-content-secondary', compact ? 'text-caption' : 'text-compact')}
      >
        {phoneSetup && (
          <p>
            {TAILSCALE_STEP}{' '}
            <a className="text-accent underline" href={TAILSCALE_DOWNLOAD} target="_blank" rel="noreferrer">
              Get Tailscale
            </a>
          </p>
        )}
        {address === null && (
          <p role="alert" className="rounded-sm border border-warning/30 bg-warning/10 px-3 py-2 text-caption text-warning">
            No QR code: {reason ?? 'Nova has no address another device can reach.'}
          </p>
        )}
        {machine && !live && (
          <p data-testid="setup-shown-once">
            {expiresAt
              ? `The code was shown once and ${expired ? 'expired' : 'expires'} at ${clockTime(expiresAt)}. Ask Nova for a new one.`
              : 'The code was shown once. Ask Nova for a new one.'}
          </p>
        )}
        {link && (!machine || (live && !expired)) && <QrCode link={link} size={compact ? 160 : 208} />}
        {setup === 'install_pwa' && link && (
          <p>Scan this with the phone, or open the link on it. The page shows that phone’s own steps.</p>
        )}
        {setup === 'get_app' && link && (
          <p>
            {hasApp
              ? 'Scan this with a phone: it opens that phone’s app store.'
              : 'There’s no Nova app yet. Scanning this with a phone opens the web app’s install steps instead.'}
          </p>
        )}
        {live && code && (
          <div className="space-y-2">
            <div className="text-center">
              <div
                data-testid="setup-code"
                className={clsx('font-mono tracking-[0.2em] text-content-primary', compact ? 'text-h2' : 'text-h1')}
              >
                {formatCode(code)}
              </div>
              {expiresAt && (
                <p className="mt-1 text-caption text-content-tertiary">
                  {expired
                    ? `Expired at ${clockTime(expiresAt)}.`
                    : `Works once. Expires at ${clockTime(expiresAt)} (${remaining(new Date(expiresAt).getTime() - now.getTime())} left).`}
                </p>
              )}
              {expired && onNewCode && (
                <Button size="sm" variant="secondary" onClick={onNewCode} className="mt-2">
                  New code
                </Button>
              )}
            </div>
            {commandOrigin && !expired && (
              <div>
                <p className="mb-1.5 text-caption font-medium">
                  {address
                    ? 'On the machine you are adding (Linux today), once Nova’s agent is installed:'
                    : `From a machine that reaches Nova at ${commandOrigin}:`}
                </p>
                <CopyLine value={enrollCommand(commandOrigin, formatCode(code))} label="the command" />
              </div>
            )}
            <p className="text-caption">
              {AGENT_STEPS.install.text}{' '}
              <a className="text-accent underline" href={NOVAD_README} target="_blank" rel="noreferrer">
                novad’s README
              </a>
            </p>
          </div>
        )}
        {setup === 'add_model_server' && <p>{MODEL_SERVER_NOTE}</p>}
      </div>
    )
  }
  ```

- [ ] **Step 3: The address call, the modal, the section, and their tests.** In `lib/api.ts`,
  in the devices block:
  ```ts
  /** Nova's address for another device, as core's one reader states it now (S47). */
  export interface NetworkAddress {
    address: string | null
    reason: string | null
    read_at: string
  }

  export const getNetworkAddress = () => apiGet<NetworkAddress>('/api/v1/network/address')
  ```
  `apps/web/src/pages/settings/SetupModal.tsx`:
  ```tsx
  import { useEffect, useState } from 'react'
  import { Modal, Skeleton } from '../../components/ui'
  import { SetupPanel } from '../../components/SetupPanel'
  import {
    getNetworkAddress as apiGetNetworkAddress,
    mintPairingCode as apiMintPairingCode,
    type NetworkAddress,
    type PairingCode,
  } from '../../lib/api'
  import { isMachineSetup, SETUP_TITLES, type SetupKind } from '../../lib/setupSteps'

  /**
   * One setup, opened from Settings (S47). It reads the derived address every time
   * it opens and mints a code only for a machine setup — the same two calls, in
   * the same order, whichever button opened it ("Pair a device" or a tile).
   */
  export interface SetupModalApi {
    getNetworkAddress: typeof apiGetNetworkAddress
    mintPairingCode: typeof apiMintPairingCode
  }

  export const DEFAULT_SETUP_API: SetupModalApi = {
    getNetworkAddress: apiGetNetworkAddress,
    mintPairingCode: apiMintPairingCode,
  }

  type Loaded =
    | { status: 'loading' }
    | { status: 'error'; reason: string }
    | { status: 'ready'; address: NetworkAddress; code: PairingCode | null }

  function reasonOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  export function SetupModal({
    setup,
    onClose,
    api = DEFAULT_SETUP_API,
  }: {
    setup: SetupKind | null
    onClose: () => void
    api?: SetupModalApi
  }) {
    const [state, setState] = useState<Loaded>({ status: 'loading' })
    const [attempt, setAttempt] = useState(0)

    useEffect(() => {
      if (setup === null) return
      let live = true
      setState({ status: 'loading' })
      Promise.all([api.getNetworkAddress(), isMachineSetup(setup) ? api.mintPairingCode() : Promise.resolve(null)])
        .then(([address, code]) => {
          if (live) setState({ status: 'ready', address, code })
        })
        .catch(err => {
          if (live) setState({ status: 'error', reason: reasonOf(err) })
        })
      return () => {
        live = false
      }
    }, [setup, api, attempt])

    const title = setup ? SETUP_TITLES[setup] : ''
    return (
      <Modal open={setup !== null} onClose={onClose} size="md" title={title}>
        <div role="dialog" aria-label={title} className="space-y-4">
          {state.status === 'loading' && <Skeleton lines={3} />}
          {state.status === 'error' && (
            <div role="alert" className="rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-caption text-danger">
              Could not prepare this: {state.reason}
            </div>
          )}
          {state.status === 'ready' && setup !== null && (
            <SetupPanel
              setup={setup}
              address={state.address.address}
              reason={state.address.reason}
              code={state.code?.code ?? null}
              expiresAt={state.code?.expires_at ?? null}
              fallbackOrigin={window.location.origin}
              onNewCode={() => setAttempt(n => n + 1)}
            />
          )}
        </div>
      </Modal>
    )
  }
  ```
  `apps/web/src/pages/settings/AddToNovaSection.tsx`:
  ```tsx
  import { useState } from 'react'
  import { AppWindow, Laptop, QrCode as QrIcon, Server, Smartphone } from 'lucide-react'
  import { Section } from '../../components/ui'
  import { SETUP_BLURBS, SETUP_KINDS, SETUP_TITLES, type SetupKind } from '../../lib/setupSteps'
  import { SetupModal, type SetupModalApi } from './SetupModal'

  const ICONS: Record<SetupKind, React.ElementType> = {
    add_machine: Laptop,
    add_model_server: Server,
    install_pwa: Smartphone,
    get_app: AppWindow,
  }

  /** Settings → Devices, first (S47): a QR code for each of the four setups. */
  export function AddToNovaSection({ api }: { api?: SetupModalApi }) {
    const [open, setOpen] = useState<SetupKind | null>(null)
    return (
      <Section
        icon={QrIcon}
        title="Add to Nova"
        description="A QR code for each setup: scan it with a phone, or open its link on the machine you are adding."
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SETUP_KINDS.map(kind => {
            const Icon = ICONS[kind]
            return (
              <button
                key={kind}
                type="button"
                data-testid={`setup-tile-${kind}`}
                onClick={() => setOpen(kind)}
                className="flex items-start gap-3 rounded-md border border-border bg-surface-card p-3 text-left transition-colors hover:border-border-focus"
              >
                <Icon size={18} className="mt-0.5 shrink-0 text-accent" />
                <span className="min-w-0">
                  <span className="block text-compact font-medium text-content-primary">{SETUP_TITLES[kind]}</span>
                  <span className="block text-caption text-content-secondary">{SETUP_BLURBS[kind]}</span>
                </span>
              </button>
            )
          })}
        </div>
        <SetupModal setup={open} onClose={() => setOpen(null)} api={api} />
      </Section>
    )
  }
  ```
  `apps/web/src/pages/settings/AddToNovaSection.test.tsx`:
  ```tsx
  import { describe, it, expect, vi } from 'vitest'
  import { fireEvent, render, screen, within } from '@testing-library/react'
  import { AddToNovaSection } from './AddToNovaSection'

  const ADDRESS = { address: 'https://nova.fake-tailnet.ts.net', reason: null, read_at: '2026-09-25T14:00:00Z' }

  function renderSection(over: Record<string, unknown> = {}) {
    const api = {
      getNetworkAddress: vi.fn(async () => ADDRESS),
      mintPairingCode: vi.fn(async () => ({
        code: 'ABCD2345',
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })),
      ...over,
    }
    render(<AddToNovaSection api={api as never} />)
    return api
  }

  describe('AddToNovaSection', () => {
    it('offers the four setups', () => {
      renderSection()
      for (const name of [/A machine Nova controls/, /A model server/, /Nova on a phone/, /The Nova app/]) {
        expect(screen.getByRole('button', { name })).toBeTruthy()
      }
    })

    it('a machine tile reads the address and mints exactly one code', async () => {
      const api = renderSection()
      fireEvent.click(screen.getByRole('button', { name: /A machine Nova controls/ }))
      const dialog = await screen.findByRole('dialog')
      expect((await within(dialog).findByTestId('setup-code')).textContent).toBe('ABCD-2345')
      expect(api.getNetworkAddress).toHaveBeenCalledTimes(1)
      expect(api.mintPairingCode).toHaveBeenCalledTimes(1)
    })

    it('a phone tile mints nothing', async () => {
      const api = renderSection()
      fireEvent.click(screen.getByRole('button', { name: /Nova on a phone/ }))
      const dialog = await screen.findByRole('dialog')
      const qr = await within(dialog).findByRole('img')
      expect(qr.getAttribute('aria-label')).toBe('QR code for https://nova.fake-tailnet.ts.net/install')
      expect(api.mintPairingCode).not.toHaveBeenCalled()
    })

    it('an address that cannot be read is stated, not guessed', async () => {
      renderSection({ getNetworkAddress: vi.fn(async () => Promise.reject(new Error('Nova did not answer'))) })
      fireEvent.click(screen.getByRole('button', { name: /The Nova app/ }))
      const dialog = await screen.findByRole('dialog')
      expect((await within(dialog).findByRole('alert')).textContent).toContain('Nova did not answer')
    })
  })
  ```

- [ ] **Step 4: Rewire "Pair a device", the tab, and their tests.**
  - `DevicesSection.tsx`: add `getNetworkAddress: typeof apiGetNetworkAddress` to `DevicesApi`
    and `DEFAULT_API` (import it from `lib/api`); replace
    `<PairingModal open={pairingOpen} onClose={closePairing} api={api} />` with
    `<SetupModal setup={pairingOpen ? 'add_machine' : null} onClose={closePairing} api={api} />`;
    delete `PairingModal`, `PairingState` and the now-unused imports (`Copy`, `Modal`,
    `enrollCommand`, `PairingCode` if unused). Update the component's doc comment: pairing now
    opens the S47 machine setup (QR code, code and command on the derived address).
  - `DevicesSection.test.tsx`: add `getNetworkAddress: vi.fn(async () => ({ address: 'https://nova.fake-tailnet.ts.net', reason: null, read_at: new Date().toISOString() }))`
    to the `full` defaults and its `Partial` type (`:24-43`); rewrite the pairing test
    (`:176-189`) to assert, inside the dialog, `getByTestId('setup-code').textContent === 'A1B2-C3D4'`
    and the text `novad enroll --server https://nova.fake-tailnet.ts.net --code A1B2-C3D4`, and
    rename it "the pairing modal mints a code and shows it with the command on Nova's derived address".
  - `SettingsPage.tsx:253`: `{tab === 'devices' && (<><AddToNovaSection /><DevicesSection /></>)}`.
  - `tabs.ts:41-45`: the devices blurb becomes `'Add machines and phones to Nova, and the machines paired to it.'`.
  - `tabs.test.tsx`: `SECTIONS_BY_TAB.devices` becomes `['Add to Nova', 'Devices']`; add
    `getNetworkAddress: vi.fn(async () => ({ address: null, reason: 'not in a test', read_at: '2026-09-25T14:00:00Z' }))`
    and `mintPairingCode: vi.fn()` to the `vi.mock('../../lib/api', …)` block (`:17-35`) if they
    are not already there.

- [ ] **Step 5: Run them, then every settings suite, then typecheck.**
  `npm test -- setupSteps SetupPanel AddToNovaSection DevicesSection tabs SettingsPage && npx tsc --noEmit`
  Expected: all pass, no type errors.

- [ ] **Step 6: Commit.**
  ```bash
  git -C /home/jeremy/workspace/nova/.worktrees/qr add apps/web/src/lib/setupSteps.ts apps/web/src/lib/setupSteps.test.ts apps/web/src/components/SetupPanel.tsx apps/web/src/components/SetupPanel.test.tsx apps/web/src/pages/settings/SetupModal.tsx apps/web/src/pages/settings/AddToNovaSection.tsx apps/web/src/pages/settings/AddToNovaSection.test.tsx apps/web/src/lib/api.ts apps/web/src/pages/settings/DevicesSection.tsx apps/web/src/pages/settings/DevicesSection.test.tsx apps/web/src/pages/settings/SettingsPage.tsx apps/web/src/pages/settings/tabs.ts apps/web/src/pages/settings/tabs.test.tsx
  git -C /home/jeremy/workspace/nova/.worktrees/qr commit -m "feat(s47): Settings -> Devices hands out a QR code for each setup"
  git -C /home/jeremy/workspace/nova/.worktrees/qr show --stat HEAD
  ```

---

### Task 9: The pages a scanned code opens — `/install`, `/app`, `/add`

**Files:**
- Create: `apps/web/src/pages/public/PublicShell.tsx`, `InstallSteps.tsx`, `InstallPage.tsx`,
  `AppPage.tsx`, `AddPage.tsx`, `publicPages.test.tsx`
- Modify: `apps/web/src/App.tsx` (the `App` default export: public routes ahead of the gate)
- Modify: `apps/web/src/App.test.tsx` (+1 parametrised test)

**Interfaces:**
- Consumes: `currentPlatform`, `DevicePlatform` (Task 7); `installSteps`, `parseCodeFragment`,
  `AGENT_STEPS`, `NOVAD_README` (Task 8); `CopyLine` (Task 8, `components/SetupPanel.tsx`);
  `NATIVE_APP_LINKS` (Task 4); `installedApp()` (`lib/safeArea.ts:42-49`);
  `enrollCommand` (`pages/settings/devicesFormat.ts:55-57`).
- Produces: `<InstallPage platform? installed? />`, `<AppPage platform? links? go? />`,
  `<AddPage platform? hash? origin? share? />` — every browser fact injectable, so no test
  stubs a global it does not have to.

- [ ] **Step 1: Write the failing tests** — `apps/web/src/pages/public/publicPages.test.tsx`:
  ```tsx
  import { describe, it, expect, vi, afterEach } from 'vitest'
  import { fireEvent, render, screen } from '@testing-library/react'
  import { InstallPage } from './InstallPage'
  import { AppPage } from './AppPage'
  import { AddPage } from './AddPage'

  const ORIGIN = 'https://nova.fake-tailnet.ts.net'
  const IPHONE = { os: 'ios', browser: 'safari', phone: true } as const
  const ANDROID = { os: 'android', browser: 'chrome', phone: true } as const
  const LINUX = { os: 'linux', browser: 'chrome', phone: false } as const
  const WINDOWS = { os: 'windows', browser: 'chrome', phone: false } as const
  const UNKNOWN = { os: 'unknown', browser: 'other', phone: false } as const

  afterEach(() => vi.unstubAllGlobals())

  describe('InstallPage', () => {
    it("shows this device its own steps and no one else's", () => {
      render(<InstallPage platform={IPHONE} installed={false} />)
      expect(screen.getByText('Tap Add to Home Screen.')).toBeTruthy()
      expect(screen.queryByText('Choose File, then Add to Dock.')).toBeNull()
    })
    it("an unknown device gets every platform's steps", () => {
      render(<InstallPage platform={UNKNOWN} installed={false} />)
      expect(screen.getByText('iPhone or iPad, Safari')).toBeTruthy()
      expect(screen.getByText('Android, Chrome')).toBeTruthy()
    })
    it('inside the installed app, says so', () => {
      render(<InstallPage platform={IPHONE} installed />)
      expect(screen.getByText('Nova is already installed on this device.')).toBeTruthy()
    })
    it('scrolls itself, because the document never does (index.css)', () => {
      render(<InstallPage platform={UNKNOWN} installed={false} />)
      expect(screen.getByTestId('public-shell').className).toContain('overflow-y-auto')
      expect(screen.getByTestId('public-shell').className).toContain('fixed')
    })
  })

  describe('AppPage', () => {
    it('with no app, an iPhone is told so and is never sent anywhere', () => {
      const go = vi.fn()
      render(<AppPage platform={IPHONE} links={{ ios: null, android: null }} go={go} />)
      expect(screen.getByText('There’s no Nova app for iPhone yet.')).toBeTruthy()
      expect(screen.getByText('Tap Add to Home Screen.')).toBeTruthy()
      expect(go).not.toHaveBeenCalled()
    })
    it('once a store link exists, a phone is sent to its own store', () => {
      const go = vi.fn()
      render(
        <AppPage
          platform={ANDROID}
          links={{ ios: 'https://apps.apple.com/app/id1', android: 'https://play.google.com/store/apps/details?id=x' }}
          go={go}
        />,
      )
      expect(go).toHaveBeenCalledWith('https://play.google.com/store/apps/details?id=x')
    })
    it('a computer is told the app is for phones', () => {
      render(<AppPage platform={WINDOWS} links={{ ios: null, android: null }} go={vi.fn()} />)
      expect(screen.getByText('The Nova app is for phones.')).toBeTruthy()
    })
  })

  describe('AddPage', () => {
    it('reads a lowercase code from the link and shows it the way it is read (Review Focus 2)', () => {
      render(<AddPage platform={LINUX} hash="#abcd2345" origin={ORIGIN} share={undefined} />)
      expect(screen.getByTestId('add-code').textContent).toBe('ABCD-2345')
      expect(screen.getByText(`novad enroll --server ${ORIGIN} --code ABCD-2345`)).toBeTruthy()
    })
    it('asks for the code when the link carries none, and never calls the server', () => {
      const fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)
      render(<AddPage platform={LINUX} hash="" origin={ORIGIN} share={undefined} />)
      fireEvent.change(screen.getByLabelText('The code Nova showed you'), { target: { value: 'k7pq9xyz' } })
      expect(screen.getByTestId('add-code').textContent).toBe('K7PQ-9XYZ')
      expect(fetchSpy).not.toHaveBeenCalled()
    })
    it('on a phone: open it on the computer, with Share only where sharing exists (Review Focus 5)', () => {
      const share = vi.fn(async () => {})
      const { unmount } = render(<AddPage platform={ANDROID} hash="#ABCD-2345" origin={ORIGIN} share={share} />)
      expect(screen.getByText('Open this on the computer you’re adding.')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: /Share this link/ }))
      expect(share).toHaveBeenCalledWith({ title: 'Add a machine to Nova', url: `${ORIGIN}/add#ABCD-2345` })
      unmount()
      render(<AddPage platform={ANDROID} hash="#ABCD-2345" origin={ORIGIN} share={undefined} />)
      expect(screen.queryByRole('button', { name: /Share/ })).toBeNull()
    })
    it('on Windows, says the agent is Linux-only today', () => {
      render(<AddPage platform={WINDOWS} hash="#ABCD-2345" origin={ORIGIN} share={undefined} />)
      expect(screen.getByText('Nova’s agent runs on Linux today. Windows and macOS arrive with S42a.')).toBeTruthy()
    })
  })
  ```
  And in `apps/web/src/App.test.tsx`, a new `describe` after `describe('App gate', …)`:
  ```tsx
  describe('the setup pages (S47)', () => {
    it.each([
      ['/install', 'Nova on this device'],
      ['/app', 'The Nova app'],
      ['/add', 'Add a machine to Nova'],
    ])('%s opens before the sign-in gate and asks the server nothing', async (path, heading) => {
      const fetchMock = mockApi({})
      window.history.pushState({}, '', path)
      render(<App />)
      expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeTruthy()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
  ```

- [ ] **Step 2: Run them to see them fail.** `npm test -- publicPages App.test`
  Expected: `Failed to resolve import "./InstallPage"`; the App test finds the login gate
  instead of the heading.

- [ ] **Step 3: Implement.** `apps/web/src/pages/public/PublicShell.tsx`:
  ```tsx
  import clsx from 'clsx'
  import { useTheme } from '../../stores/theme-store'
  import { appIcon, appIconHref } from '../../lib/app-icon'

  /**
   * The frame of a page a scanned setup QR code opens, before anyone signs in
   * (S47): the brand mark and one card, like the sign-in page. The document never
   * scrolls (index.css), so this is a fixed box that scrolls itself — a phone's
   * steps can be taller than its screen — padded by the safe-area insets, never
   * sized from a height.
   */
  export function PublicShell({ title, children }: { title: string; children: React.ReactNode }) {
    const { brandIcon, mode, preset, customAccent } = useTheme()
    return (
      <div
        data-testid="public-shell"
        className="fixed inset-0 overflow-y-auto bg-surface-root px-4 pb-[calc(2.5rem+var(--nova-safe-bottom,0px))] pt-[calc(2.5rem+var(--nova-safe-top,0px))] dark:bg-transparent"
      >
        <div className="mx-auto w-full max-w-md">
          <div className="mb-6 flex flex-col items-center gap-3">
            <img
              src={appIconHref(brandIcon, mode, preset, customAccent)}
              alt=""
              aria-hidden="true"
              className={clsx('h-10 w-10', appIcon(brandIcon).filled && 'rounded-lg shadow-md')}
            />
            <h1 className="text-center text-xl font-semibold text-content-primary">{title}</h1>
          </div>
          <div className="glass-card space-y-4 rounded-lg border border-border bg-surface-card p-6 text-compact text-content-secondary shadow-sm dark:border-white/[0.08]">
            {children}
          </div>
        </div>
      </div>
    )
  }
  ```
  `apps/web/src/pages/public/InstallSteps.tsx`:
  ```tsx
  import type { DevicePlatform } from '../../lib/devicePlatform'
  import { installSteps } from '../../lib/setupSteps'

  /** One platform's add-to-home-screen steps, or every platform's when the device is not known. */
  export function InstallSteps({ platform }: { platform: DevicePlatform }) {
    const lists = installSteps(platform)
    return (
      <div className="space-y-4">
        {lists.map(list => (
          <section key={list.label}>
            {lists.length > 1 && <h2 className="mb-1 text-compact font-medium text-content-primary">{list.label}</h2>}
            <ol className="list-decimal space-y-1 pl-5">
              {list.steps.map(step => (
                <li key={step.text}>{step.text}</li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    )
  }
  ```
  `apps/web/src/pages/public/InstallPage.tsx`:
  ```tsx
  import { currentPlatform, type DevicePlatform } from '../../lib/devicePlatform'
  import { installedApp } from '../../lib/safeArea'
  import { InstallSteps } from './InstallSteps'
  import { PublicShell } from './PublicShell'

  /** /install (S47): the page the "Nova on a phone" QR code opens. */
  export function InstallPage({
    platform = currentPlatform(),
    installed = installedApp(),
  }: {
    platform?: DevicePlatform
    installed?: boolean
  }) {
    if (installed) {
      return (
        <PublicShell title="Nova is installed">
          <p>Nova is already installed on this device.</p>
          <a className="text-accent underline" href="/">
            Open Nova
          </a>
        </PublicShell>
      )
    }
    return (
      <PublicShell title="Nova on this device">
        <p>Add Nova to this device like an app:</p>
        <InstallSteps platform={platform} />
        <p>Then open it and sign in.</p>
        <a className="text-accent underline" href="/">
          Sign in to Nova
        </a>
      </PublicShell>
    )
  }
  ```
  `apps/web/src/pages/public/AppPage.tsx`:
  ```tsx
  import { useEffect } from 'react'
  import { currentPlatform, type DevicePlatform } from '../../lib/devicePlatform'
  import { NATIVE_APP_LINKS } from '../../lib/nativeApp'
  import { InstallSteps } from './InstallSteps'
  import { PublicShell } from './PublicShell'

  const replaceLocation = (url: string) => window.location.replace(url)

  /**
   * /app (S47): the page the "Nova app" QR code opens. A phone whose store has a
   * Nova app is sent there; today neither store has one, so the page says so and
   * offers the web app instead — never a redirect to a listing that does not exist.
   */
  export function AppPage({
    platform = currentPlatform(),
    links = NATIVE_APP_LINKS,
    go = replaceLocation,
  }: {
    platform?: DevicePlatform
    links?: { ios: string | null; android: string | null }
    go?: (url: string) => void
  }) {
    const link = platform.os === 'ios' ? links.ios : platform.os === 'android' ? links.android : null
    useEffect(() => {
      if (link) go(link)
    }, [link, go])
    if (link) {
      return (
        <PublicShell title="The Nova app">
          <p>Opening the app store…</p>
          <a className="text-accent underline" href={link}>
            Open the store
          </a>
        </PublicShell>
      )
    }
    if (platform.phone) {
      return (
        <PublicShell title="The Nova app">
          <p>There’s no Nova app for {platform.os === 'ios' ? 'iPhone' : 'Android'} yet.</p>
          <p>Nova works as a web app on this phone instead:</p>
          <InstallSteps platform={platform} />
          <a className="text-accent underline" href="/">
            Sign in to Nova
          </a>
        </PublicShell>
      )
    }
    return (
      <PublicShell title="The Nova app">
        <p>The Nova app is for phones.</p>
        <a className="text-accent underline" href="/install">
          Install Nova on this computer instead
        </a>
      </PublicShell>
    )
  }
  ```
  `apps/web/src/pages/public/AddPage.tsx`:
  ```tsx
  import { useState } from 'react'
  import { Share2 } from 'lucide-react'
  import { Button, Input } from '../../components/ui'
  import { CopyLine } from '../../components/SetupPanel'
  import { currentPlatform, type DevicePlatform } from '../../lib/devicePlatform'
  import { AGENT_STEPS, NOVAD_README, parseCodeFragment } from '../../lib/setupSteps'
  import { enrollCommand } from '../settings/devicesFormat'
  import { PublicShell } from './PublicShell'

  type Share = (data: { title: string; url: string }) => Promise<void>

  function browserShare(): Share | undefined {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return undefined
    return navigator.share.bind(navigator)
  }

  /**
   * /add (S47): the page a machine setup's QR code opens. The code rides the URL
   * fragment and is never sent anywhere: this page makes no request, so it cannot
   * be used to test whether a guessed code is real. It picks its steps from the
   * device that opened it — the command on a computer, "open this on the
   * computer" (and Share, where the browser can) on a phone.
   */
  export function AddPage({
    platform = currentPlatform(),
    hash = window.location.hash,
    origin = window.location.origin,
    share = browserShare(),
  }: {
    platform?: DevicePlatform
    hash?: string
    origin?: string
    share?: Share
  }) {
    const [typed, setTyped] = useState('')
    const fromLink = parseCodeFragment(hash)
    const code = fromLink ?? parseCodeFragment(typed)
    const link = code ? `${origin}/add#${code}` : null
    const agentUnsupported = platform.os === 'windows' || platform.os === 'mac'
    return (
      <PublicShell title="Add a machine to Nova">
        {code === null ? (
          <div className="space-y-2">
            <p>
              {hash && hash !== '#' ? 'That link carries no code Nova can read.' : 'This page adds a machine to Nova.'}{' '}
              Type the code Nova showed you.
            </p>
            <Input
              label="The code Nova showed you"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              placeholder="ABCD-2345"
              autoComplete="off"
              autoCapitalize="characters"
            />
          </div>
        ) : (
          <>
            <p>
              Code{' '}
              <span data-testid="add-code" className="font-mono text-content-primary">
                {code}
              </span>{' '}
              works once, and expires ten minutes after Nova made it.
            </p>
            {platform.phone && (
              <div className="space-y-2">
                <p>{AGENT_STEPS.phone}</p>
                {share && link && (
                  <Button
                    variant="secondary"
                    icon={<Share2 size={14} />}
                    onClick={() => void share({ title: 'Add a machine to Nova', url: link })}
                  >
                    Share this link
                  </Button>
                )}
                <p>{AGENT_STEPS.phoneSelf}</p>
              </div>
            )}
            {agentUnsupported && <p>{AGENT_STEPS.unsupported}</p>}
            <ol className="list-decimal space-y-3 pl-5">
              <li>
                {AGENT_STEPS.install.text}{' '}
                <a className="text-accent underline" href={NOVAD_README} target="_blank" rel="noreferrer">
                  novad’s README
                </a>
              </li>
              <li className="space-y-1">
                <p>{AGENT_STEPS.enroll}</p>
                <CopyLine value={enrollCommand(origin, code)} label="the command" />
              </li>
              <li>{AGENT_STEPS.run}</li>
            </ol>
          </>
        )}
      </PublicShell>
    )
  }
  ```
  `apps/web/src/App.tsx` — import the three pages and replace the `App` default export with:
  ```tsx
  export default function App() {
    return (
      <ThemeProvider>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              {/* S47: the pages a scanned setup QR code opens, BEFORE the sign-in gate.
                  They call no API and read only the URL and the browser, so a phone
                  that has never signed in can follow them. */}
              <Route path="/install" element={<InstallPage />} />
              <Route path="/app" element={<AppPage />} />
              <Route path="/add" element={<AddPage />} />
              <Route
                path="/*"
                element={
                  <AuthProvider>
                    <Gate />
                  </AuthProvider>
                }
              />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </ThemeProvider>
    )
  }
  ```

- [ ] **Step 4: Run them, the whole web suite, and typecheck.**
  `npm test && npx tsc --noEmit` — Expected: all pass (the existing `App gate` tests must not
  move: the gate still owns every other path).

- [ ] **Step 5: Commit.**
  ```bash
  git -C /home/jeremy/workspace/nova/.worktrees/qr add apps/web/src/pages/public apps/web/src/App.tsx apps/web/src/App.test.tsx
  git -C /home/jeremy/workspace/nova/.worktrees/qr commit -m "feat(s47): the pages a scanned setup code opens, before sign-in"
  git -C /home/jeremy/workspace/nova/.worktrees/qr show --stat HEAD
  ```

---

### Task 10: The chat card — live, reloaded, and kept across the idle poll

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`SetupCard` next to `Delegation` at `:321-330`;
  `cards?: SetupCard[]` on `StoredMessage` at `:271-315`)
- Modify: `apps/web/src/lib/streamChat.ts` (`StreamEvent` `:54-110`; `KNOWN_FRAME_KEYS`
  `:151-160`; a `card` branch in `frameToEvent` before `:264`; the header comment `:4-8`, `:20-27`)
- Modify: `apps/web/src/pages/chat/chatReducer.ts` (`MessageRow` `:66-132`; `FetchedMessage`
  `:251-266`; `message()` `:290-312`; `replacePendingWithError` `:391-403`; `applyEvent`;
  `done` `:519-523`; `serverRow` `:554-571`; `sameCards` beside `sameDelegations` `:573-582`;
  `mergeServerRows` `:667-740`; `sameRows` `:744-762`)
- Modify: `apps/web/src/pages/chat/MessageBubble.tsx` (after the delegation chips `:450-459`)
- Modify (row literals gain `cards: []`): `MessageBubble.test.tsx:8-31, 209-230`,
  `pages/inbox/beatTurnLabel.test.tsx:16-38`
- Test: `streamChat.test.ts`, `chatReducer.test.ts`, `MessageBubble.test.tsx` (+cases)

**Interfaces:**
- Consumes: the `card` frame (Task 3/4) and `messages_json.cards` (Task 4); `SetupPanel`,
  `isSetupKind` (Task 8).
- Produces:
  - `interface SetupCard { kind: 'setup_qr'; setup: string; address: string; url: string; code?: string | null; expires_at?: string | null; code_shown?: boolean }`
  - `StreamEvent` member `{ type: 'card'; card: SetupCard }`
  - `MessageRow.cards: SetupCard[]` (live and reloaded alike)

- [ ] **Step 1: Write the failing tests.** In `streamChat.test.ts`, beside the route test
  (`:158-162`):
  ```ts
  const LIVE_CARD =
    '{"kind":"setup_qr","setup":"add_machine","address":"https://nova.fake-tailnet.ts.net","url":"https://nova.fake-tailnet.ts.net/add#ABCD-2345","code":"ABCD-2345","expires_at":"2026-09-25T14:10:00+00:00"}'

  it('turns a setup card frame into a card event', () => {
    expect(parseAll([`data: {"card":${LIVE_CARD}}\n\n`])).toEqual([
      {
        type: 'card',
        card: {
          kind: 'setup_qr',
          setup: 'add_machine',
          address: 'https://nova.fake-tailnet.ts.net',
          url: 'https://nova.fake-tailnet.ts.net/add#ABCD-2345',
          code: 'ABCD-2345',
          expires_at: '2026-09-25T14:10:00+00:00',
        },
      },
    ])
  })

  it('ignores a card kind this client does not draw, like any future frame', () => {
    expect(parseAll(['data: {"card":{"kind":"join_link","url":"https://example.invalid/a"}}\n\n'])).toEqual([])
  })

  it('a setup card with no link is a broken frame, said out loud', () => {
    const events = parseAll(['data: {"card":{"kind":"setup_qr","setup":"install_pwa"}}\n\n'])
    expect(events.map(e => e.type)).toEqual(['error'])
  })
  ```
  In `chatReducer.test.ts`, a new `describe('setup cards (S47)')`:
  ```ts
  const LIVE = {
    kind: 'setup_qr' as const,
    setup: 'add_machine',
    address: 'https://nova.fake-tailnet.ts.net',
    url: 'https://nova.fake-tailnet.ts.net/add#ABCD-2345',
    code: 'ABCD-2345',
    expires_at: '2026-09-25T14:10:00+00:00',
  }
  const REDRAWN = {
    kind: 'setup_qr' as const,
    setup: 'add_machine',
    address: 'https://nova.fake-tailnet.ts.net',
    url: 'https://nova.fake-tailnet.ts.net/add',
    code_shown: true,
    expires_at: '2026-09-25T14:10:00+00:00',
  }

  function withMeta(): ChatState {
    return chatReducer(started(), {
      type: 'event',
      event: { type: 'meta', conversationId: 'c1', model: 'qwen3:8b', turnId: 't1', agent: null },
    })
  }

  describe('setup cards (S47)', () => {
    it('a card frame lands on the pending row', () => {
      const state = chatReducer(withMeta(), { type: 'event', event: { type: 'card', card: LIVE } })
      expect(messages(state)[1].cards).toEqual([LIVE])
    })

    it('a reply that is only a card is kept, never replaced by "no reply"', () => {
      let state = chatReducer(withMeta(), { type: 'event', event: { type: 'card', card: LIVE } })
      state = chatReducer(state, { type: 'event', event: { type: 'done' } })
      expect(errors(state)).toEqual([])
      expect(messages(state)[1].cards).toEqual([LIVE])
    })

    it('a fetched row carries its cards verbatim, and none when the server stated none', () => {
      const state = chatReducer(emptyChat(), {
        type: 'loaded',
        conversationId: 'c1',
        messages: [
          { id: 'u1', role: 'user', content: 'add my laptop' },
          { id: 'a1', role: 'assistant', content: 'Scan the card.', cards: [REDRAWN] },
          { id: 'a2', role: 'assistant', content: 'older core' },
        ],
      })
      expect(messages(state)[1].cards).toEqual([REDRAWN])
      expect(messages(state)[2].cards).toEqual([])
    })

    it('the idle poll keeps a live code on the card the server redrew without one (Review Focus 4)', () => {
      let state = chatReducer(withMeta(), { type: 'event', event: { type: 'delta', text: 'Scan the card.' } })
      state = chatReducer(state, { type: 'event', event: { type: 'card', card: LIVE } })
      state = chatReducer(state, { type: 'event', event: { type: 'done' } })
      const fetched = [
        { id: 'srv-u', role: 'user', content: 'hello' },
        { id: 'srv-a', role: 'assistant', content: 'Scan the card.', turn_kind: 'chat', cards: [REDRAWN] },
      ]
      const once = chatReducer(state, { type: 'idlePolled', conversationId: 'c1', messages: fetched, observedRows: state.rows })
      expect(messages(once)[1].cards[0].code).toBe('ABCD-2345')
      const twice = chatReducer(once, { type: 'idlePolled', conversationId: 'c1', messages: fetched, observedRows: once.rows })
      expect(messages(twice)[1].cards[0].code).toBe('ABCD-2345')
      expect(twice).toBe(once)
    })

    it('the idle poll treats a new card as news', () => {
      const state = chatReducer(emptyChat(), {
        type: 'loaded',
        conversationId: 'c1',
        messages: [{ id: 'u1', role: 'user', content: 'hi' }, { id: 'a1', role: 'assistant', content: 'ok', turn_kind: 'chat' }],
      })
      const carded = chatReducer(state, {
        type: 'idlePolled',
        conversationId: 'c1',
        messages: [
          { id: 'u1', role: 'user', content: 'hi' },
          { id: 'a1', role: 'assistant', content: 'ok', turn_kind: 'chat', cards: [REDRAWN] },
        ],
        observedRows: state.rows,
      })
      expect(messages(carded)[1].cards).toEqual([REDRAWN])
    })
  })
  ```
  In `MessageBubble.test.tsx`, beside the delegation tests (`:524-552`), and add `cards: []` to
  both row helpers (`:8-31`, `:209-230`) and to `pages/inbox/beatTurnLabel.test.tsx:16-38`:
  ```tsx
  it('draws a setup card after the reply, and nothing when there is none', () => {
    render(
      <MessageBubble
        row={assistantRow({
          text: 'Scan the card with the tablet.',
          streaming: false,
          cards: [
            {
              kind: 'setup_qr',
              setup: 'install_pwa',
              address: 'https://nova.fake-tailnet.ts.net',
              url: 'https://nova.fake-tailnet.ts.net/install',
            },
          ],
        })}
      />,
    )
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('QR code for https://nova.fake-tailnet.ts.net/install')
  })

  it('a card kind this build does not know is drawn as its link, never dropped', () => {
    render(
      <MessageBubble
        row={assistantRow({
          text: 'Here.',
          streaming: false,
          cards: [{ kind: 'setup_qr', setup: 'fax_machine', address: 'https://nova.fake-tailnet.ts.net', url: 'https://nova.fake-tailnet.ts.net/fax' }],
        })}
      />,
    )
    expect(screen.getByRole('link', { name: 'https://nova.fake-tailnet.ts.net/fax' })).toBeTruthy()
  })
  ```

- [ ] **Step 2: Run them to see them fail.** `npm test -- streamChat chatReducer MessageBubble`
  Expected: the new tests fail (`card` events unknown; `cards` undefined).

- [ ] **Step 3: Implement.**
  - `lib/api.ts`, next to `Delegation`:
    ```ts
    /**
     * A setup QR card her turn sent (S47). Live, from the stream, a machine
     * setup's card carries its one-time `code`; redrawn on reload from the trace,
     * it never does (`code_shown` says one was). `setup` stays a string on the
     * wire: a kind this build does not know is drawn as its link, not dropped.
     */
    export interface SetupCard {
      kind: 'setup_qr'
      setup: string
      address: string
      url: string
      code?: string | null
      expires_at?: string | null
      code_shown?: boolean
    }
    ```
    and `cards?: SetupCard[]` on `StoredMessage` (comment: "S47: the setup QR cards the turn sent,
    redrawn from the trace — never with a code").
  - `lib/streamChat.ts`: `import type { SetupCard } from './api'` (type-only: api.ts imports this
    module at runtime); add `| { type: 'card'; card: SetupCard }` to `StreamEvent`; add `'card'` to
    `KNOWN_FRAME_KEYS`; before the unknown-keys check in `frameToEvent`:
    ```ts
      if (obj.card !== null && typeof obj.card === 'object') {
        const c = obj.card as Record<string, unknown>
        // A card kind this client does not draw (a later slice's) is ignored, the
        // way a future frame type is. A setup card missing its parts is broken.
        if (typeof c.kind === 'string' && c.kind !== 'setup_qr') return null
        if (c.kind === 'setup_qr' && typeof c.setup === 'string' && typeof c.address === 'string' && typeof c.url === 'string') {
          const card: SetupCard = { kind: 'setup_qr', setup: c.setup, address: c.address, url: c.url }
          if (typeof c.code === 'string') card.code = c.code
          if (typeof c.expires_at === 'string') card.expires_at = c.expires_at
          return { type: 'card', card }
        }
      }
    ```
    and a paragraph in the header comment: "`card` (S47) is a UI-only card beside the reply — a
    setup QR code. It never enters her context; a machine card's code exists only here and in
    the tab that renders it."
  - `pages/chat/chatReducer.ts`:
    - import `SetupCard` with `Attachment, Delegation`; `MessageRow` gains
      `/** S47: the setup QR cards this reply carries — live from the stream, or redrawn from the trace (never with a code). */ cards: SetupCard[]`;
      `FetchedMessage` gains `cards?: SetupCard[]`; `message()` defaults `cards: []`.
    - `applyEvent`:
      ```ts
          case 'card':
            if (state.pendingId === null) return state
            return withPending(state, row => ({ ...row, cards: [...row.cards, event.card] }))
      ```
    - a card is content: in `done`, `if (pending && !pending.text && pending.cards.length === 0)`;
      in `replacePendingWithError`, keep the row when `pending.text || pending.cards.length > 0`.
    - `serverRow`: `cards: Array.isArray(m.cards) ? m.cards : [],`.
    - beside `sameDelegations`:
      ```ts
      function sameCards(a: SetupCard[], b: SetupCard[]): boolean {
        if (a.length !== b.length) return false
        return a.every(
          (c, i) =>
            c.setup === b[i].setup &&
            c.url === b[i].url &&
            (c.code ?? null) === (b[i].code ?? null) &&
            (c.expires_at ?? null) === (b[i].expires_at ?? null),
        )
      }

      /**
       * S47: a machine card's code reaches this tab once, on the live stream, and
       * is never stored — the server's row redraws the card without it. While this
       * tab holds the code, the merge keeps it on the card that stands for it (same
       * setup, same expiry), so the idle poll never takes a still-valid code off
       * the screen. A reload has no code to keep, which is the design.
       */
      function withLiveCodes(server: MessageRow, local: MessageRow): MessageRow {
        if (!local.cards.some(card => card.code)) return server
        const cards = server.cards.map(card => {
          const twin = local.cards.find(
            l => l.code && l.setup === card.setup && (l.expires_at ?? null) === (card.expires_at ?? null),
          )
          return twin ? { ...card, code: twin.code, url: twin.url } : card
        })
        return { ...server, cards }
      }
      ```
    - `sameRows`: add `sameCards(row.cards, other.cards)` to the `&&` chain beside `sameDelegations`.
    - `mergeServerRows`: where a store row is represented by a spine row — right after
      `claimed.add(resolved)` add
      `if (row.kind === 'message') spine[resolved] = withLiveCodes(spine[resolved], row)`, and in the
      claim branch (`:723-725`), before `claimed.add(cursor)`, add
      `spine[cursor] = withLiveCodes(spine[cursor], next)`.
  - `pages/chat/MessageBubble.tsx`, after the delegation chips (`:459`), before the ThinkingLine:
    ```tsx
          {row.cards.length > 0 && (
            <div data-testid="setup-cards" className="mt-2 space-y-3">
              {row.cards.map((card, i) =>
                isSetupKind(card.setup) ? (
                  <div key={i} className="rounded-md border border-border bg-surface-card p-3">
                    <SetupPanel
                      compact
                      setup={card.setup}
                      address={card.address}
                      code={card.code ?? null}
                      expiresAt={card.expires_at ?? null}
                    />
                  </div>
                ) : (
                  <a key={i} className="text-accent underline" href={card.url}>
                    {card.url}
                  </a>
                ),
              )}
            </div>
          )}
    ```
    (import `SetupPanel` from `../../components/SetupPanel` and `isSetupKind` from
    `../../lib/setupSteps`.)

- [ ] **Step 4: Run the web suite and typecheck.** `npm test && npx tsc --noEmit && npm run build`
  Expected: all pass; `npm run build` (`tsc -b`) catches a `switch` in `applyEvent` that misses
  the new event type, which vitest does not.

- [ ] **Step 5: Commit.**
  ```bash
  git -C /home/jeremy/workspace/nova/.worktrees/qr add apps/web/src/lib/api.ts apps/web/src/lib/streamChat.ts apps/web/src/lib/streamChat.test.ts apps/web/src/pages/chat/chatReducer.ts apps/web/src/pages/chat/chatReducer.test.ts apps/web/src/pages/chat/MessageBubble.tsx apps/web/src/pages/chat/MessageBubble.test.tsx apps/web/src/pages/inbox/beatTurnLabel.test.tsx
  git -C /home/jeremy/workspace/nova/.worktrees/qr commit -m "feat(s47): her setup cards in the chat, live and after a reload"
  git -C /home/jeremy/workspace/nova/.worktrees/qr show --stat HEAD
  ```

---

### Task 11: Land it, deploy it from the nova directory, walk it, write it down

This task is the definition of done (spec §13). Nothing here is finished while it exists only
in the worktree.

- [ ] **Step 1: The whole branch, by hand** (`v4-push-gate`):
  ```bash
  cd /home/jeremy/workspace/nova/.worktrees/qr/services/core && uv run ruff check app tests && uv run pytest -q --timeout=120 2>&1 | tail -3
  cd ../gateway && uv run pytest -q 2>&1 | tail -2
  cd ../memory && uv run pytest -q 2>&1 | tail -2
  cd ../../apps/web && npm test 2>&1 | tail -4 && npx tsc --noEmit && npm run build 2>&1 | tail -2
  cd ../../deploy/backup && uv run pytest -q 2>&1 | tail -2
  cd /home/jeremy/workspace/nova/.worktrees/qr && bash deploy/tailscale/start_test.sh 2>&1 | tail -1 && bash deploy/backup_test.sh 2>&1 | tail -1 && bash deploy/install_test.sh 2>&1 | tail -1
  ```
  (gateway and memory need `TEST_DATABASE_URL` pointed at their own `nova_gateway_s47` /
  `nova_memory_s47` databases, created like core's.) Expected: every suite green. Any red is
  reported with its output; nothing merges red.

- [ ] **Step 2: A whole-branch review.** Request a code review of `origin/main...slice/s47`
  (superpowers:requesting-code-review), with the spec as the requirement. Fix what it finds,
  re-run Step 1.

- [ ] **Step 3: Rebase if another lane landed first.** `git -C … fetch origin && git -C … rebase origin/main`.
  If S46a or S42a landed, the registry, corpus and `suite_version` pins renumber here, once
  (hub-topology, "Migrations"); `guards.py` conflicts are textual (spec §15). Re-run Step 1.

- [ ] **Step 4: Push and open the PR.** Write the PR body to the session scratchpad first:
  a line naming the spec and this plan, then one line per suite with the passed/failed counts
  Step 1 printed (core, gateway, memory, web, deploy/backup, and the three shell tests), then
  the two attribution lines. Then:
  ```bash
  git -C /home/jeremy/workspace/nova/.worktrees/qr push -u origin slice/s47
  cd /home/jeremy/workspace/nova/.worktrees/qr && env -u GH_TOKEN gh pr create --base main --head slice/s47 --title "S47: setup QR codes -- a machine, a model server, the PWA and the app" --body-file "$SCRATCHPAD/s47-pr-body.md"
  ```
  Merging is the owner's call unless he says otherwise (the auto-mode classifier has blocked
  merges without review before). Ask him to merge, and wait.

- [ ] **Step 5: Deploy from the nova directory** (owner rule 2026-09-25 — never from a worktree):
  ```bash
  git -C /home/jeremy/workspace/nova status --short   # the deploy tree: only its known untracked files
  git -C /home/jeremy/workspace/nova fetch origin && git -C /home/jeremy/workspace/nova checkout --detach origin/main
  git -C /home/jeremy/workspace/nova log -1 --format='%h %s'   # the merge commit of the PR
  cd /home/jeremy/workspace/nova/deploy && docker compose config --services
  cd /home/jeremy/workspace/nova/deploy && docker compose build core web && docker compose up -d core web tailscale
  ```
  Run compose FROM `deploy/`, with no `-f`: `deploy/.env` carries the absolute `COMPOSE_FILE`
  (base + GPU overlay) and `COMPOSE_PROFILES` — a bare `-f deploy/docker-compose.yml` puts
  ollama on CPU (the GPU-overlay trap). `config --services` must list the eight v4 services
  before anything is recreated, and only core, web and tailscale are. A `status --short` line
  the pull would touch is someone else's work: stop and ask. Recreating the sidecar drops the
  tailnet URL for a few seconds. Then check, in this order: `docker compose ps` shows core, web
  and tailscale healthy; `docker compose exec core cat /run/nova-status/tailscale.json` shows
  `"backend_state": "Running"` and a `written_at` under 15 s old.

- [ ] **Step 6: The walk, in chat, in her words** (spec §13) — through the owner's phone and the
  live tailnet URL; read every turn's `turn_spans` by turn id (never a time-ordered LIMIT):
  1. "How do I put you on my phone?" → a `show_setup_qr` span with `setup=install_pwa`, no guard
     span; the owner scans the card with the iPhone, adds Nova to the home screen, and the icon
     opens Nova's start page.
  2. "Add my laptop so you can control it." → a machine card; the phone's scan shows "open this
     on the computer". On the mini PC, a throwaway novad built from the nova directory
     (`cd ~/workspace/nova/apps/novad && go build -o /tmp/novad-walk .`) enrolls with the `/add`
     page's command under its own `XDG_CONFIG_HOME=/tmp/novad-walk-cfg`, appears in Settings →
     Devices, and is revoked afterwards. Grep the turn's spans and messages for the code: none.
  3. "Where do I download your iPhone app?" → `/app` on the iPhone says there is no app yet and
     shows the install steps.
  4. "Set up the Dell to serve models." → the card and her reply both carry the S44 statement.
  5. Open Settings on the hub at `http://127.0.0.1:3000`: every panel's QR encodes the tailnet
     address, never loopback.
  6. 393 px screenshots (the mcr playwright image, `--network host`, against the baked web) of
     Settings → Devices, each panel, the chat card, and `/install`, `/app`, `/add`.

- [ ] **Step 7: Write it down.**
  - `docs/plans/rebuild/slice-47-setup-qr.md`: a close-out section at the end of this file
    (what shipped, the suite counts, the walk's turn ids and what each trace showed), in the
    S40 close-out's form; `docs/plans/rebuild/slice-47-carries.md` for anything not finished.
  - `docs/plans/rebuild/hub-topology.md` §S47: "SHIPPED" with the date and a link here.
  - `docs/plans/rebuild/ROADMAP.md`: the order-of-work row and the index row.
  - `deploy/README.md`: a new "Adding devices and phones" section (the four QR codes, step zero,
    what is not built yet) and the `v4_status` volume in the volumes list.
  - Commit on a docs branch, PR, and ask the owner to merge — the same path as the code.

## Close-out (2026-09-30)

**Status: SHIPPED 2026-09-26, walked 2026-09-30.**

**What shipped.** PR #76 (merged 747eebbb, 2026-09-26): `nova_address` and
`show_setup_qr`, the setup QR cards for a phone, a machine, a model server, and the
not-yet-built native app; the derived-address sidecar status file; the setup pages
`/install`, `/app`, `/add`; the guards against an invented code or a wrong address. Suites
at merge: core 5,281 passed, with only the known-red timing tests still failing; web 85
files / 1,245 tests with tsc and build clean; the shell suites at their known-red counts
too. Deployed from
`~/workspace/nova` the same day; core, web and tailscale were recreated and healthy that
evening.

A same-day follow-up (PR #77) made core send a setup card itself when a message plainly
asked for one, matched by a phrase matcher. The owner rejected the phrase matcher as
brittle, and PR #78 reverted it the next day, back to exactly what PR #76 shipped.

**The walk.** The first attempt (2026-09-26, the owner's real chat) failed: asked "How do I
put you on my phone?", the chat model made no tool call and invented a Dell-hosted web page
and a sideloaded iOS app instead, echoing two of the owner's own memory notes from
2026-09-15 about an earlier, unrelated app idea. Measured the next day through the eval
runner with no owner memory in play, the same phrasing called `show_setup_qr` correctly on
every run — the failure was a stale memory taking over the reply, not a gap in the tool or
the guards. The recall fix (PR #79, 2026-09-27 — recall serves only the words in the
exchange, never a memory of her own past answer) and the decision role (PR #85 and PR #86,
2026-09-29; see `decision-role/plan.md`'s close-out) fixed it together: recall now sets the
stale notes aside, and the decision role's hint points her at the right tool. The
2026-09-30 walk recorded there passes the phone question; measured with the owner's own
memory in play, the same case went from 1 of 3 right to 3 of 3 once both fixes had landed.

**Not built:** the native app itself and its store listings; the models role that would let
a paired model server actually serve (S44); Tailscale invites and joins (S43a, S43b) — step
zero is stated, never performed; a phone as a machine Nova controls, which needs the native
app.
