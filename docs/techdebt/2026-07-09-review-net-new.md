# 2026-07-09 — Review Findings (net-new)

> **Scope.** A fresh security/quality/perf pass requested alongside the vision
> review. This doc lists **only net-new findings** plus **re-confirmations** of
> high-value items from the consolidated checklist that I verified are still
> live in the current source. It does **not** restate the ~90 open items in
> `2026-07-09-open-items-consolidated.md` — that remains the master backlog.
> Continues the SEC-/TD- numbering where it attaches to an existing thread; new
> threads get a fresh prefix.
>
> **Method.** Targeted reads of the security boundaries the two July-07 audits
> touched least: the sandbox path resolver, the subprocess-spawning agent tools,
> the chat-api WebSocket admission path, recovery's public surface, and a scan
> for fire-and-forget tasks + swallowed exceptions. Every NEW-## item below was
> read-confirmed, not grepped-and-guessed.

---

## Findings index

| ID | Sev | Area | Title | Effort |
|----|-----|------|-------|--------|
| **NEW-01** | **High** | Security | Sandbox `_resolve_path` boundary uses string `startswith` — sibling-prefix escape | S |
| **NEW-02** | Med | Reliability/Security | 22 un-referenced `asyncio.create_task` — audit/usage rows can be GC'd mid-flight | S |
| **NEW-03** | Low | Resilience | 29 `except Exception: pass` swallows beyond the TD-06 site | S–M |
| **NEW-04** | Low | Reliability | chat-api WS admission reads private `_conn_semaphore._value` (racy, version-fragile) | XS |
| **NEW-05** | Low | Correctness | `bulk_delete ?all=true` uses `status NOT LIKE '%running'` — brittle status taxonomy coupling | XS |
| SEC-008 ✔ | **High** | Security | **Confirmed still open** — chat-api WebSocket has no `Origin` check (CSWSH) | S |
| SEC-011 ✔ | Med | Security | **Confirmed still open** — recovery `/status`,`/services`,`/backups` unauthenticated topology disclosure | S |
| SEC-012 ✔ | Med | Security | **Confirmed still open** — admin secret + JWTs in `localStorage` (XSS-exfiltratable) | M |

---

## NEW-01 — Sandbox path boundary is a string `startswith`, not a path-containment check  🔴 High / Security

**Where:** `orchestrator/app/tools/code_tools.py:257` and `:266` (`_resolve_path`),
mirrored in the self-modification overlay at `:273`.

**Problem.** The sandbox containment check is:

```python
candidate = (root / relative).resolve()
if not str(candidate).startswith(str(root)):
    raise ValueError("... Directory traversal is not permitted.")
return candidate
```

`str.startswith` on the resolved path string treats any **sibling directory that
shares the root's string prefix** as "inside" the sandbox. With
`workspace_root="/workspace"` (config default) a `relative` of
`../workspace-backup/x` resolves to `/workspace-backup/x`, and
`"/workspace-backup/x".startswith("/workspace")` is `True` → the path is
returned as valid. The same hole exists in the **home** tier
(`home_root="/root"` default → `/root-anything` passes) and in the
**self-modification overlay** (`NOVA_SOURCE_ROOT="/nova"` → `/nova-x` passes).

`.resolve()` *does* correctly collapse `..` and follow symlinks before the check,
so classic `../../etc/passwd` and symlink-target escapes are caught — the
**only** gap is the missing path-separator boundary. But it is a real one: the
`write_file` tool would happily create `/workspaceZ/...` at the container root,
and under the `home` tier (SEC-001 opt-in, host `$HOME` mounted) the blast
radius is the host filesystem.

**Why it matters now.** This is the innermost trust boundary for every
file/shell tool the agent runs, including the self-modification path. Today's
exploitability depends on a sibling dir sharing the prefix existing (not the
default), but the check is one compose-mount change away from being live, and
the agent can *create* the sibling via `write_file`. Defense-in-depth on the
sandbox boundary should not be probabilistic.

**Fix.** Use path containment, not string prefix. The codebase already knows the
idiom — `code_tools.py:335` uses `Path.relative_to`:

```python
def _within(candidate: Path, root: Path) -> bool:
    return candidate == root or root in candidate.parents
    # or, 3.9+: candidate.is_relative_to(root)
```

Replace both `startswith` sites and the overlay check. Add a unit test with the
sibling-prefix vector (`../workspace-x`, `/root-x`, `/nova-x`) — none exist
today so it will pass once fixed and lock the boundary. **Effort:** S.

---

## NEW-02 — Fire-and-forget `asyncio.create_task` with no reference held  🟡 Med / Reliability + Security

**Where:** 22 call sites across `orchestrator/app` (grep). The security-relevant
ones: `auth.py:256` (`touch_api_key`), `auth.py:393` & `:428` (`audit_rbac` on
token-deny / account-expiry), `auth_router.py:248` & `:295` (`audit_rbac` on
user management), `usage.py:43` (usage event write).

**Problem.** Per the CPython docs, `asyncio.create_task` returns a task the event
loop holds only a **weak** reference to; if the caller doesn't keep a strong
reference, the task "may be garbage-collected at any time, even before it's
done." These sites `create_task(...)` and immediately discard the handle. Under
GC pressure or loop churn the coroutine can be collected mid-flight — silently
dropping a security-audit row (`audit_rbac`), a rate-limit `last_used` touch, or
a usage/billing event. The failure is invisible: no log, no exception, just a
missing row. Exactly the audit trail you least want probabilistic.

**Fix.** The documented pattern — hold strong refs in a module-level set and
discard on completion:

```python
_bg: set[asyncio.Task] = set()
def _spawn(coro):
    t = asyncio.create_task(coro)
    _bg.add(t)
    t.add_done_callback(_bg.discard)
```

Route the fire-and-forget audit/usage/touch calls through it. **Effort:** S
(mechanical; one helper, ~22 call-site edits).

---

## NEW-03 — Swallowed exceptions beyond the TD-06 site  🟠 Low / Resilience

**Where:** ~29 `except Exception: pass` blocks across `orchestrator/app`,
`cortex/app`, `memory-service/app` (TD-06 fixed only the runner stimulus-emit
one). Notable: the deny-list reason parse and both audit spawns in
`auth.py` swallow silently; several config reads fall back with no signal.

**Problem.** Blanket `pass` on `except Exception` hides the difference between
"expected-absent optional config" (fine) and "Redis/DB is degrading" (want to
know). CLAUDE.md's own log-level rule says recoverable-but-functional failures
are WARNING, not silence.

**Fix.** Sweep: each site either `log.debug` (truly benign) or `log.warning`
(affects functionality). Don't blanket-raise — the fault-tolerant posture is
deliberate — just make the silent ones *visible*. **Effort:** S–M (judgement per
site; bundle with NEW-02 since they overlap in `auth.py`).

---

## NEW-04 — chat-api WebSocket admission touches a private asyncio attribute  🟠 Low / Reliability

**Where:** `chat-api/app/websocket.py:~104` — `if _conn_semaphore._value == 0:`
(`# noqa: SLF001`).

**Problem.** Reading `Semaphore._value` is (a) a check-then-acquire TOCTOU — two
connections can both see `_value == 1` and pass — and (b) coupled to a CPython
private attribute that has changed across versions. The global cap is best-effort
either way; this just makes it fragile and lint-suppressed rather than correct.

**Fix.** Track an explicit counter alongside the per-IP dict, or
`acquire()` with a zero timeout and reject on failure. **Effort:** XS.

---

## NEW-05 — `bulk_delete ?all=true` couples deletion safety to a string suffix  🟠 Low / Correctness

**Where:** `orchestrator/app/pipeline_router.py` (new this branch) —
`DELETE FROM tasks WHERE status NOT IN ('queued','completing') AND status NOT LIKE '%running'`.

**Problem.** "Don't delete in-flight work" is encoded as *"status doesn't end in
`running` and isn't one of two literals."* A new active status that doesn't
happen to end in `running` (e.g. `dispatching`, `awaiting_tool`) would be
silently eligible for deletion by a Clear-History click. Admin-gated, so not a
security issue — a correctness/foot-gun one. The safer shape is an explicit
allow-list of terminal/safe-to-delete statuses (the code has a `TERMINAL` set
right above it — the `all` branch just doesn't use it).

**Fix.** Delete `WHERE status = ANY($1)` with the explicit terminal set (+
`submitted` orphans if that's the intent), so adding an active status is
delete-safe by default. **Effort:** XS. *(The rest of this branch's dead-letter
viewer + inbox-delete work read clean.)*

---

## Re-confirmed still-open (verified against current source)

- **SEC-008 — chat-api WebSocket has no `Origin` validation.** `websocket.py`
  `_authenticate` checks a token only; CORS middleware does **not** apply to
  WebSockets. Any web page the operator visits can open
  `ws://localhost:8080/ws/chat`, and with `REQUIRE_AUTH=false` (dev default)
  auth is skipped entirely → cross-site WebSocket hijacking of the chat/agent
  surface. Add an `Origin` allow-list check at accept time. **Still open.**
- **SEC-011 — recovery topology disclosure.** `routes.py` `get_overview`
  (`/api/v1/recovery/status`), `get_services`, `get_all_services`,
  `get_backups`, `get_reset_categories` have **no** auth dependency and return
  DB size, table count, backup filenames+sizes, and the full service/port map.
  Gate the detail behind `_check_admin`; keep only a boolean up/down for the
  pre-login startup screen. **Still open.**
- **SEC-012 — admin secret + JWTs in `localStorage`.** `dashboard/src/api.ts`
  stores `nova_admin_secret` and `nova_auth_tokens` in `localStorage` (readable
  by any XSS). The CSP added in TD-08 mitigates injection but doesn't move the
  secret. Consider httpOnly-cookie sessions or in-memory + refresh. **Still
  open** (tracked; higher effort).

---

## Suggested sequencing

1. **NEW-01** — smallest-diff, highest-severity; the sandbox boundary. Land first.
2. **SEC-008 + SEC-011** — two small, independent, credential-less-access closes.
3. **NEW-02 + NEW-03** — bundle (overlap in `auth.py`); makes the audit trail reliable.
4. **NEW-04 + NEW-05** — trivial correctness cleanups; bundle with any pipeline/chat touch.
