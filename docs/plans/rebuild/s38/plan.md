# S38 — her own browser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nova browses the web with a real headless browser that only she uses, through five tools of her own:
- `browser_open` opens a page;
- `browser_read` reads it in parts or searches it;
- `browser_act` clicks, types, selects, presses and answers dialogs;
- `browser_back` goes back;
- `browser_screenshot` saves a picture to her workspace.

Logins persist in her own profile, downloads land in her workspace, and a shipped `browser` agent does heavy browsing on whatever model the owner routes it to. Every call is a span, and a claim the trace does not back is corrected.

**Architecture:**
- **The engine — `deploy/browser/Dockerfile` and the `browser` compose service.**
  - Microsoft's Playwright MCP server, pinned by digest.
  - A derived image that only creates the two directories its volumes mount over.
  - Reached by core alone, at `http://browser:8931/mcp`.
  - No host port.
- **`app/browser/page.py` — the engine's answer, read once into a value:**
  - the page (URL, title, HTTP status);
  - the snapshot;
  - dialogs, finished downloads and result files;
  - the engine's error;
  - and what its own code says it acted on.
- **`app/browser/reader.py` — a page as text she can read.**
  - The YAML accessibility snapshot is rendered into lines (headings, paragraphs, items, rows, and `[ref] role "name"` for every control).
  - The lines are cut into parts, or searched.
  - Pure and linear.
- **`app/browser/files.py` — the files the engine reports, brought into the calling turn's workspace.**
  - Checked by size and sha256 before the engine's copy is removed.
  - Names made safe; never overwritten; links refused.
- **`app/browser/engine.py` — the one way core calls the engine.**
  - Through S37a's `mcp.client`, never her `mcp_call`, never a row in `mcp_servers`.
  - One lock per loop holds a tool's whole sequence of calls.
- **`app/tools/browser.py` — her five tools.**
- **`app/browser/agent.py` — the `browser` agent**, made once, through `app/agents.py`'s own writer, once an owner exists.
- **Small edits elsewhere:** URL masking in `chat._redact`, and the guards learning the browser (`app/guards.py`).

**Tech Stack:** Python 3.12, FastAPI, asyncpg, httpx, through S37a's hand-rolled MCP client (no new dependency). Docker Compose 5.5.1, and `mcr.microsoft.com/playwright/mcp` v0.0.82 by digest. No web (`apps/web`) change.

**Spec** (binding in this order):
1. [`spec.md`](spec.md) (`4dce578a`), owner-approved 2026-09-30.
2. S37a's spec and plan (`git -C ~/workspace/nova show slice/mcp-client:docs/plans/rebuild/s37a/plan.md`, `3282b820`): the client library this slice calls, and its fixture seam.
3. The pinned engine's own behaviour.
   - Its README at the tag: `https://raw.githubusercontent.com/microsoft/playwright-mcp/v0.0.82/README.md`.
   - Its answers, captured 2026-09-30 and committed beside this plan in `services/core/tests/fixtures/browser_engine/v0.0.82/` (commit `test(s38): the pinned engine's answers`).
   - Where the README and a capture disagree, the capture wins.
4. The repo's `CLAUDE.md` house rules.

---

## Global Constraints

Every task's requirements include these.

**Rulings**
- **No approvals** (owner ruling 2026-09-03, `no-approvals.md`). Nothing asks and nothing blocks.
  - A page that steers her is recorded, never refused (doing-things Q13, answered 2026-09-30).
  - `services/core/tests/test_no_approvals.py` stays **unchanged and green**.
  - The `Tool` and `ToolContext` field sets do not change.
  - `tools.dispatch` does not change.
- **Never report success you did not check.**
  - A download is "in your workspace" only after its copy's size and sha256 matched the engine's file.
  - A page is "opened" only when the engine answered with no error and a status under 400.
  - An action's result says what the engine REPORTED, never just "clicked".
- **One browser that reaches everything** (owner, 2026-09-30): the internet, the LAN, the tailnet and Nova's own UI. No network wall is built. Nova's own services still need their service token on every route (`services/gateway/app/auth.py:19-31`, the same in all three).

**Credentials and addresses**
- **No token in the trace:** every `url`-keyed span argument loses its user info, query and fragment (`<masked:N chars>`), and so does every address in a fact or a tool result. A reset or sign-in link carries its token in the query.
- **Typed text is never echoed:** what she types (`browser_act` `value` on `type`) is never in a result or a fact. It is a span argument like any other (a carry: sign-ups wait for doing-things Q6's store).
- **The repo is PUBLIC:** no real token, tailnet address, username or home path in code, fixtures or docs. Fixture addresses use `http://site:8000` (the capture's own throwaway host), `https://example.com`, or a reserved `.invalid` host (the eval cases).

**Dependencies and interfaces**
- **No new dependency.** The engine is an image; core calls it through S37a's `app.mcp.client`.
- **This slice consumes S37a's names exactly as its plan defines them:**
  - `client.Endpoint(name, url, token=None, headers={})` and `.origin`;
  - `client.call(endpoint, tool, arguments, *, timeout_s=60.0, progress=None) -> CallResult` (`.text`, `.is_error`, `.structured`, `.notes`, `.bytes`);
  - `client.ClientError(reason, reachable)`, and `client.RpcError(ClientError)`;
  - `client.plant(transports) -> Token`, `client.unplant(token)`;
  - `fake.FakeSpec`/`FakeTool`/`FakeServer`/`transport`;
  - `cases.FixtureMcpServer`/`FixtureMcpTool` with `listed: false`.
- **said-not-done is on `main`** (PR #90, `c01bcf47`): `tools.dispatch()` takes an optional `reached` list, and every tool span records `reached_executor`. Her five tools are registered tools dispatched through `tools.dispatch`, so they are covered with no change here. Its append-only guards (`written_call`, `device_completion`) sit in `guards.py` beside Task 7's edits. This plan's code was validated on `60841594`, before PR #90: **to verify in Task 7** that the eleven anchors still match exactly once against the rebased file (its Step 3 stops on any that does not), and in Task 5 that the registry and dispatch tests pass with `reached` in place.
- **Engine tool names are the pinned engine's:** `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_select_option`, `browser_press_key`, `browser_handle_dialog`, `browser_navigate_back`, `browser_take_screenshot`, `browser_file_upload` (measured in `03-tools-list.json`: 25 tools). Her five tools never call `browser_run_code_unsafe` or `browser_evaluate`.

**Pins that move, and collisions**
- **What moves:**
  - Registry: +5 names.
  - `reads_only`: +3 (`browser_open`, `browser_read`, `browser_back`).
  - `NOT_AUTO_RUN`: +3.
  - The guard sweep's counts: old-shape ids +2, all ids +4 (162 → 164 and 221 → 225 on `60841594`).
  - Corpus: +3 cases, `suite_version` +1.
  - Health-checked services: +1 (`browser`).
- **Counts are stated as deltas** because S37a (registry +4, corpus +4, suite 17 → 18, guard sweep +2/+8) and S42b (registry +1) land around this slice. Task 0 reads the live numbers.
- **No migration.** The agent is made by code (decision B16), so this slice takes no migration number. It does not collide with S37a's or S42b's `038`.

**Guards**
- Pure, precision-first; a false fire costs one true sentence.
- They read HER reply, never the owner's message (no-phrase-matchers ruling, 2026-09-27).
- Every new regex is swept by `tests/test_guard_regex_timing.py` at 200 and 1,500 characters under 50 ms. CI runs the full core suite on every push since PR #89, so aim far below the budget. Measured on this plan's patch: 0.13 ms worst.
- Follow PR #89's style for any pattern that walks whitespace: possessive runs, and lookbehinds that stop a search re-walking a run.

**Git**
- Branch `slice/s38-browser`, worktree `~/workspace/nova/.worktrees/browser` (`$W`).
- Always `git -C <path>`. Stage by explicit path, never `git add -A` or `git add .`. Never a bare `git stash`. Run `git -C $W show --stat HEAD` after each commit.
- Commit with `NOVA_SKIP_HOOKS=1`: the pre-commit hook targets v3's `frontend/`.
- Every commit message ends with the two trailer lines:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01DFVvjmicBfxQjL1oY3RqtA
  ```
  A subagent's `Co-Authored-By` may name its own model. The `Claude-Session` line stays verbatim.
- Do NOT touch `.worktrees/s42b`, `.worktrees/mcp`, `.worktrees/said-not-done*`, or anything uncommitted in the main checkout.
- `Write`/`Edit` may refuse `.worktrees/` paths. Write through `bash` heredocs, or write in your scratch dir and `cp`.

**Tooling**
- **Formatting:** `uv run ruff format` ONLY the Python files you edited; v4's trees are not format-clean. `uv run ruff check app tests` stays clean.
- **Core tests:** your OWN scratch database `nova_core_s38` on `nova-scratch-pg` (127.0.0.1:55432), from `$W/.superpowers/sdd/s38.env` (Task 0). Report the skipped count; 0 is expected.
- **Throwaway containers** (Task 1, Task 11): a unique name prefix (`s38-`), their own network, loopback ports only, never the `nova` project or its network. Remove them, their networks and volumes before the step ends. Run docker command lines under `bash`: zsh does not word-split an arguments variable, and the engine then refuses the whole string as one option (measured 2026-10-01).

**Deploy and operation**
- **Deploy from `~/workspace/nova` on `main`**, never from a worktree (owner, 2026-09-25).
- **Operating the running system is hers.** The walk is in the owner's words, and every trace is read by turn id.

## The engine, measured (2026-09-30 and 2026-10-01, the pinned digest, on the mini PC)

Recorded once here; tasks cite it.

**The image**
- **Pin:** `mcr.microsoft.com/playwright/mcp:v0.0.82@sha256:77dccc5ce9e94cb8ae7ebea87ddbb6cd54b05760c4d63c54e16accf2726b8734` (the multi-arch index; amd64 manifest `sha256:a8e5493f…19a5`).
  - v0.0.82 was MCR's newest tag on 2026-09-30.
  - npm's 0.0.83 (2026-09-28) was not on MCR yet.
- **What it runs:** user `node` (uid 1000); `ENTRYPOINT ["node", "/app/cli.js", "--headless", "--browser", "chromium", "--no-sandbox"]`; no `VOLUME`, no `EXPOSE`, no healthcheck.

**Protocol and sessions**
- **Protocol: the 2025 era only.**
  - A 2026-07-28 `server/discover` gets HTTP 400 `{"code": -32000, "message": "Bad Request: Server not initialized"}`.
  - The `initialize` handshake answers `protocolVersion` 2025-11-25, `serverInfo` `Playwright 1.64.0-alpha-1789764292000`, as SSE.
  - S37a's client falls back to the handshake on any unrecognised refusal, so this needs nothing new. A session id the engine no longer knows gets HTTP 404 `Session not found`, which the client re-establishes once.
- **Host check:**
  - With `--allowed-hosts browser:8931`, a request with Host `127.0.0.1:8931` gets HTTP 403 `Access is only allowed at browser:8931`.
  - With both hosts allowed, `GET /mcp` gets HTTP 400 `Invalid request`. That is the healthcheck's signal.
- **Sessions share one page with `--shared-browser-context`.** A second and a third session saw the page the first had opened. A persistent profile serves one browser instance, so this flag is required.

**Volumes and memory**
- **Volumes:**
  - A fresh named volume over a path the stock image lacks is root-owned, and the engine cannot write (`touch: cannot touch '/profile/x': Permission denied`).
  - The derived image (Task 1) fixes it, and copy-up then gives the volume to uid 1000.
  - An empty volume mounted first elsewhere is still taken over on the engine's mount.
  - The engine (uid 1000) and core's `appuser` (uid 1000) read and delete each other's files.
- **The profile lock is harmless.** After a hard kill (`docker kill`) and a new container on the same profile volume, and after kill-and-start of the same container, the next navigation succeeded. Chromium took over the stale `SingletonLock` both times.
- **Memory:** 86 MiB idle with no browser launched; about 258 MiB after two small pages; the profile was 2.3 MB.

**What the engine writes and answers**
- **Output:**
  - Downloads, screenshots and console logs land in `--output-dir`.
  - A console log is written for a page that logs an error, even at `--console-level error`.
  - `--output-max-size` evicts the oldest files not written in the current answer.
- **Answers** (all in the committed captures):
  - `### Page` carries `Page URL`, `Page Title`, `HTTP status` (only when 4xx/5xx) and `Console`.
  - `### Snapshot` holds a fenced YAML tree with refs like `[ref=f3e4]`. The prefix changes with each document; never assume `e4`.
  - `### Events` holds `Downloaded file <name> to "<path>"`.
  - `### Modal state` holds `["alert" dialog with message "…"]: can be handled by browser_handle_dialog`.
  - `### Result` holds a screenshot link `[Screenshot of viewport](/output/page-….png)`.
  - `### Error`, with `isError: true`.
  - `### Ran Playwright code`, which holds typed text: never passed on.
- **What each action's answer contains:**
  - Navigating, a click that navigates, and `browser_navigate_back` carry a `### Page`.
  - Type, select and press carry no `### Page`.
  - An alert blocks every other tool until handled: `Tool "browser_snapshot" does not handle the modal state.`
  - A stale ref: `Ref e9999 not found in the current page snapshot. Try capturing new snapshot.`
  - DNS failure: `browserBackend.callTool: net::ERR_NAME_NOT_RESOLVED at …` plus a call log.
  - A 404 is NOT an error to the engine: `HTTP status: 404 File not found`, `Page Title: Error response`.
- **Snapshot size:** a 400-paragraph page is a 55,423-character answer; rendered, 44,163 characters, which is two parts at 24,000.
- **What moves between runs** (the whole capture re-run 2026-10-01 with the production flags and the derived image, by `capture.py`'s documented steps): only the refs' numbering (`e4` one run, `f3e4` the other) and a favicon 404 that may or may not reach the first page's `Console:` line before the answer. Every other answer matched the 2026-09-30 capture once timestamps were set aside.
- **Compose adopts a pre-created volume.** Compose 5.5.1 quietly adopted an empty volume carrying `com.docker.compose.project` and `com.docker.compose.volume` labels (data kept, no warning, no recreate prompt).

## Decisions this plan makes where the spec is wrong or silent

These go to the owner with the plan. "If wrong" names the cost if a decision turns out to be the wrong call.

| # | Where | This plan decides | If wrong |
|---|---|---|---|
| B1 | §1, the image (spec: "pinned to a version tag") | **A derived image**, `deploy/browser/Dockerfile`. `FROM` the digest above; it creates `/profile` and `/output` owned by `node`, and nothing else. Measured: the stock image cannot write a fresh volume. Core's own Dockerfile records the same trap for `/data/workspace`. | A stock image would need a root init step instead. |
| B2 | §1 (spec: "her workspace's `downloads/` folder is mounted at `/downloads`") | **The engine writes only its own volume:**<br>• `v4_browser_output` (exclude-ephemeral) at `/output`; core sees it at `/data/browser-output`.<br>• Core copies each REPORTED file into the calling turn's workspace (`downloads/`, `screenshots/`), checks size and sha256, and removes the engine's copy.<br>• Measured why: the engine writes console logs into its output folder on every page that logs an error; a page chooses a download's name.<br>• Her workspace is never the engine's to write. | One copy per file; a file over 1 GiB is stated and not copied. |
| B3 | §1, flags (spec lists six) | **The flag set** (compose, Task 1), each measured:<br>• `--allowed-hosts browser:8931,127.0.0.1:8931` (the second for the healthcheck).<br>• `--shared-browser-context`, needed for a persistent profile.<br>• `--snapshot-mode none`: actions carry no snapshot; only `browser_read` reads.<br>• `--image-responses omit`: a screenshot never arrives as image data.<br>• `--file-paths absolute`: core maps `/output/…`.<br>• `--timeout-navigation 45000`: the engine answers before the client's 60 s.<br>• `--output-max-size 2147483648`, `--console-level error`, `--idle-timeout 3600000`, `--no-webmcp`. | Any flag is one compose line and one pin in `test_browser_compose.py`. |
| B4 | Health (spec silent) | **`GET /mcp` must answer exactly 400** from inside the container. A 403 (Host check broken), a 5xx or no answer is unhealthy. The installer's health table waits for `browser`. | A future engine that answers GET differently goes unhealthy until the check is re-measured; Task 11's re-pin step says so. |
| B5 | Concurrency (spec silent) | **One engine page; one lock per event loop in core**, held for a tool's whole sequence: a navigation and the read after it are never split. Between two tool calls another turn may move the page; every result names the page it saw. | A slow navigation (≤ 45 s) delays another turn's browser call. |
| B6 | Profile lock (spec silent) | **No lock-clearing wrapper.** Measured: both restart shapes relaunched fine. | If a later engine regresses, a stale `SingletonLock` stops launches; Task 11's walk restarts the engine to catch that. |
| B7 | `browser_open` on a 4xx/5xx (spec silent) | **A stated failure**, like `fetch_url` (it refuses ≥ 400, `app/tools/web.py:185-191`). It names the status and that the browser now shows the site's error page; `browser_read` can still read it. | She cannot treat an error page as an opened page. |
| B8 | `browser_act` actions (spec: click, type, select, press) | **Also `accept` and `dismiss`**, mapped to `browser_handle_dialog`. Measured: a page's alert blocks every other engine tool until answered.<br>• `submit` (boolean) on `type`: the engine's own flag (Enter after typing).<br>• `press` takes no ref (the focused page).<br>• `dismiss` on a file chooser cancels it through `browser_file_upload` with no paths (the engine's documented cancel; NOT measured, stated in Known limits). | A dialog would otherwise wedge her browser until the idle timeout. |
| B9 | "What changed" (spec: "or 'nothing on the page changed'") | **Never "nothing changed"**: typing changes a field. The result names what the engine reported (a new page, a dialog, a download) or says "the engine reported no new page, dialog or download". | None. |
| B10 | Naming the element acted on (spec silent) | **From the engine's own code** (`getByRole('link', { name: 'Page two' })` becomes `link "Page two"`; `getByLabel` and `getByText` too). Only the locator is read; the code section never reaches her, because `.fill()` holds what she typed. | An element the engine located another way is named by its ref. |
| B11 | `browser_read` caching (spec silent) | **A fresh snapshot on every call**; parts are cut from that read. Refs are the engine's and go stale when the page changes; the engine's refusal is passed on as "read the page again". | Reading part 3 of a page that changed since part 2 shows the new page's part 3, and says which page. |
| B12 | Query (spec: "the sections that contain every word") | **Lines, not sections:**<br>• Lines (a heading, paragraph, item, row or control) holding every word, case-insensitive.<br>• Each comes with its part number and the heading above it.<br>• At most 40, with the total. A "section" on a page with one heading would be the whole page. | None. |
| B13 | Span "meta `{url, title}`" (spec §4) | **Facts, not meta keys** (S37a's P8 shape):<br>• `{"browser": "page", "url", "title", "status"}` per call that saw a page.<br>• `{"browser": "download" or "screenshot", "path", "bytes"}`.<br>• The key `browser` arms no existing fact reader (not `device`, `agent`, `machine` or `mcp_server`). | A reader that wants `meta.url` reads `meta.facts`. |
| B14 | Masking (spec: "the URL is stored without its query string") | **For every tool's `url` argument**, `fetch_url` included: the spec's reason (reset links) holds there too. User info, query and fragment become `<masked:N chars>`. The narration guard compares claims without the query. | Activity no longer shows a fetched address's query; her reply still names it. |
| B15 | Guards (spec §4) | **The browser joins existing guard families** (validated on a copy of `60841594`: 3,241 guard tests pass):<br>• `_FETCH_TOOLS` gains the three page tools.<br>• `_target_of` reads the asked and landed addresses.<br>• `_FETCH_VERB_TOKENS` gains `opened` and `navigated`.<br>• A narration kind `browser_acted` is backed only by an ok `browser_act`.<br>• `_FETCH_URL`'s tools gain `browser_open`.<br>• **The deferral commitment check reads the whole class.** Measured on 60841594: it checked only the first registered tool, so `browser_open` could never keep "I'll open that page".<br>• Two capability rows: clicking, forms and interacting with pages → `browser_act`; screenshots of web pages → `browser_screenshot`. | A missed claim is the safe direction; every new false fire is pinned by a must-not-fire case. |
| B16 | The agent (spec: "the migration inserts the agent row") | **Made by code, not a migration**:<br>• An agent needs an owner, a log conversation and a folder, and a fresh install has no owner at migration time.<br>• Made at startup and from the scheduler's loop, the beats' shape (`beats.ensure_beats`, `scheduler.py:658-687`).<br>• `created_via="page"`, actor `seed (S38)`: migration 021's CHECK admits only chat/page, and the eval harness made the same call (`evals/runner.py:390-397`).<br>• A governance event `agent.seeded` makes it once: a deleted agent stays deleted, and an existing `browser` is left alone. | The Agents page shows it as made on the page. |
| B17 | Where the agent's downloads land (spec §3 note: "Nova's `downloads/`") | **The calling turn's workspace root**: Nova's `downloads/`, or `agents/browser/downloads/` when the agent downloads. S12's containment is kept, and Nova reads both. | Nova finds the agent's files one folder down; the agent's report names the path. |
| B18 | Backup coverage (spec: "`v4_browser_profile` include") | **Kept `include`.** The real-stack coverage tests read the live compose file, so Task 1 must refresh the backup fixtures in the same commit, and the new volume must EXIST for the probe:<br>• Task 1 creates it empty on the hub, labelled the way compose labels its own (measured: compose adopts it quietly).<br>• Then `refresh.sh`.<br>• This touches the hub before merge: one empty volume, nothing started. | Without it, the real-stack tests stay red (R5) until deploy. |
| B19 | Limits (spec: parts of 24,000, max 200,000) | **Limits:**<br>• Parts: 2,000–200,000, default 24,000.<br>• A copied file: ≤ 1 GiB.<br>• Snapshot nesting read to depth 100. Measured: 5,000 levels raised `RecursionError` before the cap.<br>• Attributes read by index. Measured: re-slicing took 9 s for 200,000 attributes; 92 ms after. | A deeper page's tail reads as siblings at depth 100. |
| B20 | Eval fixture (spec: "a declared fake engine") | **Declared through S37a's seam:** `listed: false`, `url: http://browser:8931/mcp`, `era: legacy` and `respond: sse` (the real engine's era, and its event-stream answers, both measured). The canned answers are written in the captures' exact format. | None. |
| B21 | The live eval world (spec silent) | **The seeded `browser` agent sits in every live eval turn's roster.** The agents table is household-wide, and the runner adds fixtures without hiding real rows (`evals/runner.py:31-49`). Not changed here; Task 11's eval × 3 reads any regression by turn id. | A case that used to call a tool might now delegate to the agent instead. |
| B22 | Web (spec silent) | **No `apps/web` change:**<br>• Routing already lists `agent_<name>` roles (`RoutingSection.tsx:42`).<br>• Activity shows span facts (S37a P8).<br>• The 393 px check is Routing with `agent_browser` on it (Task 11). | None. |

## Review Focus

These are the failure modes most likely to reach a person, most likely first. Each names the test that pins it and its task.

1. **A page-chosen download name must never escape the workspace, overwrite her file, or follow a link out of the engine's volume.** Tests: `test_a_page_chosen_name_stays_one_file_in_the_folder`, `test_an_existing_file_is_never_overwritten`, `test_a_link_in_the_engine_volume_is_refused_and_removed`, `test_an_engine_path_outside_its_folder_is_refused` (Task 3).
2. **A dialog a page opens must not wedge her.**
   - The act result names the dialog and how to answer it.
   - `browser_read` refuses with the same instruction.
   - `accept`/`dismiss` clear it.
   - Tests: `test_a_dialog_is_named_with_how_to_answer_it`, `test_reading_under_a_dialog_says_to_answer_it_first` (Task 5).
3. **A long page must be readable on a 32K local model:** parts within their size on line boundaries; one huge line cut; a bounded search. Tests: `test_the_long_capture_is_two_parts_and_the_needle_is_in_part_two`, `test_a_line_longer_than_a_part_is_cut_inside` (Task 2).
4. **The reader must stay linear on core's event loop.** Tests: `test_a_hostile_snapshot_is_read_in_bounded_time` (depth, attributes, quotes, an unclosed name), `test_a_four_mebibyte_snapshot_reads_in_time` (Task 2).
5. **A token in a URL must never reach `turn_spans`, and an honest "I opened <address with a query>" must not then be corrected.** Tests: `test_a_url_argument_loses_its_query_fragment_and_user` (Task 6), `test_the_query_is_not_compared_because_the_trace_never_holds_it` (Task 7), `test_no_query_reaches_a_result_or_a_fact` (Task 5).
6. **A deleted seeded agent must stay deleted.** Test: `test_a_deleted_agent_is_not_made_again` (Task 8).
7. **A navigation and its read must never be split by another turn.** Test: `test_two_opens_at_once_never_interleave_their_calls` (Task 4).
8. **The engine down is a stated failure naming the engine, never a crash.** Tests: `test_an_unreachable_engine_is_a_stated_failure`, `test_every_tool_says_the_engine_is_not_answering` (Tasks 4 and 5).
9. **The deferral must not fire on an honest "I'll open that page" that she then opened with `browser_open`.** Test: `test_a_promise_to_open_a_page_is_kept_by_browser_open` (Task 7).

---

## File map

**`services/core`**

| File | Responsibility |
|---|---|
| `app/browser/__init__.py` | Package docstring only (imports nothing: `app.tools` imports these modules at import time). |
| `app/browser/page.py` | The engine's answer read into an `EngineAnswer`. Pure. |
| `app/browser/reader.py` | Snapshot → lines → parts, outline, search. Pure. |
| `app/browser/files.py` | Reported files brought into a workspace, checked. |
| `app/browser/engine.py` | `endpoint()`, `session()`, `call()`, `EngineError`. |
| `app/browser/agent.py` | `SPEC`, `ensure_browser_agent()`. |
| `app/tools/browser.py` | Her five tools. |
| `app/tools/__init__.py` | Registers them. |
| `app/live_facts.py` | Three `NOT_AUTO_RUN` reasons. |
| `app/chat.py` | `_address_without_secrets` in `_redact`. |
| `app/guards.py` | The browser in the fetch family, `browser_acted`, the class-wide deferral, two capability rows. |
| `app/governance.py` | `AGENT_SEEDED`. |
| `app/main.py`, `app/scheduler.py` | Call `ensure_browser_agent` (startup; the loop until it settles). |
| `app/evals/cases/*.json` | Three cases; `suite_version` +1 everywhere. |
| `Dockerfile` | `/data/browser-output` created for `appuser`. |
| `tests/fixtures/browser_engine/v0.0.82/` | The captures, `capture.py`, `site/`. Committed with this plan. |
| `tests/browser_engine.py` | `answer_text(step)` and `fake_engine(...)`, shared by the tests. |
| `tests/test_browser_*.py`, `tests/test_span_url_masking.py` | One file per task. |

**Elsewhere**

| File | Responsibility |
|---|---|
| `deploy/browser/Dockerfile` | The derived engine image. |
| `deploy/docker-compose.yml` | The `browser` service; two volumes; core's mount and env. |
| `deploy/install.sh`, `deploy/install_test.sh` | `browser` health-checked. |
| `deploy/backup/fixtures/*`, `deploy/backup/tests/test_coverage_v4_real.py` | Refreshed fixtures; the carried set gains the profile. |
| `deploy/README.md` | The browser section. |
| `docs/plans/rebuild/s38/plan.md` | This plan, and its close-out. |

---

## Task 0: Baseline (prerequisite; no commit)

The worktree `~/workspace/nova/.worktrees/browser` is on `slice/s38-browser`. It holds the spec (`4dce578a`), the captures and this plan.

- [ ] **Step 1: Rebase onto today's `main` and read what has landed**

```bash
W=~/workspace/nova/.worktrees/browser
git -C ~/workspace/nova fetch -q origin
git -C $W rebase origin/main && git -C $W log --oneline -5
test -f $W/services/core/app/mcp/client.py && echo CLIENT-PRESENT || echo no-client
test -f $W/services/core/app/mcp/servers.py && grep -q "class FixtureMcpServer" $W/services/core/app/evals/cases.py && echo EVAL-SEAM-PRESENT || echo no-eval-seam
```

Expected: the rebase succeeds.
- **Tasks 1–3 need nothing of S37a**, and start now.
- **Tasks 4–9 need S37a on `main`.** After the rebase, `CLIENT-PRESENT` and `EVAL-SEAM-PRESENT` are the signal, read from the rebased tree rather than from a branch ref that may be gone after the merge. If either is missing when Task 3 is done, stop and say so; never build on `slice/mcp-client` directly.
- Each task names the S37a task it waits on.

- [ ] **Step 2: The SDD workspace, your own scratch database, the baseline suites**

```bash
W=~/workspace/nova/.worktrees/browser
mkdir -p $W/.superpowers/sdd && printf '*\n' > $W/.superpowers/sdd/.gitignore
PW=$(docker inspect nova-scratch-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')
docker exec nova-scratch-pg createdb -U postgres nova_core_s38 2>/dev/null || true
printf 'export W=%s\nexport CORE_DB=postgresql://postgres:%s@127.0.0.1:55432/nova_core_s38\n' "$W" "$PW" > $W/.superpowers/sdd/s38.env
. $W/.superpowers/sdd/s38.env && cd $W/services/core && uv sync -q && TEST_DATABASE_URL="$CORE_DB" uv run pytest -q -rs --timeout=120 2>&1 | tail -4
```

Then record the live registry count for the close-out:

```bash
. $W/.superpowers/sdd/s38.env && cd $W/services/core && uv run python -c "from app import tools; print('registry', len(tools.REGISTRY))"
```

Expected:
- Core green, 0 skipped. PR #89 made the regex sweep linear, so the N150's old timing edge should no longer appear. Record the count.
- The registry count: 48 on `60841594`; S37a adds 4 and S42b 1.
- **If anything is red, stop and report.**
- The env file holds the scratch password, under the `*` `.gitignore`, so it can never be staged.

From here on, every core test command starts with `. ~/workspace/nova/.worktrees/browser/.superpowers/sdd/s38.env && cd $W/services/core &&`, abbreviated below as **`CORE`**.

---

## Task 1: The engine service — image, compose, volumes, health, backup coverage

Needs nothing of S37a; it can run while S37a is being built.

**Files:**
- Create: `deploy/browser/Dockerfile`
- Modify: `deploy/docker-compose.yml`:
  - the `browser` service, after `searxng`;
  - two volumes;
  - `core`'s mount and environment.
- Modify: `services/core/Dockerfile` (the mount point)
- Modify: `deploy/install.sh` (`HEALTH_CHECKED_SERVICES`)
- Modify: `deploy/install_test.sh` (one assertion)
- Modify: `deploy/backup/fixtures/*` (refreshed by `refresh.sh`, never by hand)
- Modify: `deploy/backup/tests/test_coverage_v4_real.py` (the carried set)
- Test: `services/core/tests/test_browser_compose.py`

**Interfaces:**
- Consumes: nothing of this slice.
- Produces:
  - The service `browser`, reachable in-network at `http://browser:8931/mcp`.
  - Core's environment: `BROWSER_MCP_URL=http://browser:8931/mcp` and `BROWSER_OUTPUT_DIR=/data/browser-output`.
  - The volumes `v4_browser_profile` (engine `/profile`) and `v4_browser_output` (engine `/output`, core `/data/browser-output`).

- [ ] **Step 1: Write the failing test** — `services/core/tests/test_browser_compose.py`

```python
"""Her browser's engine as deployed (S38), pinned from the files a human edits:
what core can reach, what the engine may do, and where its state lives. Read
the way test_traces.py reads the grace period, from deploy/ and the
Dockerfiles, so a hand edit that drops a measured flag goes red here."""

from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
COMPOSE = yaml.safe_load((ROOT / "deploy" / "docker-compose.yml").read_text())
ENGINE_DOCKERFILE = (ROOT / "deploy" / "browser" / "Dockerfile").read_text()
PIN = (
    "mcr.microsoft.com/playwright/mcp:v0.0.82"
    "@sha256:77dccc5ce9e94cb8ae7ebea87ddbb6cd54b05760c4d63c54e16accf2726b8734"
)


def _service(name: str) -> dict:
    return COMPOSE["services"][name]


def _flag(command: list[str], name: str):
    """The value after `name` in the engine's arguments, True for a bare flag,
    None when it is absent."""
    if name not in command:
        return None
    at = command.index(name)
    following = command[at + 1] if at + 1 < len(command) else None
    if following is None or following.startswith("--"):
        return True
    return following


def _instructions(text: str) -> list[str]:
    return [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def test_the_image_is_the_pinned_digest_and_only_adds_the_two_folders():
    lines = _instructions(ENGINE_DOCKERFILE)
    assert lines[0] == f"FROM {PIN}"
    assert "RUN mkdir -p /profile /output && chown node:node /profile /output" in lines
    assert lines[-1] == "USER node"
    # The engine's own entrypoint stands: no second way to start it.
    assert not any(line.startswith(("ENTRYPOINT", "CMD", "EXPOSE", "VOLUME")) for line in lines)


def test_the_engine_publishes_no_port_and_is_built_from_its_folder():
    browser = _service("browser")
    assert "ports" not in browser
    assert browser["build"]["context"] == "./browser"
    assert browser.get("init") is True
    assert browser["restart"] == "unless-stopped"


def test_the_engine_runs_with_the_measured_flags():
    command = [str(part) for part in _service("browser")["command"]]
    assert _flag(command, "--port") == "8931"
    assert _flag(command, "--host") == "0.0.0.0"
    assert _flag(command, "--allowed-hosts") == "browser:8931,127.0.0.1:8931"
    assert _flag(command, "--no-webmcp") is True
    assert _flag(command, "--shared-browser-context") is True
    assert _flag(command, "--user-data-dir") == "/profile"
    assert _flag(command, "--output-dir") == "/output"
    assert _flag(command, "--output-max-size") == "2147483648"
    assert _flag(command, "--image-responses") == "omit"
    assert _flag(command, "--snapshot-mode") == "none"
    assert _flag(command, "--file-paths") == "absolute"
    assert _flag(command, "--timeout-navigation") == "45000"
    assert _flag(command, "--console-level") == "error"
    assert _flag(command, "--idle-timeout") == "3600000"
    for absent in ("--isolated", "--allow-unrestricted-file-access", "--caps", "--extension"):
        assert absent not in command, absent


def test_the_healthcheck_wants_exactly_the_400_a_bare_get_measures():
    check = _service("browser")["healthcheck"]
    assert check["test"][:3] == ["CMD", "node", "-e"]
    assert "http://127.0.0.1:8931/mcp" in check["test"][3]
    assert "r.status===400" in check["test"][3]


def test_the_profile_is_carried_and_the_output_is_not():
    volumes = COMPOSE["volumes"]
    assert volumes["v4_browser_profile"]["x-nova-backup"] == "include"
    assert volumes["v4_browser_profile"]["x-nova-backup-reason"].strip()
    assert volumes["v4_browser_output"]["x-nova-backup"] == "exclude-ephemeral"
    assert volumes["v4_browser_output"]["x-nova-backup-reason"].strip()
    mounts = _service("browser")["volumes"]
    assert "v4_browser_profile:/profile" in mounts
    assert "v4_browser_output:/output" in mounts


def test_core_sees_the_engine_output_and_knows_where_the_engine_is():
    core = _service("core")
    assert "v4_browser_output:/data/browser-output" in core["volumes"]
    assert core["environment"]["BROWSER_MCP_URL"] == "http://browser:8931/mcp"
    assert core["environment"]["BROWSER_OUTPUT_DIR"] == "/data/browser-output"
    # A missing engine is a stated failure in her tools, never a core that
    # will not start.
    assert "browser" not in (core.get("depends_on") or {})


def test_core_image_creates_the_output_mount_point_for_appuser():
    dockerfile = (ROOT / "services" / "core" / "Dockerfile").read_text()
    assert "mkdir -p /data/workspace /data/browser-output && chown -R appuser /data" in dockerfile
```

- [ ] **Step 2: Run it to see it fail**

Run: `CORE uv run pytest -q tests/test_browser_compose.py`
Expected: FAIL at collection, `FileNotFoundError: … deploy/browser/Dockerfile`.

- [ ] **Step 3: The image** — create `deploy/browser/Dockerfile`

```dockerfile
# Her browser's engine (S38): Microsoft's Playwright MCP server, pinned by
# digest, with the two folders its named volumes mount over created as `node`.
#
# Docker initialises an EMPTY named volume from the image path it is mounted
# over, ownership included. The stock image has neither /profile nor /output,
# so a fresh volume arrived root-owned and the engine (uid 1000, `node`) could
# not write its profile — measured 2026-09-30: `touch: cannot touch
# '/profile/x': Permission denied`. The same trap core's Dockerfile records
# for /data/workspace.
#
# Pinned 2026-09-30: v0.0.82 was the newest tag on MCR (npm's 0.0.83 of
# 2026-09-28 was not published there yet). Re-pinning re-runs
# services/core/tests/fixtures/browser_engine/capture.py, and the tests that
# read its captures say what moved.
FROM mcr.microsoft.com/playwright/mcp:v0.0.82@sha256:77dccc5ce9e94cb8ae7ebea87ddbb6cd54b05760c4d63c54e16accf2726b8734
USER root
RUN mkdir -p /profile /output && chown node:node /profile /output
USER node
```

- [ ] **Step 4: The service, the volumes, core's view** — in `deploy/docker-compose.yml`

After the `searxng` service (before `ollama`), add:

```yaml
  browser:
    # Her browser (S38): Microsoft's Playwright MCP server, pinned by digest
    # in ./browser/Dockerfile. Core alone calls it, at http://browser:8931/mcp,
    # through its own MCP client (app/browser/engine.py) — never through her
    # mcp_call, and never as a row in mcp_servers. Her five tools are core's
    # (app/tools/browser.py) and never call the engine's run-any-code tools.
    #
    # No host port. The engine has no authentication of its own; anything on
    # this network could drive it, and only core does. One browser that
    # reaches everything — the internet, the LAN, the tailnet and Nova's own
    # UI — by the owner's choice (2026-09-30); the other services still need
    # their service token, so reaching them gains a page nothing.
    #
    # No depends_on in either direction: a browser that is down is a stated
    # failure in her tools, never a core that will not start.
    build:
      context: ./browser
    restart: unless-stopped
    # Chromium forks helpers; the image runs node as PID 1 with no reaper.
    init: true
    command:
      - "--port"
      - "8931"
      - "--host"
      - "0.0.0.0"
      # The engine refuses any other Host header (measured: 403 "Access is
      # only allowed at browser:8931"). 127.0.0.1 is the healthcheck's.
      - "--allowed-hosts"
      - "browser:8931,127.0.0.1:8931"
      # A page may not hand her tools of its own.
      - "--no-webmcp"
      # A persistent profile serves one browser instance, so every session —
      # a core restart starts a new one — shares this one context and page.
      - "--shared-browser-context"
      - "--user-data-dir"
      - "/profile"
      # Downloads, screenshots and the engine's console logs. Core copies
      # what the engine REPORTS into her workspace (app/browser/files.py);
      # the rest is evicted past this size, oldest first.
      - "--output-dir"
      - "/output"
      - "--output-max-size"
      - "2147483648"
      # A screenshot never travels as image data; actions carry no snapshot
      # (browser_read reads the page); paths come back absolute, so core can
      # map /output/… to its own mount.
      - "--image-responses"
      - "omit"
      - "--snapshot-mode"
      - "none"
      - "--file-paths"
      - "absolute"
      # Under core's 60 s call timeout, so a slow page is the engine's own
      # stated timeout rather than a client that gave up.
      - "--timeout-navigation"
      - "45000"
      - "--console-level"
      - "error"
      # Chromium closes after an idle hour and relaunches on the next call.
      - "--idle-timeout"
      - "3600000"
    volumes:
      - v4_browser_profile:/profile
      - v4_browser_output:/output
    healthcheck:
      # A bare GET of the MCP endpoint answers exactly 400 "Invalid request"
      # (measured 2026-10-01): the server is up and past its Host check. A 403
      # means the Host check moved; anything else, it is not serving.
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8931/mcp').then(r=>process.exit(r.status===400?0:1),()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 20s
```

In the `core` service's `environment`, after `WORKSPACE_ROOT`, add:

```yaml
      # Her browser (S38): where the engine listens, and where core sees the
      # files it writes (the same volume as its /output).
      BROWSER_MCP_URL: http://browser:8931/mcp
      BROWSER_OUTPUT_DIR: /data/browser-output
```

In the `core` service's `volumes`, after `- v4_workspace:/data/workspace`, add:

```yaml
      # The browser engine's output (S38). Core copies a reported download or
      # screenshot from here into the workspace and removes the engine's copy.
      - v4_browser_output:/data/browser-output
```

In the top-level `volumes:`, after `v4_workspace`, add:

```yaml
  v4_browser_profile:
    x-nova-backup: include
    x-nova-backup-reason: >-
      her browser profile (S38): the sites she is signed in to. The bundle is
      encrypted. Chromium's caches ride along; they cost size, nothing else.
  v4_browser_output:
    x-nova-backup: exclude-ephemeral
    x-nova-backup-reason: >-
      the browser engine's scratch: downloads and screenshots before core
      copies them into v4_workspace (which carries them), and its console logs.
```

- [ ] **Step 5: Core's mount point** — in `services/core/Dockerfile`

Replace `RUN mkdir -p /data/workspace && chown -R appuser /data` with:

```dockerfile
RUN mkdir -p /data/workspace /data/browser-output && chown -R appuser /data
```

and add one line to the comment above it: `# /data/browser-output (S38) is the browser engine's output volume, for the same reason.`

- [ ] **Step 6: The installer waits for it** — `deploy/install.sh` and `deploy/install_test.sh`

In `deploy/install.sh`, replace the `HEALTH_CHECKED_SERVICES=` line and add to the comment above it:

```bash
# browser (S38) comes up with the base stack too: her browser is a capability,
# not an add-on, and an install whose engine never answered is not a success.
HEALTH_CHECKED_SERVICES="postgres core gateway memory web searxng browser"
```

In `deploy/install_test.sh`, after `expect_tn_lacks "tailnet off: tailscale not health-checked" …`, add:

```bash
expect_tn "the browser engine is always health-checked (S38)" "$TN_OFF" 0 3 "browser"
```

- [ ] **Step 7: Run the compose test, the installer suite, and a parse of the file**

Run:

```bash
CORE TEST_DATABASE_URL="$CORE_DB" uv run pytest -q tests/test_browser_compose.py tests/test_traces.py
cd $W && bash deploy/install_test.sh 2>&1 | grep -E "browser|passed,"
cd $W/deploy && docker compose -f docker-compose.yml config --services 2>/dev/null | sort | tr '\n' ' '
```

Expected:
- `20 passed` (the 7 here and test_traces' 13), none skipped.
- The installer suite prints `ok   the browser engine is always health-checked (S38)` and ends `… passed, 0 failed`.
- The services list includes `browser`.
- `docker compose config` here only parses the worktree's file; it starts nothing. Its warnings about unset variables are the worktree having no `.env`.

Validated before this plan was written, on a copy of `60841594` with Steps 1 and 3–6 applied as written: 20 passed, the installer suite 375 passed and 0 failed, and the parse listed `browser`.

- [ ] **Step 8: Build the image and prove it healthy — throwaway, on its own network**

Run (under `bash`, with the `s38-` prefix; everything is removed at the end):

```bash
bash <<'EOF'
set -u
W=~/workspace/nova/.worktrees/browser
docker build -q -t s38-browser:check "$W/deploy/browser" >/dev/null
docker network create s38-check >/dev/null
docker volume create s38-profile >/dev/null; docker volume create s38-output >/dev/null
CMD=(--port 8931 --host 0.0.0.0 --allowed-hosts browser:8931,127.0.0.1:8931 --no-webmcp --shared-browser-context --user-data-dir /profile --output-dir /output --output-max-size 2147483648 --image-responses omit --snapshot-mode none --file-paths absolute --timeout-navigation 45000 --console-level error --idle-timeout 3600000)
docker run -d --init --name s38-engine --network s38-check --network-alias browser -v s38-profile:/profile -v s38-output:/output s38-browser:check "${CMD[@]}" >/dev/null
sleep 6
docker exec s38-engine node -e "fetch('http://127.0.0.1:8931/mcp').then(r=>{console.log('health', r.status);process.exit(r.status===400?0:1)},()=>process.exit(1))"; echo "healthcheck exit $?"
docker exec s38-engine sh -c 'ls -ldn /profile /output'
docker rm -f s38-engine >/dev/null; docker network rm s38-check >/dev/null; docker volume rm s38-profile s38-output >/dev/null; docker image rm s38-browser:check >/dev/null
docker ps -a --format '{{.Names}}' | grep -c '^s38-' ; docker volume ls --format '{{.Name}}' | grep -c '^s38-'
EOF
```

Expected:
- `health 400` and `healthcheck exit 0`.
- `/profile` and `/output` owned by `1000 1000`.
- The two final counts are `0`.

If the health status is not 400, stop: the pinned engine is not the one this plan measured.

- [ ] **Step 9: The backup's real-stack fixtures, refreshed — the profile volume first**

The real-stack coverage tests read the LIVE compose file. Adding a carried volume therefore needs the fixtures refreshed in the same commit, with the volume existing on the hub so the probe can read it (decision B18).

Create it empty, labelled the way compose labels its own, so the deploy adopts it. Measured with compose 5.5.1: an empty volume carrying these two labels is adopted with no warning and no recreate prompt. Then refresh:

```bash
CV=$(docker compose version --short)
docker volume inspect nova_v4_browser_profile >/dev/null 2>&1 && echo ALREADY-THERE || \
  docker volume create --label com.docker.compose.project=nova \
    --label com.docker.compose.volume=v4_browser_profile \
    --label "com.docker.compose.version=$CV" nova_v4_browser_profile
docker volume inspect nova_v4_browser_profile --format '{{json .Labels}}'
cd $W && bash deploy/backup/fixtures/refresh.sh
git -C $W status --short deploy/backup/fixtures
```

Expected:
- The labels read back.
- `refresh.sh` writes its fixtures and prints what it wrote.
- The status shows changed fixture files only.

`refresh.sh` reads the live stack read-only (`docker ps`, `docker inspect`, a read-only probe of each carried volume, the database list). It refuses to run as root, and rewrites this checkout's and the live checkout's paths to `/repo`.

- [ ] **Step 10: The carried set gains the profile** — `deploy/backup/tests/test_coverage_v4_real.py`

In `test_the_carried_set_is_exactly_what_the_compose_file_says`, replace `assert carried == ["v4_memdata", "v4_workspace"]` with:

```python
    # S38 (2026-10-01): her browser profile — the sites she is signed in to.
    assert carried == ["v4_browser_profile", "v4_memdata", "v4_workspace"]
```

- [ ] **Step 11: Run every backup suite**

Run:

```bash
cd $W && uv run --project deploy/backup pytest -q -m "not live" deploy/backup/tests 2>&1 | tail -3
cd $W && bash deploy/backup_test.sh 2>&1 | tail -2
```

Expected:
- All pass.
- `test_the_real_v4_stack_covers_itself` has no refusals.
- `test_no_fixture_carries_a_home_directory_or_a_tailnet_name` passes over the refreshed captures.
- Anything else that names the carried volumes is changed in this commit, with the reason in the commit body.

- [ ] **Step 12: Format and commit**

```bash
CORE uv run ruff format tests/test_browser_compose.py && uv run ruff check tests/test_browser_compose.py
git -C $W add deploy/browser/Dockerfile deploy/docker-compose.yml services/core/Dockerfile deploy/install.sh deploy/install_test.sh deploy/backup/tests/test_coverage_v4_real.py services/core/tests/test_browser_compose.py
git -C $W add deploy/backup/fixtures
git -C $W status --short
NOVA_SKIP_HOOKS=1 git -C $W commit -q -F - <<'MSG'
feat(deploy): her browser's engine — pinned Playwright MCP, its two volumes, health-checked (S38)

The engine is Microsoft's Playwright MCP server at v0.0.82 by digest, in a
derived image that only creates /profile and /output for `node`: a fresh
volume over a path the stock image lacks is root-owned and the engine could
not write (measured). No host port; core reaches it at browser:8931 and sees
its output volume at /data/browser-output. Every flag is one measured on the
pinned engine (plan "The engine, measured").

Backup: v4_browser_profile is carried (include), v4_browser_output is not
(exclude-ephemeral). The real-stack fixtures were refreshed by refresh.sh in
this commit, after creating the empty profile volume on the hub with
compose's own labels so the probe could read it (compose adopts it; decision
B18). The carried set moves from two volumes to three.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFVvjmicBfxQjL1oY3RqtA
MSG
git -C $W show --stat HEAD | tail -5
```

`git add deploy/backup/fixtures` stages the refreshed captures. Read the `status` before committing: only this task's files may be staged.

---

## Task 2: The engine's answer, read — and a page, as text she can read

Needs nothing of S37a; it can run while S37a is being built. Validated before this plan was written: every test below passed against these exact files, over the committed captures.

**Files:**
- Create: `services/core/app/browser/__init__.py`, `services/core/app/browser/page.py`, `services/core/app/browser/reader.py`
- Create: `services/core/tests/browser_engine.py` (the captures' reader; Task 4 adds the fake engine to it)
- Test: `services/core/tests/test_browser_page.py`, `services/core/tests/test_browser_reader.py`
- Uses: `services/core/tests/fixtures/browser_engine/v0.0.82/*.json`, committed with this plan

**Interfaces:**
- Consumes: the captures.
- Produces (Tasks 3, 4, 5 and 9 use these names):
  ```python
  # app/browser/page.py
  ENGINE_OUTPUT = "/output/"
  @dataclass(frozen=True) class Dialog(kind: str, message: str)
  @dataclass(frozen=True) class EngineAnswer(url=None, title=None, status=None, status_text="", snapshot=None,
                                             dialogs=(), downloads=(), files=(), error=None, acted_on=None)
  def parse(text: str) -> EngineAnswer
  # app/browser/reader.py
  DEFAULT_PART_CHARS = 24_000; MIN_PART_CHARS = 2_000; MAX_PART_CHARS = 200_000; MAX_MATCHES = 40; MAX_DEPTH = 100
  @dataclass(frozen=True) class Line(text: str, heading: bool = False)
  @dataclass(frozen=True) class Page(lines, parts, starts); .chars -> int
  @dataclass(frozen=True) class Outline(headings, more_headings, links, buttons, fields)
  @dataclass(frozen=True) class Match(part: int, heading: str | None, text: str)
  def read(snapshot: str, part_chars: int = DEFAULT_PART_CHARS) -> Page
  def render(snapshot: str) -> list[Line]
  def outline(page: Page) -> Outline
  def search(page: Page, query: str) -> tuple[list[Match], int]
  # tests/browser_engine.py
  def answer_text(step: str) -> str;  def is_error(step: str) -> bool
  ```

- [ ] **Step 1: The captures' reader** — `services/core/tests/browser_engine.py`

```python
"""The pinned browser engine's own answers, for tests (S38).

Captured 2026-09-30 from mcr.microsoft.com/playwright/mcp v0.0.82 (by digest)
by tests/fixtures/browser_engine/capture.py, against the throwaway site in
tests/fixtures/browser_engine/site/. A test reads the engine's real words here
rather than a shape someone remembered: a fixture that accepts what the
product never sees proves nothing.
"""

from __future__ import annotations

import json
from pathlib import Path

GOLDEN = Path(__file__).parent / "fixtures" / "browser_engine" / "v0.0.82"


def answer_text(step: str) -> str:
    """The text of the engine's answer to one captured step, e.g.
    "snapshot-index". The step name is matched exactly after its number, so
    "back" never finds "snapshot-after-back"."""
    (path,) = GOLDEN.glob(f"[0-9][0-9]-{step}.json")
    record = json.loads(path.read_text(encoding="utf-8"))
    return "\n".join(
        block.get("text", "")
        for message in record["messages"]
        for block in (message.get("result") or {}).get("content") or ()
        if block.get("type") == "text"
    )


def is_error(step: str) -> bool:
    """Whether the engine marked that answer isError."""
    (path,) = GOLDEN.glob(f"[0-9][0-9]-{step}.json")
    record = json.loads(path.read_text(encoding="utf-8"))
    return any(bool((m.get("result") or {}).get("isError")) for m in record["messages"])

```

- [ ] **Step 2: Write the failing tests** — `services/core/tests/test_browser_page.py`

```python
"""The browser engine's answers read into values (S38), over the pinned
engine's own captured words (tests/browser_engine.py)."""

from __future__ import annotations

import time

from app.browser import page
from tests.browser_engine import answer_text


def test_a_navigation_names_the_page():
    answer = page.parse(answer_text("navigate-index"))
    assert (answer.url, answer.title, answer.status) == (
        "http://site:8000/index.html",
        "Capture index",
        None,
    )
    assert answer.error is None and answer.snapshot is None


def test_a_snapshot_is_the_fenced_yaml_under_its_page():
    answer = page.parse(answer_text("snapshot-index"))
    assert answer.url == "http://site:8000/index.html"
    assert answer.snapshot.splitlines()[0] == "- generic [active] [ref=f3e1]:"
    assert answer.snapshot.splitlines()[-1] == '  - button "Show alert" [ref=f3e22]'


def test_a_click_that_navigates_names_the_new_page_and_what_was_clicked():
    answer = page.parse(answer_text("click-link"))
    assert (answer.url, answer.title) == ("http://site:8000/page2.html", "Page two")
    assert answer.acted_on == 'link "Page two"'


def test_what_was_acted_on_comes_from_the_engines_own_locator():
    assert page.parse(answer_text("type")).acted_on == 'textbox "Search words"'
    assert page.parse(answer_text("select")).acted_on == 'label "Pick one"'
    assert page.parse(answer_text("press-key")).acted_on is None


def test_typing_carries_no_page_and_never_returns_what_was_typed():
    answer = page.parse(answer_text("type"))
    assert answer.url is None and answer.title is None
    assert "hello world" in answer_text("type")  # the engine's code holds it…
    assert "hello world" not in repr(answer)  # …and the value never does


def test_a_finished_download_is_named_with_its_engine_path():
    answer = page.parse(answer_text("click-download"))
    assert answer.downloads == (("report.txt", "/output/report.txt"),)


def test_a_screenshot_is_the_result_file_in_the_engine_output():
    answer = page.parse(answer_text("screenshot"))
    assert answer.files == ("/output/page-2026-09-30T20-25-33-996Z.png",)


def test_a_dialog_the_page_opened_is_named():
    answer = page.parse(answer_text("click-alert"))
    assert answer.dialogs == (page.Dialog(kind="alert", message="Hello from the page"),)


def test_the_engine_refuses_everything_else_while_a_dialog_is_open():
    answer = page.parse(answer_text("snapshot-during-dialog"))
    assert answer.error == 'Tool "browser_snapshot" does not handle the modal state.'
    assert answer.dialogs == (page.Dialog(kind="alert", message="Hello from the page"),)


def test_a_stale_ref_is_the_engines_own_words():
    answer = page.parse(answer_text("click-stale-ref"))
    assert answer.error == (
        "Ref e9999 not found in the current page snapshot. Try capturing new snapshot."
    )


def test_a_failed_navigation_loses_the_prefix_and_the_call_log():
    answer = page.parse(answer_text("navigate-dns-failure"))
    assert answer.error == "net::ERR_NAME_NOT_RESOLVED at http://no-such-host.invalid/"


def test_a_404_is_a_page_with_a_status_not_an_error():
    answer = page.parse(answer_text("navigate-404"))
    assert (answer.status, answer.status_text, answer.title) == (
        404,
        "File not found",
        "Error response",
    )
    assert answer.error is None


def test_a_submitted_form_lands_with_its_query():
    answer = page.parse(answer_text("type-submit"))
    assert answer.url == "http://site:8000/page2.html?q=sent+words&pick=b"


def test_a_path_outside_the_engine_output_is_never_taken():
    text = (
        '### Events\n- Downloaded file x to "/etc/passwd"\n'
        "### Result\n- [Screenshot](/root/a.png)\n"
    )
    answer = page.parse(text)
    assert answer.downloads == () and answer.files == ()


def test_an_empty_or_odd_answer_is_an_empty_value():
    assert page.parse("") == page.EngineAnswer()
    assert page.parse("no sections at all") == page.EngineAnswer()


def test_hostile_answers_are_read_in_bounded_time():
    hostile = [
        "### Events\n- Downloaded file " + 'x to "' * 200_000 + '/output/a"',
        "### Ran Playwright code\n```js\n" + "getByRole('" * 300_000 + "\n```",
        "### Modal state\n- [" + '"' * 1_000_000 + "]: x",
        "### Page\n" + "- Page URL: " + "a" * 4_000_000,
    ]
    for text in hostile:
        start = time.perf_counter()
        page.parse(text)
        assert time.perf_counter() - start < 1.0
```

and `services/core/tests/test_browser_reader.py`:

```python
"""A page as text she can read (S38): the pinned engine's snapshots rendered,
cut into parts, searched, outlined — and kept linear on hostile input."""

from __future__ import annotations

import time

from app.browser import page, reader
from tests.browser_engine import answer_text

INDEX_LINES = [
    "# Capture index",
    'First paragraph of the index page, with [f3e4] link "Page two" (page2.html) in it.',
    "- Alpha item",
    "- Beta item",
    "| Name | Size |",
    "| qwen3 | 4.9 GB |",
    'Search words [f3e17] textbox "Search words" Pick one [f3e18] combobox "Pick one"'
    ' (options: Option A [selected], Option B) [f3e19] button "Send"',
    '[f3e21] link "Download the report" (report.txt)',
    '[f3e22] button "Show alert"',
]


def _snapshot(step: str) -> str:
    return page.parse(answer_text(step)).snapshot


def test_the_index_capture_renders_as_a_person_reads_it():
    read = reader.read(_snapshot("snapshot-index"))
    assert [line.text for line in read.lines] == INDEX_LINES
    assert [line.heading for line in read.lines] == [True] + [False] * 8
    assert read.parts == ("\n".join(INDEX_LINES),)


def test_the_outline_counts_what_she_can_act_on():
    outline = reader.outline(reader.read(_snapshot("snapshot-index")))
    assert outline == reader.Outline(
        headings=("Capture index",), more_headings=0, links=2, buttons=2, fields=2
    )


def test_the_long_capture_is_two_parts_and_the_needle_is_in_part_two():
    read = reader.read(_snapshot("snapshot-long"))
    assert (len(read.lines), read.chars) == (401, 44_163)
    assert read.starts == (0, 219)
    assert [len(part) for part in read.parts] == [23_995, 20_166]
    assert all(len(part) <= reader.DEFAULT_PART_CHARS for part in read.parts)
    matches, total = reader.search(read, "zebra-quartz")
    assert total == 1
    assert matches == [
        reader.Match(
            part=2,
            heading="# A long page",
            text="The needle sentence is here: zebra-quartz lives in paragraph three hundred.",
        )
    ]


def test_a_search_is_every_word_case_blind_and_bounded():
    read = reader.read(_snapshot("snapshot-long"))
    # 399, not 400: paragraph 300 is the needle sentence, which has no "item".
    matches, total = reader.search(read, "PARAGRAPH item")
    assert total == 399 and len(matches) == reader.MAX_MATCHES
    assert reader.search(read, "   ") == ([], 0)
    assert reader.search(read, "zebra-quartz absent-word") == ([], 0)


def test_smaller_parts_cut_on_line_boundaries():
    read = reader.read(_snapshot("snapshot-long"), 2_000)
    assert len(read.parts) == 23
    assert read.starts[:4] == (0, 19, 37, 55)
    assert all(len(part) <= 2_000 for part in read.parts)
    assert "\n".join(read.parts) == "\n".join(line.text for line in read.lines)


def test_a_line_longer_than_a_part_is_cut_inside():
    read = reader.read("- paragraph [ref=e1]: " + "a" * 5_000, 2_000)
    assert [len(part) for part in read.parts] == [2_000, 2_000, 1_000]
    assert read.starts == (0, 0, 0)
    matches, _ = reader.search(read, "aaa")
    assert matches[0].part == 1


def test_an_empty_page_is_one_empty_part():
    read = reader.read("")
    assert read.parts == ("",) and read.starts == (0,) and read.lines == ()


def test_controls_carry_their_state_and_their_target():
    snapshot = "\n".join(
        [
            '- checkbox "Remember me" [checked] [ref=e2]',
            '- link "Docs" [ref=e3]:',
            "  - /url: https://example.com/docs",
            '- textbox "Email" [ref=e4]:',
            "  - /placeholder: you@example.com",
            '- button "Disabled" [disabled] [ref=e5]',
            '- img "A chart of prices"',
            '- heading "Deep" [level=3] [ref=e6]',
        ]
    )
    # Each top-level node is a line of its own; inside a block they flow.
    assert [line.text for line in reader.read(snapshot).lines] == [
        '[e2] checkbox "Remember me" (checked)',
        '[e3] link "Docs" (https://example.com/docs)',
        '[e4] textbox "Email" (placeholder: you@example.com)',
        '[e5] button "Disabled" (disabled)',
        "[image: A chart of prices]",
        "### Deep",
    ]


def test_quoted_names_and_text_are_unquoted_once():
    snapshot = '- paragraph [ref=e1]:\n  - text: "Note: a colon"\n  - link "Say \\"hi\\"" [ref=e2]'
    assert [line.text for line in reader.read(snapshot).lines] == [
        'Note: a colon [e2] link "Say "hi""'
    ]


def test_a_hostile_snapshot_is_read_in_bounded_time():
    hostile = {
        "5,000 levels deep": "\n".join("  " * i + f"- generic [ref=e{i}]:" for i in range(5_000))
        + "\n"
        + "  " * 5_000
        + "- text: bottom",
        "200,000 attributes": '- button "b" ' + "[x=1] " * 200_000 + ": t",
        "1,000,000 escaped quotes": '- link "' + '\\"' * 1_000_000 + '" [ref=e1]',
        "an unclosed 2 MB name": '- link "' + "a" * 2_000_000,
        "500,000 open brackets": "- button " + "[" * 500_000,
    }
    for label, snapshot in hostile.items():
        start = time.perf_counter()
        read = reader.read(snapshot)
        reader.outline(read)
        reader.search(read, "bottom b")
        took = time.perf_counter() - start
        assert took < 2.0, f"{label}: {took:.2f} s"
    deep = reader.read(hostile["5,000 levels deep"])
    assert deep.lines[-1].text == "bottom"


def test_a_four_mebibyte_snapshot_reads_in_time():
    snapshot = "\n".join([_snapshot("snapshot-long")] * 80)
    assert len(snapshot.encode()) > 4 * 1024 * 1024
    start = time.perf_counter()
    read = reader.read(snapshot)
    reader.outline(read)
    reader.search(read, "zebra-quartz")
    took = time.perf_counter() - start
    # Measured 0.38 s on the N150 for 5 MB; the budget leaves CI's slower
    # runners five times the room.
    assert took < 2.0, f"{took:.2f} s"
```

- [ ] **Step 3: Run them to see them fail**

Run: `CORE uv run pytest -q tests/test_browser_page.py tests/test_browser_reader.py`
Expected: FAIL at collection, `ModuleNotFoundError: No module named 'app.browser'`.

- [ ] **Step 4: The package and the answer** — `services/core/app/browser/__init__.py`

```python
"""Her own browser (S38): the engine answer read into plain text, the files it
reports brought into her workspace, and the one way core calls the engine.

Imports nothing: app.tools imports these modules at import time.
"""
```

and `services/core/app/browser/page.py`:

```python
"""What the browser engine said, read once (S38).

The engine (Microsoft's Playwright MCP server, pinned in deploy/browser/
Dockerfile) answers every tool call with one markdown text in `### `-headed
sections: Page, Snapshot, Events, Modal state, Result, Error, and the
Playwright code it ran. This module reads that text into a value, and nothing
else. Every shape here is the pinned engine's own, captured 2026-09-30 in
tests/fixtures/browser_engine/v0.0.82/.

Pure: no network, no filesystem, no clock. Linear: str methods only, never a
regular expression, because a page chose the snapshot's text and the names of
the files it downloads.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

# Where the engine writes the files it reports (`--output-dir`, deploy/
# docker-compose.yml). A path outside it is never taken from an answer.
ENGINE_OUTPUT = "/output/"


@dataclass(frozen=True)
class Dialog:
    """A modal the page opened. Until it is answered the engine refuses every
    other tool ("does not handle the modal state", measured)."""

    kind: str  # "alert" | "confirm" | "prompt" | "beforeunload" | the engine's own word
    message: str  # "" when the engine gave none


@dataclass(frozen=True)
class EngineAnswer:
    url: str | None = None
    title: str | None = None
    status: int | None = None  # the HTTP status, only when the engine reported one
    status_text: str = ""
    snapshot: str | None = None  # the YAML inside ### Snapshot's fence
    dialogs: tuple[Dialog, ...] = ()
    downloads: tuple[tuple[str, str], ...] = ()  # (file name, engine path), each FINISHED
    files: tuple[str, ...] = ()  # engine paths ### Result names (a screenshot)
    error: str | None = None  # ### Error, without "Error: " and the call log
    acted_on: str | None = None  # what the engine's own code says it acted on


def parse(text: str) -> EngineAnswer:
    """Read one engine answer. Unknown sections are ignored; a missing one is
    simply absent from the value — never guessed."""
    sections = _sections(text or "")
    url = title = None
    status: int | None = None
    status_text = ""
    for line in sections.get("Page", ()):
        key, value = _bullet(line)
        if key == "Page URL":
            url = value or None
        elif key == "Page Title":
            title = value or None
        elif key == "HTTP status":
            code, _, words = value.partition(" ")
            if code.isdigit():
                status, status_text = int(code), words.strip()
    return EngineAnswer(
        url=url,
        title=title,
        status=status,
        status_text=status_text,
        snapshot=_fenced(sections.get("Snapshot", ())),
        dialogs=tuple(d for d in (_dialog(line) for line in sections.get("Modal state", ())) if d),
        downloads=tuple(d for d in (_download(line) for line in sections.get("Events", ())) if d),
        files=tuple(f for f in (_result_file(line) for line in sections.get("Result", ())) if f),
        error=_error(sections.get("Error")),
        acted_on=_acted_on("\n".join(sections.get("Ran Playwright code", ()))),
    )


def _sections(text: str) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = {}
    current: list[str] | None = None
    for line in text.splitlines():
        if line.startswith("### "):
            current = sections.setdefault(line[4:].strip(), [])
        elif current is not None:
            current.append(line)
    return sections


def _bullet(line: str) -> tuple[str, str]:
    if not line.startswith("- "):
        return "", ""
    key, sep, value = line[2:].partition(": ")
    return (key.strip(), value.strip()) if sep else ("", "")


def _fenced(lines: list[str] | tuple[str, ...]) -> str | None:
    body: list[str] = []
    inside = False
    for line in lines:
        if line.startswith("```"):
            if inside:
                return "\n".join(body)
            inside = True
            continue
        if inside:
            body.append(line)
    return "\n".join(body) if inside else None


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        try:
            loaded = json.loads(value)
        except ValueError:
            return value[1:-1]
        return loaded if isinstance(loaded, str) else value[1:-1]
    return value


def _dialog(line: str) -> Dialog | None:
    # - ["alert" dialog with message "Hello from the page"]: can be handled by browser_handle_dialog
    if not line.startswith("- ["):
        return None
    end = line.rfind("]:")
    inner = line[3:end] if end > 3 else line[3:]
    kind = inner
    if inner.startswith('"'):
        close = inner.find('"', 1)
        if close > 0:
            kind = inner[1:close]
    marker = " with message "
    at = inner.find(marker)
    message = _unquote(inner[at + len(marker) :]) if at != -1 else ""
    return Dialog(kind=kind.strip(), message=message)


def _download(line: str) -> tuple[str, str] | None:
    # - Downloaded file report.txt to "/output/report.txt"
    lead = "- Downloaded file "
    if not line.startswith(lead):
        return None
    name, sep, path = line[len(lead) :].rpartition(' to "')
    if not sep or not path.endswith('"'):
        return None
    path = path[:-1]
    return (name, path) if path.startswith(ENGINE_OUTPUT) else None


def _result_file(line: str) -> str | None:
    # - [Screenshot of viewport](/output/page-2026-09-30T20-25-33-996Z.png)
    if not line.startswith("- [") or not line.endswith(")"):
        return None
    at = line.rfind("](")
    if at == -1:
        return None
    path = line[at + 2 : -1]
    return path if path.startswith(ENGINE_OUTPUT) else None


def _error(lines: list[str] | None) -> str | None:
    if lines is None:
        return None
    text = "\n".join(lines).strip()
    text = text.split("\nCall log:", 1)[0].strip()
    if text.startswith("Error: "):
        text = text[len("Error: ") :]
    if text.startswith("browserBackend.callTool: "):
        text = text[len("browserBackend.callTool: ") :]
    return text or "the engine reported an error and gave no reason"


def _js_string(code: str, start: int) -> tuple[str, int] | None:
    """The single-quoted JS string starting at `start` (its opening quote), and
    the index after it. Backslash escapes are honoured."""
    if start >= len(code) or code[start] != "'":
        return None
    out: list[str] = []
    i = start + 1
    while i < len(code):
        ch = code[i]
        if ch == "\\" and i + 1 < len(code):
            out.append(code[i + 1])
            i += 2
            continue
        if ch == "'":
            return "".join(out), i + 1
        out.append(ch)
        i += 1
    return None


def _acted_on(code: str) -> str | None:
    """What the engine's own code says it acted on — `link "Page two"` — from
    the FIRST locator in the code it ran. Only the locator is read: the
    argument of .fill() is what she typed, and it never leaves this function."""
    role_at = code.find("getByRole(")
    label_at = code.find("getByLabel(")
    text_at = code.find("getByText(")
    found = [
        (at, kind)
        for at, kind in ((role_at, "role"), (label_at, "label"), (text_at, "text"))
        if at != -1
    ]
    if not found:
        return None
    at, kind = min(found)
    if kind == "role":
        role = _js_string(code, at + len("getByRole("))
        if role is None:
            return None
        name_at = code.find("name: ", role[1])
        name = _js_string(code, name_at + len("name: ")) if name_at != -1 else None
        if name is not None and code.find(")", role[1]) > name_at:
            return f'{role[0]} "{name[0]}"'
        return role[0]
    quoted = _js_string(code, at + len("getByLabel(" if kind == "label" else "getByText("))
    return f'{kind} "{quoted[0]}"' if quoted else None
```

- [ ] **Step 5: The reader** — `services/core/app/browser/reader.py`

```python
"""A page, as text she can read (S38).

The engine's snapshot is a YAML accessibility tree: one node per line, two
spaces of indent per level — `- role "name" [attr] [ref=e4]: inline text`,
`- text: …`, `- /url: …`. It is rendered here into the lines a person reads:
a heading as `#`s, a paragraph as its words, a list item as `- …`, a table row
as `| a | b |`, and every element she can act on as `[e4] link "Page two"
(page2.html)`, carrying the engine's own ref. Decoration is dropped.

Then cut into parts no longer than she asked for, on line boundaries (only a
single line longer than a part is cut inside), or searched: the lines holding
every word of a query, each with its part number and the heading above it.

Pure and linear: one pass per line, str methods only, never a regular
expression — the text is a page's, and a 4 MiB snapshot is read on core's
event loop.
"""

from __future__ import annotations

import bisect
import json
from dataclasses import dataclass, field

DEFAULT_PART_CHARS = 24_000
MIN_PART_CHARS = 2_000
MAX_PART_CHARS = 200_000
MAX_MATCHES = 40
MAX_MATCH_CHARS = 300
MAX_OUTLINE_HEADINGS = 30
# A page chooses how deep its tree goes, and the walk below is recursive: a
# node deeper than this is read as a sibling at this depth, so no page can
# exhaust the interpreter's stack (a 5,000-deep snapshot raised RecursionError
# before this, measured 2026-10-01).
MAX_DEPTH = 100

# Roles she can act on: rendered with the engine's ref, never flowed as text.
INTERACTIVE = frozenset(
    {
        "link", "button", "textbox", "searchbox", "combobox", "listbox", "checkbox",
        "radio", "switch", "slider", "spinbutton", "tab", "menuitem",
        "menuitemcheckbox", "menuitemradio", "treeitem",
    }
)  # fmt: skip
FIELDS = frozenset(
    {
        "textbox",
        "searchbox",
        "combobox",
        "listbox",
        "checkbox",
        "radio",
        "switch",
        "slider",
        "spinbutton",
    }
)
# Roles that are a line of their own, with what goes in front of it.
BLOCKS = {
    "paragraph": "",
    "listitem": "- ",
    "blockquote": "> ",
    "alert": "! ",
    "status": "",
    "caption": "",
    "term": "",
    "definition": "  ",
    "code": "",
    "note": "",
    "figure": "",
}
CELLS = frozenset({"cell", "columnheader", "rowheader", "gridcell"})
FLAGS = ("checked", "selected", "disabled", "expanded", "pressed")


@dataclass(frozen=True)
class Line:
    text: str
    heading: bool = False


@dataclass(frozen=True)
class Page:
    lines: tuple[Line, ...]
    parts: tuple[str, ...]
    starts: tuple[int, ...]  # the index in `lines` each part begins at

    @property
    def chars(self) -> int:
        return sum(len(line.text) + 1 for line in self.lines)


@dataclass(frozen=True)
class Outline:
    headings: tuple[str, ...]
    more_headings: int
    links: int
    buttons: int
    fields: int


@dataclass(frozen=True)
class Match:
    part: int
    heading: str | None
    text: str


@dataclass
class _Node:
    role: str
    name: str | None = None
    attrs: dict[str, str] = field(default_factory=dict)
    text: str | None = None
    children: list[_Node] = field(default_factory=list)


@dataclass
class _Flow:
    prefix: str = ""
    parts: list[str] = field(default_factory=list)


def read(snapshot: str, part_chars: int = DEFAULT_PART_CHARS) -> Page:
    lines = tuple(render(snapshot))
    parts, starts = _paginate(lines, part_chars)
    return Page(lines=lines, parts=tuple(parts), starts=tuple(starts))


def render(snapshot: str) -> list[Line]:
    out: list[Line] = []
    for node in _tree(snapshot or ""):
        flow = _Flow()
        _walk(node, out, flow, in_block=False)
        _flush(out, flow)
    return out


def outline(page: Page) -> Outline:
    headings = [line.text.lstrip("#").strip() for line in page.lines if line.heading]
    links = buttons = fields = 0
    for line in page.lines:
        links += line.text.count("] link ")
        buttons += line.text.count("] button ")
        fields += sum(line.text.count(f"] {role}") for role in FIELDS)
    return Outline(
        headings=tuple(headings[:MAX_OUTLINE_HEADINGS]),
        more_headings=max(0, len(headings) - MAX_OUTLINE_HEADINGS),
        links=links,
        buttons=buttons,
        fields=fields,
    )


def search(page: Page, query: str) -> tuple[list[Match], int]:
    """Every line holding every word of `query` (case-insensitive), at most
    MAX_MATCHES of them, and how many there were in all."""
    words = [word.casefold() for word in query.split() if word]
    if not words:
        return [], 0
    found: list[Match] = []
    total = 0
    heading: str | None = None
    for index, line in enumerate(page.lines):
        if line.heading:
            heading = line.text
        folded = line.text.casefold()
        if all(word in folded for word in words):
            total += 1
            if len(found) < MAX_MATCHES:
                part = _part_of(page, index)
                text = (
                    line.text
                    if len(line.text) <= MAX_MATCH_CHARS
                    else line.text[:MAX_MATCH_CHARS] + " …"
                )
                found.append(Match(part=part, heading=None if line.heading else heading, text=text))
    return found, total


def _part_of(page: Page, index: int) -> int:
    """The 1-based part a line begins in (the first part, for a line cut
    across several)."""
    at = bisect.bisect_left(page.starts, index)
    return at + 1 if at < len(page.starts) and page.starts[at] == index else at


# ── the tree ────────────────────────────────────────────────────────────────


def _tree(snapshot: str) -> list[_Node]:
    roots: list[_Node] = []
    stack: list[tuple[int, _Node]] = []
    for raw in snapshot.splitlines():
        parsed = _parse_line(raw)
        if parsed is None:
            continue
        indent, node = parsed
        while stack and stack[-1][0] >= indent:
            stack.pop()
        if stack:
            stack[-1][1].children.append(node)
        else:
            roots.append(node)
        stack.append((indent, node))
    return roots


def _parse_line(raw: str) -> tuple[int, _Node] | None:
    stripped = raw.lstrip(" ")
    if not stripped.startswith("- "):
        return None
    indent = min((len(raw) - len(stripped)) // 2, MAX_DEPTH)
    body = stripped[2:]
    if body.startswith("text:"):
        return indent, _Node(role="text", text=_scalar(body[5:]))
    if body.startswith("/"):
        key, _, value = body.partition(":")
        return indent, _Node(role=key, text=_scalar(value))
    end = 0
    while end < len(body) and (body[end].isalnum() or body[end] in "-_"):
        end += 1
    if end == 0:
        return indent, _Node(role="text", text=_scalar(body))
    node = _Node(role=body[:end])
    rest = body[end:].lstrip(" ")
    if rest.startswith('"'):
        node.name, rest = _quoted(rest)
        rest = rest.lstrip(" ")
    # By index, never by re-slicing `rest`: a slice per attribute copies the
    # rest of the line each time, and 200,000 attributes took 9 s that way
    # (measured 2026-10-01). One pass, one slice at the end.
    at = 0
    while at < len(rest) and rest[at] == "[":
        close = rest.find("]", at)
        if close == -1:
            break
        key, sep, value = rest[at + 1 : close].partition("=")
        node.attrs[key] = value if sep else ""
        at = close + 1
        while at < len(rest) and rest[at] == " ":
            at += 1
    if rest.startswith(":", at):
        node.text = _scalar(rest[at + 1 :]) or None
    return indent, node


def _quoted(text: str) -> tuple[str, str]:
    """The double-quoted name at the start of `text`, and what follows it."""
    i = 1
    while i < len(text):
        if text[i] == "\\":
            i += 2
            continue
        if text[i] == '"':
            raw = text[: i + 1]
            try:
                name = json.loads(raw)
            except ValueError:
                name = raw[1:-1]
            return (name if isinstance(name, str) else raw[1:-1]), text[i + 1 :]
        i += 1
    return text[1:], ""


def _scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        if value[0] == '"':
            try:
                loaded = json.loads(value)
            except ValueError:
                return value[1:-1]
            return loaded if isinstance(loaded, str) else value[1:-1]
        return value[1:-1].replace("''", "'")
    return value


# ── the walk ────────────────────────────────────────────────────────────────


def _flush(out: list[Line], flow: _Flow) -> None:
    text = " ".join(part for part in flow.parts if part).strip()
    if text:
        out.append(Line(flow.prefix + text))
        if flow.prefix:
            flow.prefix = " " * len(flow.prefix)
    flow.parts.clear()


def _walk(node: _Node, out: list[Line], flow: _Flow, *, in_block: bool) -> None:
    role = node.role
    if role == "text":
        if node.text:
            flow.parts.append(node.text)
        return
    if role.startswith("/"):
        return  # a property (/url, /placeholder) — read by the element that owns it
    if role == "heading":
        _flush(out, flow)
        level = node.attrs.get("level", "")
        depth = int(level) if level.isdigit() and 1 <= int(level) <= 6 else 1
        words = node.name or node.text or " ".join(_inline_words(node))
        if words:
            out.append(Line("#" * depth + " " + words, heading=True))
        return
    if role in INTERACTIVE:
        flow.parts.append(_element(node))
        return
    if role == "img":
        if node.name:
            flow.parts.append(f"[image: {node.name}]")
        return
    if role == "row":
        _flush(out, flow)
        cells = [_cell(child) for child in node.children if child.role in CELLS]
        if cells:
            out.append(Line("| " + " | ".join(cells) + " |"))
        return
    if role in BLOCKS:
        _flush(out, flow)
        inner = _Flow(prefix=BLOCKS[role])
        if node.text:
            inner.parts.append(node.text)
        for child in node.children:
            _walk(child, out, inner, in_block=True)
        _flush(out, inner)
        return
    # A container (generic, list, table, group, navigation, form, …): it adds
    # nothing of its own. At the top level its inline content is one line; in
    # a block it flows on with the block's words.
    if not in_block:
        _flush(out, flow)
    if node.text:
        flow.parts.append(node.text)
    for child in node.children:
        _walk(child, out, flow, in_block=in_block)
    if not in_block:
        _flush(out, flow)


def _inline_words(node: _Node) -> list[str]:
    words: list[str] = []
    for child in node.children:
        if child.role == "text" and child.text:
            words.append(child.text)
        elif child.name:
            words.append(child.name)
    return words


def _cell(node: _Node) -> str:
    words = [node.name or node.text or ""]
    for child in node.children:
        if child.role in INTERACTIVE:
            words.append(_element(child))
        elif child.role == "text" and child.text:
            words.append(child.text)
    return " ".join(word for word in words if word).replace("|", "/")


def _element(node: _Node) -> str:
    ref = node.attrs.get("ref")
    label = f'{node.role} "{node.name}"' if node.name else node.role
    head = f"[{ref}] {label}" if ref else label
    extras: list[str] = []
    for flag in FLAGS:
        if flag in node.attrs:
            value = node.attrs[flag]
            extras.append(flag if value in ("", "true") else f"{flag}={value}")
    if node.role in ("combobox", "listbox"):
        options = [
            (child.name or child.text or "") + (" [selected]" if "selected" in child.attrs else "")
            for child in node.children
            if child.role == "option"
        ]
        if options:
            extras.append("options: " + ", ".join(options))
    for child in node.children:
        if child.role == "/url" and child.text:
            extras.append(child.text)
        elif child.role == "/placeholder" and child.text:
            extras.append(f"placeholder: {child.text}")
    text = f"{head} ({'; '.join(extras)})" if extras else head
    if node.text and node.text != node.name:
        text += f": {node.text}"
    return text


# ── parts ───────────────────────────────────────────────────────────────────


def _paginate(lines: tuple[Line, ...], part_chars: int) -> tuple[list[str], list[int]]:
    parts: list[str] = []
    starts: list[int] = []
    current: list[str] = []
    size = 0
    for index, line in enumerate(lines):
        text = line.text
        while len(text) > part_chars:
            if current:
                parts.append("\n".join(current))
                current, size = [], 0
            starts.append(index)
            parts.append(text[:part_chars])
            text = text[part_chars:]
        if not text:
            continue
        added = len(text) + (1 if current else 0)
        if current and size + added > part_chars:
            parts.append("\n".join(current))
            current, size, added = [], 0, len(text)
        if not current:
            starts.append(index)
        current.append(text)
        size += added
    if current:
        parts.append("\n".join(current))
    if not parts:
        return [""], [0]
    return parts, starts
```

- [ ] **Step 6: Run them to see them pass**

Run: `CORE uv run pytest -q tests/test_browser_page.py tests/test_browser_reader.py`
Expected: `27 passed`. The two timing tests have budgets 5–6 times what the N150 measured (a 5 MB snapshot read, outlined and searched in 0.38 s; the worst hostile input 0.19 s).

- [ ] **Step 7: Format and commit**

```bash
CORE uv run ruff format app/browser/__init__.py app/browser/page.py app/browser/reader.py tests/browser_engine.py tests/test_browser_page.py tests/test_browser_reader.py && uv run ruff check app tests
git -C $W add services/core/app/browser/__init__.py services/core/app/browser/page.py services/core/app/browser/reader.py services/core/tests/browser_engine.py services/core/tests/test_browser_page.py services/core/tests/test_browser_reader.py
NOVA_SKIP_HOOKS=1 git -C $W commit -q -F - <<'MSG'
feat(core): the browser engine's answer read once, and a page as text she can read (S38)

page.parse reads the pinned engine's markdown answer into a value — page,
snapshot, dialogs, downloads, result files, error, and what its own code
says it acted on (never what was typed). reader renders the YAML
accessibility snapshot into lines with the engine's refs, cuts parts on
line boundaries, searches lines, and outlines. Pure and linear: depth is
capped at 100 (5,000 levels raised RecursionError) and attributes are read
by index (re-slicing took 9 s for 200,000 of them).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFVvjmicBfxQjL1oY3RqtA
MSG
git -C $W show --stat HEAD | tail -4
```

---
## Task 3: The files her browser makes, brought into her workspace

Needs nothing of S37a. Validated before this plan was written: the tests below passed against this exact file.

**Files:**
- Create: `services/core/app/browser/files.py`
- Test: `services/core/tests/test_browser_files.py`

**Interfaces:**
- Consumes: `page.ENGINE_OUTPUT` (Task 2); `app.tools.workspace._resolve_within` and `app.tools.base.ToolFailure` (main).
- Produces (Task 5 uses these):
  ```python
  OUTPUT_DIR_ENV = "BROWSER_OUTPUT_DIR"; DEFAULT_OUTPUT_DIR = "/data/browser-output"
  MAX_BRING_BYTES = 1024 ** 3; MAX_NAME_CHARS = 120
  class HandoffError(Exception)
  @dataclass(frozen=True) class Brought(path: str, bytes: int)   # path relative to the workspace root
  def output_dir_from_env() -> Path
  def safe_name(name: str, fallback: str = "download") -> str
  def source_of(engine_path: str, output_dir: Path) -> Path
  def bring_in(engine_path, *, output_dir, workspace_root, folder, name=None) -> Brought
  ```

- [ ] **Step 1: Write the failing test** — `services/core/tests/test_browser_files.py`

```python
"""The files her browser makes, brought into her workspace (S38): checked by
size and sha256 before the engine's copy goes, never overwriting hers, never
leaving her workspace, never following a link out of the engine's volume."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest

from app.browser import files


@pytest.fixture
def dirs(tmp_path: Path) -> tuple[Path, Path]:
    output, workspace = tmp_path / "output", tmp_path / "workspace"
    output.mkdir()
    workspace.mkdir()
    return output, workspace


def _put(output: Path, name: str, data: bytes = b"report body\n") -> Path:
    path = output / name
    path.write_bytes(data)
    return path


def test_a_reported_file_is_copied_checked_and_the_engines_copy_removed(dirs):
    output, workspace = dirs
    data = os.urandom(3 * 1024 * 1024 + 7)
    _put(output, "report.bin", data)
    brought = files.bring_in(
        "/output/report.bin", output_dir=output, workspace_root=workspace, folder="downloads"
    )
    assert brought == files.Brought(path="downloads/report.bin", bytes=len(data))
    copied = workspace / "downloads" / "report.bin"
    assert hashlib.sha256(copied.read_bytes()).digest() == hashlib.sha256(data).digest()
    assert not (output / "report.bin").exists()
    assert not any(p.name.endswith(".part") for p in (workspace / "downloads").iterdir())


def test_an_existing_file_is_never_overwritten(dirs):
    output, workspace = dirs
    (workspace / "downloads").mkdir()
    (workspace / "downloads" / "report.txt").write_text("hers")
    _put(output, "report.txt", b"the page's")
    brought = files.bring_in(
        "/output/report.txt", output_dir=output, workspace_root=workspace, folder="downloads"
    )
    assert brought.path == "downloads/report (2).txt"
    assert (workspace / "downloads" / "report.txt").read_text() == "hers"


@pytest.mark.parametrize(
    "name,expected",
    [
        ("../../.bashrc", "downloads/bashrc"),
        ("C:\\evil\\name.exe", "downloads/name.exe"),
        ("na<m>e?.txt", "downloads/name.txt"),
        ("a\x07b.txt", "downloads/ab.txt"),
        ("...", "downloads/download"),
    ],
)
def test_a_page_chosen_name_stays_one_file_in_the_folder(dirs, name, expected):
    output, workspace = dirs
    _put(output, "x.bin")
    brought = files.bring_in(
        "/output/x.bin", output_dir=output, workspace_root=workspace, folder="downloads", name=name
    )
    assert brought.path == expected
    assert (workspace / expected).is_file()


def test_a_long_name_keeps_its_extension():
    name = files.safe_name("x" * 300 + ".pdf")
    assert len(name) == files.MAX_NAME_CHARS and name.endswith(".pdf")


@pytest.mark.parametrize(
    "engine_path",
    [
        "/etc/passwd",
        "/output/",
        "/output/../etc/passwd",
        "/output/a/../../x",
        "/output/./x",
        "/outputx",
    ],
)
def test_an_engine_path_outside_its_folder_is_refused(dirs, engine_path):
    output, workspace = dirs
    with pytest.raises(files.HandoffError):
        files.bring_in(engine_path, output_dir=output, workspace_root=workspace, folder="downloads")
    assert not (workspace / "downloads").exists()


def test_a_link_in_the_engine_volume_is_refused_and_removed(dirs, tmp_path):
    output, workspace = dirs
    secret = tmp_path / "core-secret.txt"
    secret.write_text("not hers to have")
    (output / "link.txt").symlink_to(secret)
    with pytest.raises(files.HandoffError, match="not a plain file"):
        files.bring_in(
            "/output/link.txt", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert not (output / "link.txt").exists(), "the link is removed"
    assert secret.read_text() == "not hers to have", "its target is untouched"
    assert not (workspace / "downloads").exists()


def test_a_folder_outside_the_workspace_is_refused(dirs):
    output, workspace = dirs
    _put(output, "y.bin")
    with pytest.raises(files.HandoffError, match="outside the workspace"):
        files.bring_in(
            "/output/y.bin", output_dir=output, workspace_root=workspace, folder="../elsewhere"
        )


def test_a_file_that_is_not_there_is_said_so(dirs):
    output, workspace = dirs
    with pytest.raises(files.HandoffError, match="it is not there"):
        files.bring_in(
            "/output/gone.bin", output_dir=output, workspace_root=workspace, folder="downloads"
        )


def test_a_file_over_the_cap_is_stated_not_copied_and_removed(dirs, monkeypatch):
    output, workspace = dirs
    monkeypatch.setattr(files, "MAX_BRING_BYTES", 10)
    _put(output, "big.bin", b"x" * 11)
    with pytest.raises(files.HandoffError, match="over the 1 GiB"):
        files.bring_in(
            "/output/big.bin", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert not (output / "big.bin").exists()
    assert not (workspace / "downloads").exists()


def test_a_copy_that_does_not_match_keeps_nothing(dirs, monkeypatch):
    output, workspace = dirs
    _put(output, "r.txt", b"abc")
    real = files._sha256
    calls = iter([real, lambda path: "0" * 64])
    monkeypatch.setattr(files, "_sha256", lambda path: next(calls)(path))
    with pytest.raises(files.HandoffError, match="did not match"):
        files.bring_in(
            "/output/r.txt", output_dir=output, workspace_root=workspace, folder="downloads"
        )
    assert (output / "r.txt").exists(), "the engine's copy stays when the copy failed its check"
    assert list((workspace / "downloads").iterdir()) == []


def test_the_output_folder_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv(files.OUTPUT_DIR_ENV, "/somewhere/else")
    assert files.output_dir_from_env() == Path("/somewhere/else")
    monkeypatch.delenv(files.OUTPUT_DIR_ENV)
    assert files.output_dir_from_env() == Path(files.DEFAULT_OUTPUT_DIR)
```

- [ ] **Step 2: Run it to see it fail**

Run: `CORE uv run pytest -q tests/test_browser_files.py`
Expected: FAIL at collection, `ImportError: cannot import name 'files' from 'app.browser'`.

- [ ] **Step 3: The handoff** — `services/core/app/browser/files.py`

```python
"""The files her browser makes, brought into her workspace (S38).

The engine writes a download or a screenshot into its own volume
(v4_browser_output, `/output` in its container), and core sees the same volume
at BROWSER_OUTPUT_DIR. Only a file the engine REPORTED — a "Downloaded file …
to …" event, a screenshot's result link — is brought in: copied into the
calling turn's workspace, its size and sha256 checked against the source, and
only then is the source removed. "Copied" is never said on a file nobody
measured.

The engine's volume is not her workspace on purpose: it writes console logs
there on every page that logs an error (measured 2026-09-30), and a page
chooses a download's name. So a name is reduced to one safe file name, a path
is contained in her workspace by the workspace tools' own gate, an existing
file is never overwritten, and a link in the engine's volume is refused rather
than followed.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path

from app.browser.page import ENGINE_OUTPUT
from app.tools.base import ToolFailure
from app.tools.workspace import _resolve_within

OUTPUT_DIR_ENV = "BROWSER_OUTPUT_DIR"
DEFAULT_OUTPUT_DIR = "/data/browser-output"
MAX_BRING_BYTES = 1024 * 1024 * 1024  # 1 GiB
MAX_NAME_CHARS = 120


class HandoffError(Exception):
    """A stated reason a reported file was not brought in."""


@dataclass(frozen=True)
class Brought:
    path: str  # relative to the workspace root it was brought into
    bytes: int


def output_dir_from_env() -> Path:
    return Path(os.environ.get(OUTPUT_DIR_ENV) or DEFAULT_OUTPUT_DIR)


def safe_name(name: str, fallback: str = "download") -> str:
    """One file name a page cannot use to reach anywhere: the last path
    segment, no control characters, no leading dots, at most MAX_NAME_CHARS
    (the extension kept)."""
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    base = "".join(ch for ch in base if ch.isprintable() and ch not in '<>:"|?*')
    base = base.strip().lstrip(".").strip()
    if not base:
        return fallback
    if len(base) > MAX_NAME_CHARS:
        stem, dot, ext = base.rpartition(".")
        if dot and 0 < len(ext) <= 16:
            base = stem[: MAX_NAME_CHARS - len(ext) - 1] + "." + ext
        else:
            base = base[:MAX_NAME_CHARS]
    return base


def _free_name(folder: Path, name: str) -> Path:
    candidate = folder / name
    if not candidate.exists():
        return candidate
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        stem, ext = name, ""
    for n in range(2, 1000):
        candidate = folder / (f"{stem} ({n}).{ext}" if ext else f"{stem} ({n})")
        if not candidate.exists():
            return candidate
    raise HandoffError(f"{folder.name}/ already holds 999 files named like {name!r}")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_of(engine_path: str, output_dir: Path) -> Path:
    """Where core sees a file the engine reported at `engine_path`."""
    if not engine_path.startswith(ENGINE_OUTPUT):
        raise HandoffError(f"the engine named {engine_path!r}, which is not in its output folder")
    rel = engine_path[len(ENGINE_OUTPUT) :]
    if not rel or "\x00" in rel or any(part in ("", ".", "..") for part in rel.split("/")):
        raise HandoffError(
            f"the engine named {engine_path!r}, which is not one file in its output folder"
        )
    return output_dir / rel


def bring_in(
    engine_path: str,
    *,
    output_dir: Path,
    workspace_root: Path,
    folder: str,
    name: str | None = None,
) -> Brought:
    """Copy the reported file into `<workspace_root>/<folder>/`, check it,
    remove the source, and say where it is. Raises HandoffError with the
    reason when any step cannot be done or checked."""
    source = source_of(engine_path, output_dir)
    try:
        info = os.lstat(source)
    except FileNotFoundError:
        raise HandoffError(f"the engine reported {engine_path}, and it is not there") from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        with contextlib.suppress(OSError):
            os.unlink(source)
        raise HandoffError(
            f"the engine reported {engine_path}, which is not a plain file; it was removed"
        )
    if info.st_size > MAX_BRING_BYTES:
        with contextlib.suppress(OSError):
            os.unlink(source)
        raise HandoffError(
            f"{source.name} is {info.st_size:,} bytes, over the 1 GiB a download may bring into "
            "the workspace; it was not copied, and the engine's copy was removed"
        )
    wanted = safe_name(name or source.name)
    try:
        destination_dir = _resolve_within(workspace_root, folder)
    except ToolFailure as exc:
        raise HandoffError(str(exc)) from None
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = _free_name(destination_dir, wanted)
    fd, tmp_name = tempfile.mkstemp(dir=destination_dir, prefix=f".{wanted}.", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as out, open(source, "rb", opener=_no_follow) as src:
            for chunk in iter(lambda: src.read(1024 * 1024), b""):
                out.write(chunk)
            out.flush()
            os.fsync(out.fileno())
        if os.path.getsize(tmp_name) != info.st_size or _sha256(Path(tmp_name)) != _sha256(source):
            raise HandoffError(
                f"the copy of {source.name} did not match the engine's file; nothing was kept"
            )
        os.replace(tmp_name, destination)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
        raise
    os.unlink(source)
    return Brought(path=destination.relative_to(workspace_root).as_posix(), bytes=info.st_size)


def _no_follow(path: str, flags: int) -> int:
    return os.open(path, flags | getattr(os, "O_NOFOLLOW", 0))
```

- [ ] **Step 4: Run it to see it pass**

Run: `CORE uv run pytest -q tests/test_browser_files.py`
Expected: `20 passed`.

- [ ] **Step 5: Format and commit**

```bash
CORE uv run ruff format app/browser/files.py tests/test_browser_files.py && uv run ruff check app tests
git -C $W add services/core/app/browser/files.py services/core/tests/test_browser_files.py
NOVA_SKIP_HOOKS=1 git -C $W commit -q -F - <<'MSG'
feat(core): her browser's files reach her workspace checked, never overwriting, never escaping (S38)

Only a file the engine REPORTED is brought in: copied into the calling turn's
workspace, its size and sha256 matched against the engine's copy, and only
then the engine's copy removed. A page-chosen name becomes one safe file
name; an existing file gets a ' (n)' name instead of being overwritten; a
link in the engine's volume is refused and removed, never followed; a file
over 1 GiB is stated, not copied.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFVvjmicBfxQjL1oY3RqtA
MSG
git -C $W show --stat HEAD | tail -4
```

---
## Task 4: The one way core calls the engine

**Waits on S37a Tasks 1–3** (the fake server, and the client in both eras) **on `main`**. Validated before this plan was written: the code and tests below passed against S37a's PLANNED fake and client, assembled from its plan (`3282b820`); S37a's own 32 client tests passed on that assembly. A no-lock mutation of `session()` turns `test_two_opens_at_once_never_interleave_their_calls` red.

**Files:**
- Create: `services/core/app/browser/engine.py`
- Modify: `services/core/tests/browser_engine.py` (the fake engine)
- Test: `services/core/tests/test_browser_engine.py`

**Interfaces:**
- Consumes: `app.mcp.client` (`Endpoint`, `call`, `ClientError`, `plant`, `unplant`), `app.mcp.fake` (`FakeSpec`, `FakeTool`, `FakeServer`, `Unreachable`, `transport`); `page.parse` (Task 2).
- Produces (Task 5 and 9 use these):
  ```python
  ENDPOINT_ENV = "BROWSER_MCP_URL"; DEFAULT_URL = "http://browser:8931/mcp"; ENGINE_NAME = "browser"; CALL_TIMEOUT_S = 60.0
  class EngineError(Exception): reason: str
  def endpoint() -> client.Endpoint
  async def session() -> AsyncIterator[None]          # an async context manager: one tool's calls, never split
  async def call(tool: str, arguments: Mapping[str, Any], *, timeout_s: float = CALL_TIMEOUT_S) -> page.EngineAnswer
  # tests/browser_engine.py
  ORIGIN = "http://browser:8931"
  def engine_tool(name: str, *steps: str, error: bool | None = None) -> fake.FakeTool
  def fake_engine(*tools) -> ContextManager[fake.FakeServer]
  ```

- [ ] **Step 1: The fake engine** — in `services/core/tests/browser_engine.py`, add `import contextlib` above `import json`, and append:

```python
ORIGIN = "http://browser:8931"


def engine_tool(name: str, *steps: str, error: bool | None = None):
    """A fake engine tool answering with the captured texts of `steps`, in
    order (the last repeats). `error` defaults to what the capture says."""
    from app.mcp import fake

    results = tuple(
        {"text": answer_text(step), "is_error": is_error(step) if error is None else error}
        for step in steps
    )
    return fake.FakeTool(name, results=results)


@contextlib.contextmanager
def fake_engine(*tools):
    """Plant a strict 2025-era fake engine at http://browser:8931 for the body
    of a `with` — the real engine's era, answering as an event stream as it
    does (both measured). A context manager inside the test, because a
    ContextVar token is reset only where it was set."""
    from app.mcp import client, fake

    server = fake.FakeServer(
        fake.FakeSpec(title="Playwright", era="legacy", respond="sse", tools=tools)
    )
    handle = client.plant({ORIGIN: fake.transport(server)})
    try:
        yield server
    finally:
        client.unplant(handle)
```

- [ ] **Step 2: Write the failing test** — `services/core/tests/test_browser_engine.py`

```python
"""The one way core calls the engine (S38): the pinned engine's era, its
refusals passed on as answers, a call it could not make stated, and one
tool's calls never split by another's."""

from __future__ import annotations

import asyncio

import pytest

from app.browser import engine
from app.mcp import client, fake
from tests.browser_engine import ORIGIN, engine_tool, fake_engine


async def test_the_engine_is_spoken_to_in_its_own_era_and_its_answer_is_read():
    with fake_engine(engine_tool("browser_navigate", "navigate-index")) as server:
        async with engine.session():
            answer = await engine.call("browser_navigate", {"url": "http://site:8000/index.html"})
    assert (answer.url, answer.title, answer.error) == (
        "http://site:8000/index.html",
        "Capture index",
        None,
    )
    methods = [call["method"] for call in server.calls]
    assert "initialize" in methods and methods[-1] == "tools/call"


async def test_the_engines_own_refusal_is_the_answers_error():
    with fake_engine(engine_tool("browser_click", "click-stale-ref")):
        async with engine.session():
            answer = await engine.call("browser_click", {"target": "e9999"})
    assert answer.error == (
        "Ref e9999 not found in the current page snapshot. Try capturing new snapshot."
    )


async def test_an_error_with_no_error_section_still_says_what_it_was():
    tool = fake.FakeTool("browser_click", results=({"text": "boom: it broke", "is_error": True},))
    with fake_engine(tool):
        async with engine.session():
            answer = await engine.call("browser_click", {"target": "e1"})
    assert answer.error == "boom: it broke"


async def test_an_unreachable_engine_is_a_stated_failure():
    handle = client.plant({ORIGIN: fake.Unreachable()})
    try:
        with pytest.raises(engine.EngineError) as caught:
            async with engine.session():
                await engine.call("browser_navigate", {"url": "https://example.com"})
    finally:
        client.unplant(handle)
    assert caught.value.reason.startswith(
        "the browser engine is not answering at http://browser:8931"
    )


async def test_the_address_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv(engine.ENDPOINT_ENV, "http://elsewhere:9999/mcp")
    assert engine.endpoint().origin == "http://elsewhere:9999"
    monkeypatch.delenv(engine.ENDPOINT_ENV)
    assert engine.endpoint().url == engine.DEFAULT_URL


async def test_two_opens_at_once_never_interleave_their_calls():
    navigate = engine_tool("browser_navigate", "navigate-index")
    snapshot = engine_tool("browser_snapshot", "snapshot-index")

    async def open_and_read(url: str) -> None:
        async with engine.session():
            await engine.call("browser_navigate", {"url": url})
            await asyncio.sleep(0)  # give the other task every chance to cut in
            await engine.call("browser_snapshot", {})

    with fake_engine(navigate, snapshot) as server:
        await asyncio.gather(open_and_read("http://a.example/"), open_and_read("http://b.example/"))
    names = [call["params"]["name"] for call in server.calls if call["method"] == "tools/call"]
    assert names == ["browser_navigate", "browser_snapshot"] * 2
```

- [ ] **Step 3: Run it to see it fail**

Run: `CORE uv run pytest -q tests/test_browser_engine.py`
Expected: FAIL at collection, `ImportError: cannot import name 'engine' from 'app.browser'`.

- [ ] **Step 4: The engine's caller** — `services/core/app/browser/engine.py`

```python
"""The one way core calls her browser's engine (S38).

The engine is Microsoft's Playwright MCP server in the `browser` service
(deploy/docker-compose.yml), reached at BROWSER_MCP_URL through S37a's MCP
client — never through her mcp_call, and never a row in mcp_servers. It speaks
only the 2025 protocol era (measured 2026-09-30: `server/discover` answers
HTTP 400 with -32000 "Bad Request: Server not initialized"), which the client
finds, remembers, and re-establishes when the engine forgets its session.

One page serves every turn and session (`--shared-browser-context`, which a
persistent profile requires), so a tool runs its calls inside session(): a
navigation and the read after it are never split by another turn's call.
Between two tool calls another turn may still move the page; every result
names the page it saw, so that is visible, never silent.
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import os
import weakref
from collections.abc import AsyncIterator, Mapping
from typing import Any

from app.browser import page
from app.mcp import client

ENDPOINT_ENV = "BROWSER_MCP_URL"
DEFAULT_URL = "http://browser:8931/mcp"
ENGINE_NAME = "browser"
CALL_TIMEOUT_S = 60.0

# One lock per event loop: an asyncio.Lock that has waited is bound to the
# loop it waited on, and a test suite runs many loops. Production has one.
_LOCKS: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock] = (
    weakref.WeakKeyDictionary()
)


class EngineError(Exception):
    """The engine could not be asked — not answering, not an MCP server, or
    the exchange broke. `reason` is a sentence for her."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def endpoint() -> client.Endpoint:
    return client.Endpoint(ENGINE_NAME, os.environ.get(ENDPOINT_ENV) or DEFAULT_URL)


@contextlib.asynccontextmanager
async def session() -> AsyncIterator[None]:
    """Hold the engine for one tool's whole sequence of calls."""
    loop = asyncio.get_running_loop()
    lock = _LOCKS.get(loop)
    if lock is None:
        lock = _LOCKS[loop] = asyncio.Lock()
    async with lock:
        yield


async def call(
    tool: str, arguments: Mapping[str, Any], *, timeout_s: float = CALL_TIMEOUT_S
) -> page.EngineAnswer:
    """One engine tool call, read. A call the engine ANSWERED always comes
    back as an EngineAnswer — its own refusal (a stale ref, an open dialog, a
    page that did not load) is the answer's `error`. Only a call that could
    not be made raises EngineError. Callers hold session()."""
    target = endpoint()
    try:
        result = await client.call(target, tool, arguments, timeout_s=timeout_s)
    except client.ClientError as exc:
        if exc.reachable:
            raise EngineError(
                f"the browser engine at {target.origin} answered, but not usefully: {exc.reason}"
            ) from exc
        raise EngineError(
            f"the browser engine is not answering at {target.origin} — {exc.reason}"
        ) from exc
    answer = page.parse(result.text)
    if result.is_error and answer.error is None:
        lines = (result.text or "").strip().splitlines()
        answer = dataclasses.replace(
            answer, error=lines[0] if lines else "the engine reported an error and gave no reason"
        )
    return answer
```

- [ ] **Step 5: Run it, and the import-order test**

Run: `CORE uv run pytest -q tests/test_browser_engine.py tests/test_tools_registry.py -k "engine or imports_on_its_own"`
Expected: 6 engine tests pass, and `test_the_tools_package_imports_on_its_own` passes.

- [ ] **Step 6: Prove the lock is load-bearing, once, then restore it**

```bash
CORE command cp -f app/browser/engine.py $W/.superpowers/sdd/engine.py.keep
CORE python3 - <<'EOF'
p = "app/browser/engine.py"; s = open(p).read()
open(p, "w").write(s.replace("    async with lock:\n        yield\n", "    yield  # MUTATION\n"))
EOF
CORE uv run pytest -q tests/test_browser_engine.py -k interleave 2>&1 | tail -1
CORE command cp -f $W/.superpowers/sdd/engine.py.keep app/browser/engine.py && grep -c "async with lock" app/browser/engine.py && rm -f $W/.superpowers/sdd/engine.py.keep
```

Expected: `1 failed`, then `1`. Use `command cp -f`: `cp` is aliased to prompt before overwriting in this shell, and a prompt hangs the step.

- [ ] **Step 7: Format and commit**

```bash
CORE uv run ruff format app/browser/engine.py tests/browser_engine.py tests/test_browser_engine.py && uv run ruff check app tests
git -C $W add services/core/app/browser/engine.py services/core/tests/browser_engine.py services/core/tests/test_browser_engine.py
NOVA_SKIP_HOOKS=1 git -C $W commit -q -F - <<'MSG'
feat(core): the one way core calls her browser's engine, through the MCP client (S38)

endpoint() is BROWSER_MCP_URL (browser:8931); call() returns the engine's
answer read, its own refusals as the answer's error, and raises EngineError
only when the call could not be made. session() holds one lock per event
loop for a tool's whole sequence: a navigation and its read are never
split (a no-lock mutation reddens the interleave test).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFVvjmicBfxQjL1oY3RqtA
MSG
git -C $W show --stat HEAD | tail -4
```

---
## Task 5: Her five tools, registered

**Waits on Task 4, and on S37a's Task 7 being on `main`** (it moves the same registry pins first). Validated before this plan was written: the code and tests below passed against S37a's planned client and fake; the live-facts classification passed with the three reasons below.

**Files:**
- Create: `services/core/app/tools/browser.py`
- Modify: `services/core/app/tools/__init__.py` (import and register)
- Modify: `services/core/app/live_facts.py` (`NOT_AUTO_RUN` gains three)
- Modify: `services/core/tests/test_tools_registry.py` (the pinned sets)
- Test: `services/core/tests/test_browser_tools.py`

**Interfaces:**
- Consumes: `engine` (Task 4), `files` (Task 3), `reader`/`page` (Task 2).
- Produces:
  ```python
  # app/tools/browser.py
  ACTIONS = ("click", "type", "select", "press", "accept", "dismiss")
  def address(url: str | None) -> str | None        # scheme://host/path — no user, query or fragment
  TOOLS: tuple[Tool, ...]   # browser_open, browser_read, browser_back: reads_only + ephemeral; browser_act, browser_screenshot: neither
  ```
  A page fact is `{"browser": "page", "url": address, "title": str | None, "status": int | None}`; a file fact is `{"browser": "download" | "screenshot", "path": str, "bytes": int}`. Task 7's guards read `browser == "page"` facts' `url`.

- [ ] **Step 1: Write the failing test** — `services/core/tests/test_browser_tools.py`

```python
"""Her five browser tools (S38), over a strict fake of the pinned engine
answering with its own captured words (tests/browser_engine.py)."""

from __future__ import annotations

from pathlib import Path

import pytest

from app import tools
from app.browser import files
from app.mcp import client, fake
from app.tools import browser
from app.tools.base import ToolContext, ToolFailure
from tests.browser_engine import ORIGIN, engine_tool, fake_engine

INDEX = "http://site:8000/index.html"
REPORT = b"report body line one\nreport body line two\n"


@pytest.fixture
def world(tmp_path: Path, monkeypatch):
    output = tmp_path / "engine-output"
    workspace = tmp_path / "workspace"
    output.mkdir()
    workspace.mkdir()
    monkeypatch.setenv(files.OUTPUT_DIR_ENV, str(output))
    facts: list = []
    ctx = ToolContext(app=None, person=object(), workspace_root=workspace, facts_sink=facts)
    return ctx, output, workspace, facts


def _called(server) -> list[tuple[str, dict]]:
    return [
        (call["params"]["name"], call["params"].get("arguments") or {})
        for call in server.calls
        if call["method"] == "tools/call"
    ]


# ── browser_open ────────────────────────────────────────────────────────────


async def test_open_outlines_the_page_and_files_one_page_fact(world):
    ctx, _, _, facts = world
    navigate = engine_tool("browser_navigate", "navigate-index")
    snapshot = engine_tool("browser_snapshot", "snapshot-index")
    with fake_engine(navigate, snapshot) as server:
        result = await browser.browser_open({"url": INDEX}, ctx)
    assert result.splitlines() == [
        'Opened http://site:8000/index.html — "Capture index".',
        "Headings: Capture index.",
        "It has 2 links, 2 buttons and 2 fields; 379 characters of text in 1 part of 24,000.",
        'Read it with browser_read(part=1), or search it with browser_read(query="…").',
    ]
    assert facts == [{"browser": "page", "url": INDEX, "title": "Capture index", "status": None}]
    assert _called(server) == [("browser_navigate", {"url": INDEX}), ("browser_snapshot", {})]


async def test_open_takes_http_and_https_only(world):
    ctx = world[0]
    with pytest.raises(ToolFailure, match="http and https addresses only"):
        await browser.browser_open({"url": "file:///etc/passwd"}, ctx)


async def test_an_error_page_is_a_stated_failure_that_names_its_status(world):
    ctx, _, _, facts = world
    with fake_engine(engine_tool("browser_navigate", "navigate-404")):
        with pytest.raises(ToolFailure) as caught:
            await browser.browser_open({"url": "http://site:8000/missing.html"}, ctx)
    assert "answered 404 File not found" in str(caught.value)
    assert "error page" in str(caught.value)
    assert facts[0]["status"] == 404


async def test_a_page_that_does_not_load_says_why(world):
    ctx = world[0]
    with fake_engine(engine_tool("browser_navigate", "navigate-dns-failure")):
        with pytest.raises(ToolFailure) as caught:
            await browser.browser_open({"url": "http://no-such-host.invalid/"}, ctx)
    assert str(caught.value) == (
        "http://no-such-host.invalid/ did not open: "
        "net::ERR_NAME_NOT_RESOLVED at http://no-such-host.invalid/"
    )


# ── browser_read ────────────────────────────────────────────────────────────


async def test_read_gives_a_part_of_the_page_it_names(world):
    ctx, _, _, facts = world
    with fake_engine(engine_tool("browser_snapshot", "snapshot-long")):
        first = await browser.browser_read({}, ctx)
        second = await browser.browser_read({"part": 2}, ctx)
        with pytest.raises(ToolFailure, match="has 2 parts; there is no part 3"):
            await browser.browser_read({"part": 3}, ctx)
    assert first.splitlines()[0] == 'http://site:8000/long.html — "A long page" · part 1 of 2'
    assert first.splitlines()[2] == "# A long page"
    assert second.splitlines()[2].startswith("Paragraph 219 of the long page")
    assert facts[0] == {
        "browser": "page",
        "url": "http://site:8000/long.html",
        "title": "A long page",
        "status": None,
    }


async def test_read_searches_by_every_word(world):
    ctx = world[0]
    with fake_engine(engine_tool("browser_snapshot", "snapshot-long")):
        found = await browser.browser_read({"query": "zebra-quartz"}, ctx)
        many = await browser.browser_read({"query": "many details"}, ctx)
        missing = await browser.browser_read({"query": "zebra-quartz unicorn"}, ctx)
    assert found.splitlines() == [
        "http://site:8000/long.html — \"A long page\" · 1 line holds every word of 'zebra-quartz':",
        "- part 2 under '# A long page': The needle sentence is here: zebra-quartz lives in"
        " paragraph three hundred.",
    ]
    many_lines = many.splitlines()
    assert many_lines[0].endswith("· 399 lines hold every word of 'many details':")
    assert len(many_lines) == 1 + 40 + 1  # the header, MAX_MATCHES lines, the rest counted
    assert many_lines[-1] == "…and 359 more; use more words, or read a part."
    assert (
        missing.splitlines()[1] == "No line holds every word of 'zebra-quartz unicorn' (2 parts)."
    )


async def test_reading_under_a_dialog_says_to_answer_it_first(world):
    ctx = world[0]
    with fake_engine(engine_tool("browser_snapshot", "snapshot-during-dialog")):
        with pytest.raises(ToolFailure) as caught:
            await browser.browser_read({}, ctx)
    assert str(caught.value) == (
        'an alert dialog is open on the page ("Hello from the page") — answer it with '
        'browser_act(action="accept") or browser_act(action="dismiss") first'
    )


# ── browser_act ─────────────────────────────────────────────────────────────


async def test_a_click_names_what_the_engine_clicked_and_the_new_page(world):
    ctx, _, _, facts = world
    with fake_engine(engine_tool("browser_click", "click-link")) as server:
        result = await browser.browser_act({"action": "click", "ref": "f3e4"}, ctx)
    assert result.splitlines() == [
        'Clicked link "Page two".',
        'The page is now http://site:8000/page2.html — "Page two".',
    ]
    assert _called(server) == [("browser_click", {"target": "f3e4"})]
    assert facts[-1]["url"] == "http://site:8000/page2.html"


async def test_typing_never_echoes_what_was_typed(world):
    ctx, _, _, facts = world
    with fake_engine(engine_tool("browser_type", "type")) as server:
        result = await browser.browser_act(
            {"action": "type", "ref": "f3e17", "value": "hello world"}, ctx
        )
    assert result.splitlines() == [
        'Typed 11 characters into textbox "Search words".',
        "The engine reported no new page, dialog or download.",
    ]
    assert "hello world" not in result and "hello world" not in repr(facts)
    assert _called(server) == [("browser_type", {"target": "f3e17", "text": "hello world"})]


async def test_select_and_press_and_submit_reach_the_engine_as_its_own_calls(world):
    ctx = world[0]
    select = engine_tool("browser_select_option", "select")
    press = engine_tool("browser_press_key", "press-key")
    typed = engine_tool("browser_type", "type-submit")
    with fake_engine(select, press, typed) as server:
        assert (
            await browser.browser_act({"action": "select", "ref": "f3e18", "value": "b"}, ctx)
        ).startswith('Selected "b" in label "Pick one".')
        assert (await browser.browser_act({"action": "press", "value": "Tab"}, ctx)).startswith(
            "Pressed Tab."
        )
        await browser.browser_act(
            {"action": "type", "ref": "f3e17", "value": "sent words", "submit": True}, ctx
        )
    assert _called(server) == [
        ("browser_select_option", {"target": "f3e18", "values": ["b"]}),
        ("browser_press_key", {"key": "Tab"}),
        ("browser_type", {"target": "f3e17", "text": "sent words", "submit": True}),
    ]


async def test_no_query_reaches_a_result_or_a_fact(world):
    ctx, _, _, facts = world
    with fake_engine(engine_tool("browser_type", "type-submit")):
        result = await browser.browser_act(
            {"action": "type", "ref": "f3e17", "value": "sent words", "submit": True}, ctx
        )
    assert 'The page is now http://site:8000/page2.html?… — "Page two".' in result.splitlines()
    assert "sent+words" not in result and "sent+words" not in repr(facts)
    assert facts[-1]["url"] == "http://site:8000/page2.html"


async def test_a_dialog_is_named_with_how_to_answer_it(world):
    ctx = world[0]
    alert = engine_tool("browser_click", "click-alert")
    answer = engine_tool("browser_handle_dialog", "handle-dialog")
    with fake_engine(alert, answer) as server:
        clicked = await browser.browser_act({"action": "click", "ref": "f3e22"}, ctx)
        accepted = await browser.browser_act({"action": "accept"}, ctx)
    assert clicked.splitlines() == [
        'Clicked button "Show alert".',
        "The page is now http://site:8000/index.html.",
        'The page opened an alert dialog: "Hello from the page" — answer it with '
        'browser_act(action="accept") or browser_act(action="dismiss").',
    ]
    assert accepted.splitlines() == [
        "Accepted the dialog.",
        'The page is now http://site:8000/index.html — "Capture index".',
    ]
    assert _called(server)[-1] == ("browser_handle_dialog", {"accept": True})


async def test_a_stale_ref_says_to_read_the_page_again(world):
    ctx = world[0]
    with fake_engine(engine_tool("browser_click", "click-stale-ref")):
        with pytest.raises(ToolFailure, match="e9999 is no longer on the page"):
            await browser.browser_act({"action": "click", "ref": "e9999"}, ctx)


@pytest.mark.parametrize(
    "args,said",
    [
        ({"action": "wave"}, "action must be one of"),
        ({"action": "click"}, "needs the ref of an element"),
        ({"action": "type", "ref": "e1"}, "needs a value"),
        ({"action": "press"}, "needs a value"),
    ],
)
async def test_an_incomplete_action_is_refused_before_the_engine(world, args, said):
    with pytest.raises(ToolFailure, match=said):
        await browser.browser_act(args, world[0])


# ── downloads and screenshots ───────────────────────────────────────────────


async def test_a_download_lands_in_the_workspace_and_leaves_the_engine(world):
    ctx, output, workspace, facts = world
    (output / "report.txt").write_bytes(REPORT)
    with fake_engine(engine_tool("browser_click", "click-download")):
        result = await browser.browser_act({"action": "click", "ref": "f3e21"}, ctx)
    assert result.splitlines() == [
        'Clicked link "Download the report".',
        "Downloaded downloads/report.txt (42 bytes).",
    ]
    assert (workspace / "downloads" / "report.txt").read_bytes() == REPORT
    assert not (output / "report.txt").exists()
    assert facts[-1] == {"browser": "download", "path": "downloads/report.txt", "bytes": 42}


async def test_a_download_that_did_not_arrive_is_said(world):
    ctx = world[0]
    with fake_engine(engine_tool("browser_click", "click-download")):
        result = await browser.browser_act({"action": "click", "ref": "f3e21"}, ctx)
    assert result.splitlines()[-1] == (
        "A download did not reach the workspace: the engine reported /output/report.txt, "
        "and it is not there."
    )


async def test_a_screenshot_lands_in_screenshots(world):
    ctx, output, workspace, facts = world
    (output / "page-2026-09-30T20-25-33-996Z.png").write_bytes(b"\x89PNG" + b"0" * 2044)
    with fake_engine(engine_tool("browser_take_screenshot", "screenshot")) as server:
        result = await browser.browser_screenshot({}, ctx)
    saved = facts[-1]["path"]
    assert saved.startswith("screenshots/") and saved.endswith(".png")
    assert (workspace / saved).stat().st_size == 2048
    assert result == (
        f"Saved a screenshot of the page to {saved} (2 KB). The image is in the workspace; "
        "it is not read into this conversation."
    )
    assert _called(server) == [("browser_take_screenshot", {"type": "png", "scale": "css"})]


# ── back, and the engine down ───────────────────────────────────────────────


async def test_back_names_the_page_it_landed_on(world):
    ctx = world[0]
    with fake_engine(engine_tool("browser_navigate_back", "back")):
        assert await browser.browser_back({}, ctx) == (
            'Back on http://site:8000/index.html — "Capture index".'
        )


async def test_every_tool_says_the_engine_is_not_answering(world):
    ctx = world[0]
    handle = client.plant({ORIGIN: fake.Unreachable()})
    try:
        for name, args in [
            ("browser_open", {"url": INDEX}),
            ("browser_read", {}),
            ("browser_act", {"action": "click", "ref": "e1"}),
            ("browser_back", {}),
            ("browser_screenshot", {}),
        ]:
            result, ok = await tools.dispatch(name, args, ctx)
            assert not ok, name
            assert result.startswith(
                "Error: the browser engine is not answering at http://browser:8931"
            ), (name, result)
    finally:
        client.unplant(handle)


# ── the registry's entries ──────────────────────────────────────────────────


def test_the_five_tools_are_registered_with_what_they_change():
    names = {name for name in tools.REGISTRY if name.startswith("browser_")}
    assert names == {
        "browser_open",
        "browser_read",
        "browser_act",
        "browser_back",
        "browser_screenshot",
    }
    reads = {name for name in names if tools.REGISTRY[name].reads_only}
    assert reads == {"browser_open", "browser_read", "browser_back"}
    stale = {name for name in names if tools.REGISTRY[name].ephemeral}
    assert stale == {"browser_open", "browser_read", "browser_back"}


async def test_dispatch_runs_browser_open_through_the_one_funnel(world):
    ctx = world[0]
    navigate = engine_tool("browser_navigate", "navigate-index")
    snapshot = engine_tool("browser_snapshot", "snapshot-index")
    with fake_engine(navigate, snapshot):
        result, ok = await tools.dispatch("browser_open", {"url": INDEX}, ctx)
    assert ok and result.startswith('Opened http://site:8000/index.html — "Capture index".')
```

- [ ] **Step 2: Run it to see it fail**

Run: `CORE uv run pytest -q tests/test_browser_tools.py`
Expected: FAIL at collection, `ImportError: cannot import name 'browser' from 'app.tools'`.

- [ ] **Step 3: The tools** — `services/core/app/tools/browser.py`

```python
"""Her browser (S38): five tools that drive the engine through app/browser.

browser_open opens a page and outlines it; browser_read reads it in parts or
searches it; browser_act clicks, types, selects, presses, and answers a
dialog; browser_back goes back; browser_screenshot saves a picture of the page
into her workspace. Each says what the engine REPORTED — the page it is on, a
dialog the page opened, a file it downloaded — and files a `browser` fact per
page it saw, so the guards and Activity read facts, never prose.

An address is never shown or recorded with its user info, query or fragment:
a reset or sign-in link carries its token there. What she types is never
echoed back. The engine's own code section, which holds both, never leaves
app/browser/page.py.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from urllib.parse import urlsplit

from app.browser import engine, files, reader
from app.browser.page import EngineAnswer
from app.tools.base import Tool, ToolContext, ToolFailure

ACTIONS = ("click", "type", "select", "press", "accept", "dismiss")
_NEEDS_REF = frozenset({"click", "type", "select"})
_NEEDS_VALUE = {
    "type": "the text to type",
    "select": "the option to choose, as the page names it",
    "press": "a key name such as Enter, Tab or ArrowDown",
}
_ANSWER_A_DIALOG = 'answer it with browser_act(action="accept") or browser_act(action="dismiss")'


def address(url: str | None) -> str | None:
    """An address as a fact holds it: scheme, host and path — no user info,
    query or fragment."""
    if not url:
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return url.split("?", 1)[0].split("#", 1)[0]
    if not parts.scheme or not parts.netloc:
        return url.split("?", 1)[0].split("#", 1)[0]
    return f"{parts.scheme}://{parts.netloc.rpartition('@')[2]}{parts.path}"


def _shown(url: str | None) -> str:
    """An address as she reads it: the fact's form, with a mark where a query
    or fragment was left out."""
    if not url:
        return "the page"
    kept = address(url) or url
    hidden = "?" in url or "#" in url
    return f"{kept}?…" if hidden else kept


def _fact(ctx: ToolContext, fact: dict) -> None:
    if ctx.facts_sink is not None:
        ctx.facts_sink.append(fact)


def _page_fact(ctx: ToolContext, answer: EngineAnswer) -> None:
    if answer.url:
        _fact(
            ctx,
            {
                "browser": "page",
                "url": address(answer.url),
                "title": answer.title,
                "status": answer.status,
            },
        )


def _where(answer: EngineAnswer, fallback: str | None = None) -> str:
    title = f' — "{answer.title}"' if answer.title else ""
    return f"{_shown(answer.url or fallback)}{title}"


def _size(count: int) -> str:
    if count < 1024:
        return f"{count} bytes"
    if count < 1024 * 1024:
        return f"{count / 1024:.0f} KB"
    return f"{count / (1024 * 1024):.1f} MB"


def _a(word: str) -> str:
    return f"an {word}" if word[:1].lower() in "aeiou" else f"a {word}"


def _dialog_lines(answer: EngineAnswer) -> list[str]:
    lines = []
    for dialog in answer.dialogs:
        said = f': "{dialog.message}"' if dialog.message else ""
        lines.append(f"The page opened {_a(dialog.kind)} dialog{said} — {_ANSWER_A_DIALOG}.")
    return lines


async def _bring_downloads(ctx: ToolContext, answer: EngineAnswer) -> list[str]:
    """Each finished download brought into this turn's workspace, as lines to
    tell her — a failure is a line too, never dropped."""
    lines = []
    for name, engine_path in answer.downloads:
        try:
            brought = await asyncio.to_thread(
                files.bring_in,
                engine_path,
                output_dir=files.output_dir_from_env(),
                workspace_root=ctx.workspace_root,
                folder="downloads",
                name=name,
            )
        except files.HandoffError as exc:
            lines.append(f"A download did not reach the workspace: {exc}.")
            continue
        _fact(ctx, {"browser": "download", "path": brought.path, "bytes": brought.bytes})
        lines.append(f"Downloaded {brought.path} ({_size(brought.bytes)}).")
    return lines


async def _call(tool: str, arguments: dict) -> EngineAnswer:
    try:
        return await engine.call(tool, arguments)
    except engine.EngineError as exc:
        raise ToolFailure(exc.reason) from exc


# ── browser_open ────────────────────────────────────────────────────────────


async def browser_open(args: dict, ctx: ToolContext) -> str:
    url = args["url"].strip()
    if urlsplit(url).scheme.lower() not in ("http", "https"):
        raise ToolFailure(f"the browser opens http and https addresses only, not {_shown(url)}")
    async with engine.session():
        opened = await _call("browser_navigate", {"url": url})
        if opened.error:
            raise ToolFailure(f"{_shown(url)} did not open: {opened.error}")
        _page_fact(ctx, opened)
        notes = await _bring_downloads(ctx, opened)
        if opened.status is not None and opened.status >= 400:
            status = f"{opened.status} {opened.status_text}".rstrip()
            raise ToolFailure(
                f"{_shown(opened.url or url)} answered {status} — the browser now shows the "
                "site's error page; browser_read can read it"
            )
        if opened.dialogs:
            return "\n".join([f"Opened {_where(opened, url)}.", *_dialog_lines(opened), *notes])
        snap = await _call("browser_snapshot", {})
    if snap.error:
        raise ToolFailure(
            f"{_shown(opened.url or url)} opened, and could not be read: {snap.error}"
        )
    read = await asyncio.to_thread(reader.read, snap.snapshot or "")
    outline = reader.outline(read)
    lines = [f"Opened {_where(snap if snap.url else opened, url)}."]
    if outline.headings:
        more = f" (and {outline.more_headings} more)" if outline.more_headings else ""
        lines.append("Headings: " + "; ".join(outline.headings) + more + ".")
    parts = len(read.parts)
    lines.append(
        f"It has {outline.links} links, {outline.buttons} buttons and {outline.fields} fields; "
        f"{read.chars:,} characters of text in {parts} part{'s' if parts != 1 else ''} of "
        f"{reader.DEFAULT_PART_CHARS:,}."
    )
    lines.append('Read it with browser_read(part=1), or search it with browser_read(query="…").')
    lines.extend(notes)
    return "\n".join(lines)


# ── browser_read ────────────────────────────────────────────────────────────


async def browser_read(args: dict, ctx: ToolContext) -> str:
    part_chars = int(args.get("max_chars") or reader.DEFAULT_PART_CHARS)
    async with engine.session():
        snap = await _call("browser_snapshot", {})
    if snap.dialogs:
        dialog = snap.dialogs[0]
        said = f' ("{dialog.message}")' if dialog.message else ""
        raise ToolFailure(
            f"{_a(dialog.kind)} dialog is open on the page{said} — {_ANSWER_A_DIALOG} first"
        )
    if snap.error:
        raise ToolFailure(f"the page could not be read: {snap.error}")
    _page_fact(ctx, snap)
    read = await asyncio.to_thread(reader.read, snap.snapshot or "", part_chars)
    count = len(read.parts)
    head = f"{_where(snap)}"
    query = (args.get("query") or "").strip()
    if query:
        matches, total = reader.search(read, query)
        if not matches:
            parts = f"{count} part{'s' if count != 1 else ''}"
            return f"{head}\nNo line holds every word of {query!r} ({parts})."
        held = "1 line holds" if total == 1 else f"{total:,} lines hold"
        lines = [f"{head} · {held} every word of {query!r}:"]
        for match in matches:
            under = f" under {match.heading!r}" if match.heading else ""
            lines.append(f"- part {match.part}{under}: {match.text}")
        if total > len(matches):
            lines.append(f"…and {total - len(matches)} more; use more words, or read a part.")
        return "\n".join(lines)
    wanted = int(args.get("part") or 1)
    if wanted > count:
        raise ToolFailure(
            f"the page has {count} part{'s' if count != 1 else ''}; there is no part {wanted}"
        )
    body = read.parts[wanted - 1] or "(The page has no text.)"
    return f"{head} · part {wanted} of {count}\n\n{body}"


# ── browser_act ─────────────────────────────────────────────────────────────


def _engine_call(action: str, ref: str, value: str | None, submit: bool) -> tuple[str, dict]:
    if action == "click":
        return "browser_click", {"target": ref}
    if action == "type":
        arguments = {"target": ref, "text": value}
        if submit:
            arguments["submit"] = True
        return "browser_type", arguments
    if action == "select":
        return "browser_select_option", {"target": ref, "values": [value]}
    if action == "press":
        return "browser_press_key", {"key": value}
    if action == "accept":
        return "browser_handle_dialog", {"accept": True, **({"promptText": value} if value else {})}
    return "browser_handle_dialog", {"accept": False}


def _did(action: str, answer: EngineAnswer, ref: str, value: str | None) -> str:
    target = answer.acted_on or (f"[{ref}]" if ref else "the page")
    if action == "click":
        return f"Clicked {target}"
    if action == "type":
        return f"Typed {len(value or '')} characters into {target}"
    if action == "select":
        return f'Selected "{value}" in {target}'
    if action == "press":
        return f"Pressed {value}"
    if action == "accept":
        return "Accepted the dialog"
    return "Dismissed the dialog"


async def browser_act(args: dict, ctx: ToolContext) -> str:
    action = (args.get("action") or "").strip().lower()
    if action not in ACTIONS:
        raise ToolFailure(f"action must be one of {', '.join(ACTIONS)} — re-issue the call")
    ref = (args.get("ref") or "").strip()
    value = args.get("value")
    if action in _NEEDS_REF and not ref:
        raise ToolFailure(
            f"{action} needs the ref of an element, like e12, from browser_read — re-issue the call"
        )
    if action in _NEEDS_VALUE and not (isinstance(value, str) and value):
        raise ToolFailure(f"{action} needs a value: {_NEEDS_VALUE[action]} — re-issue the call")
    tool, arguments = _engine_call(action, ref, value, bool(args.get("submit")))
    async with engine.session():
        answer = await _call(tool, arguments)
        if (
            answer.error
            and action == "dismiss"
            and any("file" in d.kind.lower() for d in answer.dialogs)
        ):
            # A file chooser is not a dialog to the engine; an upload with no
            # files cancels it (the engine's documented cancel; unmeasured).
            answer = await _call("browser_file_upload", {})
    if answer.error:
        if "not found in the current page snapshot" in answer.error:
            raise ToolFailure(
                f"{ref or 'that element'} is no longer on the page — refs change when the page "
                "does; read the page again (browser_read) and use a new ref"
            )
        raise ToolFailure(f"the engine refused: {answer.error}")
    _page_fact(ctx, answer)
    lines = [f"{_did(action, answer, ref, value)}."]
    if answer.url:
        lines.append(f"The page is now {_where(answer)}.")
    lines.extend(_dialog_lines(answer))
    lines.extend(await _bring_downloads(ctx, answer))
    if len(lines) == 1:
        lines.append("The engine reported no new page, dialog or download.")
    return "\n".join(lines)


# ── browser_back ────────────────────────────────────────────────────────────


async def browser_back(args: dict, ctx: ToolContext) -> str:
    async with engine.session():
        answer = await _call("browser_navigate_back", {})
    if answer.error:
        raise ToolFailure(f"could not go back: {answer.error}")
    _page_fact(ctx, answer)
    if not answer.url:
        return "Went back; the engine reported no page."
    return "\n".join([f"Back on {_where(answer)}.", *_dialog_lines(answer)])


# ── browser_screenshot ──────────────────────────────────────────────────────


async def browser_screenshot(args: dict, ctx: ToolContext) -> str:
    async with engine.session():
        answer = await _call("browser_take_screenshot", {"type": "png", "scale": "css"})
    if answer.error:
        raise ToolFailure(f"no screenshot was taken: {answer.error}")
    if not answer.files:
        raise ToolFailure("the engine took no screenshot file it could name")
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    try:
        brought = await asyncio.to_thread(
            files.bring_in,
            answer.files[0],
            output_dir=files.output_dir_from_env(),
            workspace_root=ctx.workspace_root,
            folder="screenshots",
            name=f"{stamp}.png",
        )
    except files.HandoffError as exc:
        raise ToolFailure(f"a screenshot was taken and did not reach the workspace: {exc}") from exc
    _fact(ctx, {"browser": "screenshot", "path": brought.path, "bytes": brought.bytes})
    return (
        f"Saved a screenshot of the page to {brought.path} ({_size(brought.bytes)}). The image "
        "is in the workspace; it is not read into this conversation."
    )


# ── the registry's entries ──────────────────────────────────────────────────

TOOLS: tuple[Tool, ...] = (
    Tool(
        name="browser_open",
        description=(
            "Open a web page in your own browser (http or https) and get its title and an "
            "outline: headings, how many links, buttons and fields, and how many parts its "
            "text fills. Your browser keeps its logins between sessions. Read the page with "
            "browser_read."
        ),
        parameters={
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "The full http/https address to open."}
            },
            "required": ["url"],
            "additionalProperties": False,
        },
        executor=browser_open,
        reads_only=True,
        # A page is a live read that goes stale, like fetch_url's: a turn that
        # read one is not ingested into memory.
        ephemeral=True,
    ),
    Tool(
        name="browser_read",
        description=(
            "Read the page your browser is on: its text, with every link, button and field "
            "marked by a ref like [e12] that browser_act takes. A long page comes in parts — "
            "read part 1, then 2 — or search it with query to get only the lines holding "
            "every word, with their part numbers."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Words every returned line must hold."},
                "part": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Which part to read; 1 first.",
                },
                "max_chars": {
                    "type": "integer",
                    "minimum": reader.MIN_PART_CHARS,
                    "maximum": reader.MAX_PART_CHARS,
                    "description": "How long a part may be (default 24000 characters).",
                },
            },
            "additionalProperties": False,
        },
        executor=browser_read,
        reads_only=True,
        ephemeral=True,
    ),
    Tool(
        name="browser_act",
        description=(
            "Act on the page your browser is on, using a ref from browser_read: click, type "
            "(with submit to press Enter after), select an option, or press a key; or answer "
            "a dialog the page opened with accept or dismiss. Says what the page did: a new "
            "page, a dialog, a download (saved in your downloads folder)."
        ),
        parameters={
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": list(ACTIONS)},
                "ref": {"type": "string", "description": "The element's ref, like e12."},
                "value": {
                    "type": "string",
                    "description": (
                        "What to type, the option to select, the key to press, or a "
                        "prompt's answer."
                    ),
                },
                "submit": {"type": "boolean", "description": "For type: press Enter after."},
            },
            "required": ["action"],
            "additionalProperties": False,
        },
        executor=browser_act,
    ),
    Tool(
        name="browser_back",
        description="Go back to the previous page in your browser.",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        executor=browser_back,
        reads_only=True,
        ephemeral=True,
    ),
    Tool(
        name="browser_screenshot",
        description=(
            "Save a picture of the page your browser is on into your screenshots folder. The "
            "image is saved, not shown to you."
        ),
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        executor=browser_screenshot,
    ),
)
```

- [ ] **Step 4: Register them** — in `services/core/app/tools/__init__.py`

Add `browser,` as the first name in the `from app.tools import (…)` block (it is alphabetical), and in `REGISTRY`, right after `*web_search.TOOLS,`:

```python
        # S38: her own browser (tools/browser.py) — five tools over the engine
        # in the `browser` service, through app/browser/engine.py.
        *browser.TOOLS,
```

`test_the_tools_package_imports_nothing_that_could_decide` stays green: the import is `app.tools.browser`, inside the package.

- [ ] **Step 5: Say why the three readers never run unasked** — in `services/core/app/live_facts.py`, inside `NOT_AUTO_RUN`, after the `load_skill` entry:

```python
    # S38: her browser. Each reads a page someone chose, on one browser every
    # turn shares, so a note could steer it and running it unasked would move
    # the page under whoever is using it.
    "browser_open": "the note would choose the address; nothing checks it against this system",
    "browser_read": "it reads whatever page the shared browser is on, which no note can name",
    "browser_back": "it moves the shared browser, whose history no note can name",
```

- [ ] **Step 6: Move the pinned sets** — `services/core/tests/test_tools_registry.py`

- In `test_the_registered_tools_are_exactly_this_set_by_name`:
  - add `"browser_act"`, `"browser_back"`, `"browser_open"`, `"browser_read"`, `"browser_screenshot"` to the set;
  - add to its history comment: `# Deliberate snapshot update (S38, 2026-10): her browser's five tools joined, so this set moved by five.`
- In `test_the_tools_that_change_nothing_are_pinned_by_name`: add `"browser_back"`, `"browser_open"`, `"browser_read"`, with the same dated line.

`test_every_tool_that_writes_says_it_changes_something` needs nothing: `browser_act` and `browser_screenshot` are not `reads_only`.

- [ ] **Step 7: Run it, and the suites that read the registry**

Run: `CORE TEST_DATABASE_URL="$CORE_DB" uv run pytest -q tests/test_browser_tools.py tests/test_tools_registry.py tests/test_live_facts.py tests/test_no_approvals.py tests/test_capability_guard.py 2>&1 | tail -3`
Expected: all pass, none skipped. `test_no_approvals.py` is unchanged (`git -C $W diff --stat origin/main -- services/core/tests/test_no_approvals.py` prints nothing).

- [ ] **Step 8: Format and commit**

```bash
CORE uv run ruff format app/tools/browser.py app/tools/__init__.py app/live_facts.py tests/test_tools_registry.py tests/test_browser_tools.py && uv run ruff check app tests
git -C $W add services/core/app/tools/browser.py services/core/app/tools/__init__.py services/core/app/live_facts.py services/core/tests/test_tools_registry.py services/core/tests/test_browser_tools.py
NOVA_SKIP_HOOKS=1 git -C $W commit -q -F - <<'MSG'
feat(core): her five browser tools — open, read, act, back, screenshot (S38)

Each says what the engine reported (the page it is on, a dialog the page
opened, a download brought into the workspace) and files a `browser` fact;
an address never carries its user info, query or fragment, and typed text
is never echoed. A 4xx/5xx is a stated failure, like fetch_url's. The
registry moves by five and reads_only by three (open, read, back), each
excluded from AUTO_RUN with its reason.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFVvjmicBfxQjL1oY3RqtA
MSG
git -C $W show --stat HEAD | tail -4
```

---
## Task 6: No token in an address reaches the trace

**Waits on S37a Task 6 on `main`** (it rewrites `chat._redact`; this adds one branch to it). Validated before this plan was written: applied on top of S37a's planned `_redact`, both suites passed.

**Files:**
- Modify: `services/core/app/chat.py` (`_address_without_secrets`; one branch in `_redact`; `from urllib.parse import urlsplit`)
- Test: `services/core/tests/test_span_url_masking.py`

**Interfaces:**
- Consumes: S37a's `_redact(value, *, in_headers=False)`, `_credential_key`, `_masked`, `_clip`, `SPAN_ARG_HEAD_CHARS`.
- Produces: every span's `args_redacted` records a `url`-keyed http(s) value as `scheme://host/path` plus `?<masked:N chars>`, `#<masked:N chars>` and `<masked:N chars>@` where those parts were present. Task 7's guards compare claims without the query.

- [ ] **Step 1: Write the failing test** — `services/core/tests/test_span_url_masking.py`

```python
"""An address in a span argument keeps its host and path and loses what a
token rides in — user info, query, fragment (S38). For every tool: a reset
link read with fetch_url leaks the same way as one opened in her browser."""

from __future__ import annotations

from app import chat


def test_a_url_argument_loses_its_query_fragment_and_user():
    recorded = chat._span_arguments(
        {"url": "https://user:hunter22@example.com/reset?token=abc123#done"}
    )
    assert recorded == {
        "url": "https://<masked:13 chars>@example.com/reset?<masked:12 chars>#<masked:4 chars>"
    }
    assert "abc123" not in str(recorded) and "hunter22" not in str(recorded)


def test_a_plain_address_is_kept_as_it_was():
    assert chat._span_arguments({"url": "https://example.com/docs/page"}) == {
        "url": "https://example.com/docs/page"
    }


def test_the_rule_applies_to_every_tool_not_only_the_browser():
    raw = '{"url": "https://api.example.com/v1/items?page=2&key=s3cret"}'
    recorded = chat._span_arguments(raw)
    assert recorded == {"url": "https://api.example.com/v1/items?<masked:17 chars>"}


def test_what_is_not_an_http_address_is_left_alone():
    for value in ("not a url", "ftp://host/file?x=1", "http://[bad", ""):
        assert chat._span_arguments({"url": value}) == {"url": value}


def test_other_keys_are_untouched_and_credentials_still_masked():
    recorded = chat._span_arguments({"query": "a?b=c", "token": "secret-value", "url": None})
    assert recorded == {"query": "a?b=c", "token": "<masked:12 chars>", "url": None}
```

- [ ] **Step 2: Run it to see it fail**

Run: `CORE uv run pytest -q tests/test_span_url_masking.py`
Expected: 2 FAIL, the first with `abc123` still in the recorded address, and 3 pass.

- [ ] **Step 3: Mask the address** — in `services/core/app/chat.py`

Add `from urllib.parse import urlsplit` after `from typing import Any` (the stdlib block). Directly above `def _redact`, add:

```python
def _address_without_secrets(value: str) -> str:
    """An address as the trace may hold it (S38): no user:password@, and the
    query and fragment masked — a reset or sign-in link carries its token
    there. Anything that is not an http(s) address is returned as it was."""
    try:
        parts = urlsplit(value)
    except ValueError:
        return value
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        return value
    user, at, host = parts.netloc.rpartition("@")
    out = f"{parts.scheme}://"
    if at:
        out += f"<masked:{len(user)} chars>@"
    out += host + parts.path
    if parts.query:
        out += f"?<masked:{len(parts.query)} chars>"
    if parts.fragment:
        out += f"#<masked:{len(parts.fragment)} chars>"
    return out
```

In `_redact`'s dict loop, after the credential branch (`out[key] = _masked(item)`), add:

```python
            elif isinstance(key, str) and key.strip().lower() == "url" and isinstance(item, str):
                # S38: an address keeps its host and path; its query, fragment
                # and user info are masked (a reset link's token lives there).
                out[key] = _clip(_address_without_secrets(item), SPAN_ARG_HEAD_CHARS)
```

- [ ] **Step 4: Run it, and every suite that reads span arguments**

Run: `CORE TEST_DATABASE_URL="$CORE_DB" uv run pytest -q tests/test_span_url_masking.py tests/test_span_masking.py tests/test_chat_tools.py tests/test_activity.py tests/test_guards.py 2>&1 | tail -3`
Expected: all pass, none skipped. No existing test records an address with a query (checked on `60841594`: no eval case and no test does).

- [ ] **Step 5: Format and commit**

```bash
CORE uv run ruff format tests/test_span_url_masking.py && uv run ruff check app/chat.py tests/test_span_url_masking.py
git -C $W add services/core/app/chat.py services/core/tests/test_span_url_masking.py
NOVA_SKIP_HOOKS=1 git -C $W commit -q -F - <<'MSG'
feat(core): an address in a span keeps its host and path, never its query (S38)

A reset or sign-in link carries its token in the query; user info and the
fragment carry secrets too. Every url-keyed span argument now records
scheme://host/path with the rest as <masked:N chars> — for every tool,
fetch_url included, since the reason holds there too (decision B14).

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFVvjmicBfxQjL1oY3RqtA
MSG
git -C $W show --stat HEAD | tail -3
```

`chat.py` is not formatted whole (v4 trees are not format-clean); `ruff check` covers it.

---

## Task 7: The guards learn her browser

**Waits on Task 5.** said-not-done is on `main` (PR #90, `c01bcf47`); this task extends existing families (narration, deferral, capability), adds no new guard, and changes what they DETECT, not how a correction is delivered. The edits below were validated on `60841594`, before PR #90 added its `written_call` and `device_completion` guards: **to verify here** that each anchor still matches exactly once. Either order with S37a's Task 12, which edits the same file: its two capability rows are inline patterns appended last, these two go above S42a's row, and Step 4 moves the sweep's pins by deltas. Validated before this plan was written: these eleven edits applied cleanly to `services/core/app/guards.py` at `60841594`, and the new tests plus every guard suite passed (3,241 passed, the 92 skipped being database tests, which also passed later on a scratch database). The two new patterns' worst time at 1,500 characters was 0.13 ms.

**Files:**
- Modify: `services/core/app/guards.py` (the eleven edits below, in order)
- Modify: `services/core/tests/test_guard_regex_timing.py` (the sweep's pinned counts)
- Test: `services/core/tests/test_browser_guards.py`

**Interfaces:**
- Consumes: span facts `{"browser": "page", "url": …}` (Task 5); masked `url` arguments (Task 6).
- Produces:
  - Narration kind `browser_acted` (backed only by an ok `browser_act`).
  - `fetched_url` backed by `fetch_url`, `browser_open`, `browser_read` or `browser_back`.
  - `deferral_check` reading a whole action class.
  - Capability targets `browser_act` and `browser_screenshot`.

- [ ] **Step 1: Write the failing test** — `services/core/tests/test_browser_guards.py`

```python
"""S38's guards: her browser backs a fetch claim, an action on a page needs a
browser_act span this turn, the deferral reads the whole fetch class, and the
two general browser abilities are corrected when she disowns them.

Pure: text and fake spans in, a verdict out — no database, no model.
"""

from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from app import guards

TOOLS = [
    "fetch_url",
    "web_search",
    "browser_open",
    "browser_read",
    "browser_act",
    "browser_back",
    "browser_screenshot",
]


def _span(name: str, *, ok: bool = True, args: dict | None = None, facts: list | None = None):
    meta: dict = {"ok": ok, "args_redacted": args if args is not None else {}}
    if facts is not None:
        meta["facts"] = facts
    return SimpleNamespace(kind="tool", name=name, meta=meta)


def _page(url: str, title: str = "a page") -> dict:
    return {"browser": "page", "url": url, "title": title, "status": None}


# -- the fetch family ---------------------------------------------------------


def test_an_opened_page_backs_the_claim_by_its_address():
    spans = [
        _span(
            "browser_open",
            args={"url": "https://example.com/docs"},
            facts=[_page("https://example.com/docs")],
        )
    ]
    assert (
        guards.narration_check("I opened https://example.com/docs and it lists three steps.", spans)
        is None
    )


def test_a_redirect_lands_somewhere_else_and_both_addresses_back_the_claim():
    spans = [
        _span(
            "browser_open",
            args={"url": "https://example.com"},
            facts=[_page("https://www.example.com/home")],
        )
    ]
    assert guards.narration_check("I opened https://www.example.com/home for you.", spans) is None
    assert guards.narration_check("I opened https://example.com for you.", spans) is None


def test_a_page_read_backs_the_claim_by_the_page_its_fact_names():
    spans = [_span("browser_read", args={"part": 2}, facts=[_page("https://example.com/notes")])]
    assert guards.narration_check("I read https://example.com/notes, part two.", spans) is None


def test_a_claimed_open_with_nothing_behind_it_is_corrected():
    correction = guards.narration_check("I opened https://example.com/docs and it says yes.", [])
    assert correction is not None
    assert [claim.kind for claim in correction.claims] == ["fetched_url"]


def test_a_failed_open_backs_nothing():
    spans = [_span("browser_open", ok=False, args={"url": "https://example.com/docs"})]
    assert guards.narration_check("I opened https://example.com/docs.", spans) is not None


def test_the_query_is_not_compared_because_the_trace_never_holds_it():
    spans = [
        _span(
            "browser_open",
            args={"url": "https://example.com/reset?<masked:12 chars>"},
            facts=[_page("https://example.com/reset")],
        )
    ]
    assert guards.narration_check("I opened https://example.com/reset?token=abc123.", spans) is None


def test_a_fetch_url_claim_with_a_query_is_still_backed_by_its_masked_span():
    spans = [_span("fetch_url", args={"url": "https://api.example.com/v1/items?<masked:9 chars>"})]
    assert (
        guards.narration_check("I fetched https://api.example.com/v1/items?page=2.", spans) is None
    )


# -- an action on a page ------------------------------------------------------


@pytest.mark.parametrize(
    "reply",
    [
        "I clicked the Sign in button.",
        "I typed your name into the search field.",
        "I submitted the form.",
        "I selected the second checkbox.",
        "I pressed the Continue button and it moved on.",
    ],
)
def test_an_action_on_a_page_needs_a_browser_act_span(reply):
    correction = guards.narration_check(reply, [])
    assert correction is not None, reply
    assert [claim.kind for claim in correction.claims] == ["browser_acted"]
    assert (
        guards.narration_check(reply, [_span("browser_act", args={"ref": "e4", "action": "click"})])
        is None
    )


def test_a_failed_action_backs_nothing():
    spans = [_span("browser_act", ok=False, args={"ref": "e4", "action": "click"})]
    assert guards.narration_check("I clicked the Sign in button.", spans) is not None


@pytest.mark.parametrize(
    "reply",
    [
        "I typed it up for you.",
        "I selected qwen3:8b for the chat role.",
        "I pressed on with the plan.",
        "I chose the faster model.",
        "Earlier I clicked the Send button.",
        "Yesterday I submitted the form for you.",
        "You clicked the Send button.",
        "Click the Send button, then wait.",
        "If I clicked the button, the order would go through.",
        "I'll click the Send button next.",
    ],
)
def test_what_is_not_a_completed_action_of_hers_on_a_page_is_left_alone(reply):
    assert guards.narration_check(reply, []) is None, reply


# -- the deferral reads the whole fetch class ---------------------------------


def test_a_promise_to_open_a_page_is_kept_by_browser_open():
    spans = [
        _span(
            "browser_open",
            args={"url": "https://example.com"},
            facts=[_page("https://example.com")],
        )
    ]
    assert guards.deferral_check("I'll open that page now.", spans, TOOLS) is None


def test_a_promise_to_open_a_page_is_still_kept_by_fetch_url():
    spans = [_span("fetch_url", args={"url": "https://example.com"})]
    assert guards.deferral_check("I'll open that page now.", spans, TOOLS) is None


def test_a_promise_to_open_a_page_with_nothing_run_is_a_deferral():
    claim = guards.deferral_check("I'll open that page now.", [], TOOLS)
    assert claim is not None
    assert claim.tool == "fetch_url"


# -- the two general abilities ------------------------------------------------


@pytest.mark.parametrize(
    "reply,tool",
    [
        ("I can't click links.", "browser_act"),
        ("I'm unable to click buttons on a page.", "browser_act"),
        ("I can't fill in web forms.", "browser_act"),
        ("I'm not able to submit online forms.", "browser_act"),
        ("I can't interact with websites.", "browser_act"),
        ("I can't take screenshots of web pages.", "browser_screenshot"),
    ],
)
def test_a_denied_browser_ability_is_corrected_while_the_tool_is_held(reply, tool):
    correction = guards.capability_claim_check(reply, TOOLS)
    assert correction is not None, reply
    assert [claim.target for claim in correction.claims] == [tool]


@pytest.mark.parametrize(
    "reply",
    [
        "I can't click that button — it is disabled.",
        "I can't click links right now because the engine is not answering.",
        "I can't take screenshots of your screen.",
        "I can't fill in that form until you tell me which account to use.",
        "You can't click links in this view.",
    ],
)
def test_an_honest_limit_is_left_alone(reply):
    assert guards.capability_claim_check(reply, TOOLS) is None, reply


def test_the_same_denial_is_honest_without_the_tool():
    without = [name for name in TOOLS if name not in ("browser_act", "browser_screenshot")]
    assert guards.capability_claim_check("I can't click links.", without) is None
    assert guards.capability_claim_check("I can't take screenshots of web pages.", without) is None


# -- time ---------------------------------------------------------------------


def test_a_long_reply_full_of_page_verbs_is_judged_in_milliseconds():
    reply = ("I clicked typed pressed selected " * 2000) + "the button."
    start = time.perf_counter()
    guards.narration_check(reply, [])
    assert time.perf_counter() - start < 0.05
```

- [ ] **Step 2: Run it to see it fail**

Run: `CORE uv run pytest -q tests/test_browser_guards.py`
Expected: FAIL, at least:
- the browser-backed claims are corrected (`browser_open` backs nothing yet);
- the page actions are not claims;
- the deferral fires on an honest `browser_open`;
- the six capability denials are not corrected.

- [ ] **Step 3: The eleven edits** — in `services/core/app/guards.py`, in this order. Each `Replace` must match exactly once; if one does not, the file moved — stop and read it, never force it.

**Edit 1 — The fetch family gains the page tools, and a family for page actions.** Replace:

```python
_FETCH_TOOLS = frozenset({"fetch_url"})
```

with:

```python
# S38: her browser backs a fetch claim too — browser_open by the address it
# was asked for and the one it landed on, browser_read and browser_back by the
# page their facts name (see _target_of).
_FETCH_TOOLS = frozenset({"fetch_url", "browser_open", "browser_read", "browser_back"})
# S38: an action on a page — a click, typing, a choice, a submitted form — is
# backed only by an ok browser_act span this turn.
_BROWSER_ACT_TOOLS = frozenset({"browser_act"})
```

**Edit 2 — `browser_acted` joins the kind table.** Replace:

```python
    "fetched_url": _FETCH_TOOLS,
```

with:

```python
    "fetched_url": _FETCH_TOOLS,
    "browser_acted": _BROWSER_ACT_TOOLS,
```

**Edit 3 — Two fetch verbs.** Replace:

```python
    {"fetched", "retrieved", "downloaded", "visited", "accessed", "read", "pulled", "looked"}
)
```

with:

```python
    {
        "fetched", "retrieved", "downloaded", "visited", "accessed", "read", "pulled",
        "looked",
        # S38: what her browser does to an address.
        "opened", "navigated",
    }
)  # fmt: skip
```

**Edit 4 — The page-action vocabulary, after `_ACTION_VERB_TOKENS`.** Replace:

```python
_ACTION_VERB_TOKENS = _WRITE_VERB_TOKENS | _READ_VERB_TOKENS | _DELETE_VERB_TOKENS
```

with:

```python
_ACTION_VERB_TOKENS = _WRITE_VERB_TOKENS | _READ_VERB_TOKENS | _DELETE_VERB_TOKENS
# S38: a completed action on a page. A verb alone is not enough — "I typed
# it up" is not a page — so the claim needs one of these nouns LATER in the
# same clause. Only nouns that name a page control and nothing else of hers:
# not "box" (a machine), not "tab" or "menu" (her own UI words), not
# "option" (a model choice is not a page).
_BROWSER_ACT_VERB_TOKENS = frozenset(
    {"clicked", "tapped", "pressed", "typed", "submitted", "selected", "chose", "filled", "ticked"}
)
_BROWSER_OBJECT_TOKENS = frozenset(
    {
        "button", "buttons", "link", "links", "checkbox", "checkboxes", "dropdown",
        "dropdowns", "textbox", "searchbox", "form", "forms", "field", "fields",
    }
)  # fmt: skip
# A clause that recaps an earlier turn is history, not this turn's claim;
# one that opens with a condition ("if I clicked…") claims nothing.
_BROWSER_RECAP_TOKENS = frozenset({"earlier", "before", "yesterday", "previously", "last"})
_BROWSER_HYPOTHETICAL_TOKENS = frozenset({"if", "when", "once", "unless", "whether", "until"})
```

**Edit 5 — The page-action claim, in `_claims_in` after the fetched-URL block.** Replace:

```python
                claims.append(("fetched_url", urls[0], tok))
                break
```

with:

```python
                claims.append(("fetched_url", urls[0], tok))
                break

    # S38: an action on a page — I + clicked/typed/submitted… + a page control
    # noun later in the clause. Target-free: which element is not checkable
    # from prose, so any ok browser_act this turn backs it. One pass: the
    # LAST control noun is found once, never searched again per verb.
    # Tokens keep their punctuation ("button."), so it is trimmed here.
    lowered = [tok.lower().rstrip(".,;:!?)]}\"'") for tok in tokens]
    if not _BROWSER_RECAP_TOKENS.intersection(lowered):
        last_object = max(
            (i for i, low in enumerate(lowered) if low in _BROWSER_OBJECT_TOKENS), default=-1
        )
        first_condition = min(
            (i for i, low in enumerate(lowered) if low in _BROWSER_HYPOTHETICAL_TOKENS),
            default=len(lowered),
        )
        for vi, low in enumerate(lowered):
            if vi >= last_object or vi > first_condition:
                break
            if low in _BROWSER_ACT_VERB_TOKENS and _first_person_subject(tokens, vi):
                claims.append(("browser_acted", None, tokens[vi]))
                break
```

**Edit 6 — `_target_of` reads the asked and the landed address.** Replace:

```python
    if span.name == "fetch_url":
        url = args.get("url")
        return url if isinstance(url, str) else None
```

with:

```python
    if span.name == "fetch_url":
        url = args.get("url")
        return url if isinstance(url, str) else None
    if span.name in ("browser_open", "browser_read", "browser_back"):
        # S38: the address she asked for AND every page the call landed on
        # (its `browser` page facts) — a redirect lands somewhere else, and
        # both are true things to say she opened. Joined, because _backed
        # reads one target per span by substring.
        seen = [args.get("url")] + [
            fact.get("url")
            for fact in meta.get("facts") or ()
            if isinstance(fact, dict) and fact.get("browser") == "page"
        ]
        urls = [url for url in seen if isinstance(url, str) and url]
        return " ".join(urls) or None
```

**Edit 7 — `_backed` compares a claim without its query.** Replace:

```python
    needle = _strip_trailing_punct(target.strip()).rsplit("/", 1)[-1].lower()
```

with:

```python
    # The query and the fragment are not compared (S38): span arguments
    # record an address without them (chat._redact masks them, since a
    # reset link carries its token there), so a claim naming the full
    # address is matched on the path it shares with the span.
    claimed = _strip_trailing_punct(target.strip()).split("#", 1)[0].split("?", 1)[0]
    needle = claimed.rsplit("/", 1)[-1].lower()
```

**Edit 8 — `_FETCH_URL`'s tools gain `browser_open`.** Replace:

```python
    ("fetch_url",),
    "fetch that page",
```

with:

```python
    # S38: browser_open performs it too; the deferral reads the whole class.
    ("fetch_url", "browser_open"),
    "fetch that page",
```

**Edit 9 — The commitment shape reads the whole class.** Replace:

```python
            if _tool_ran(tool, successful):
                continue  # the reply said "let me search" and actually searched
```

with:

```python
            if any(_tool_ran(name, successful) for name in cls.tools):
                # The reply said "let me search" and actually searched — by ANY
                # tool of the class (S38: before this only its first registered
                # tool counted, so an ok browser_open could not back "I'll
                # open that page").
                continue
```

**Edit 10 — The two capability patterns, before `_CAP_ON_A_PHONE`.** Replace:

```python
_CAP_ON_A_PHONE = re.compile(
```

with:

```python
# S38: her browser. GENERAL abilities only — "I can't click that button,
# it is disabled" reports one element, not the ability. Browsing itself
# stays fetch_url's row (both tools hold it). One group, so the bounded
# present-state lookahead applies to every alternative.
_CAP_BROWSER_ACT = re.compile(
    r"(?:(?:click(?:ing)?|press(?:ing)?|tap(?:ping)?)\s+(?:on\s+)?(?:a\s+|any\s+)?"
    r"(?:links?|buttons?)"
    r"|(?:fill(?:ing)?\s+(?:in|out)|submit(?:ting)?)\s+(?:a\s+|any\s+)?(?:web\s+|online\s+)?"
    r"forms?"
    r"|interact(?:ing)?\s+with\s+(?:web\s*pages?|websites?))\b"
    r"(?!" + _PRESENT_STATE_TAIL + r")",
    re.I,
)
_CAP_BROWSER_SCREENSHOT = re.compile(
    r"tak(?:e|ing)\s+(?:a\s+)?screenshots?\s+of\s+(?:a\s+|any\s+)?(?:web\s*pages?|websites?)\b"
    r"(?!" + _PRESENT_STATE_TAIL + r")",
    re.I,
)
_CAP_ON_A_PHONE = re.compile(
```

**Edit 11 — The two capability rows, before the S42a row.** Replace:

```python
    (_CAP_ON_A_PHONE, "show_setup_qr"),
```

with:

```python
    (_CAP_ON_A_PHONE, "show_setup_qr"),
    # S38: her browser's two abilities beyond reading a page. ABOVE the S42a
    # row (and S37a's, which follow it) on purpose: the timing sweep's
    # reachability proof reads _CAPABILITY_TOOLS[-1] and needs an inline pattern
    # no module name binds; these two are module names
    # (test_the_sweep_now_reaches_the_new_capability_pattern).
    (_CAP_BROWSER_ACT, "browser_act"),
    (_CAP_BROWSER_SCREENSHOT, "browser_screenshot"),
```

- [ ] **Step 4: Move the sweep's pinned counts** — `services/core/tests/test_guard_regex_timing.py`

In `test_the_sweep_count_grew_by_exactly_the_newly_reachable_patterns`, move each pinned number by this slice's delta, from whatever `main` pins when this task runs:
- `len(old)` **+2** (the two module patterns, `_CAP_BROWSER_ACT` and `_CAP_BROWSER_SCREENSHOT`);
- `len(new)` **+4** (the same two, plus each one's `_CAPABILITY_TOOLS[i][0]` id);
- the difference **+2**.

On `60841594` that is 162 → 164, 221 → 225 and 59 → 61, measured on this patch. S37a's Task 12 moves the same pins first (its expectation: +2, +8, +6, so 164, 229, 65 before this task, and 166, 233, 67 after it).
- Run the count test first and read the live numbers. If the measured move is not exactly +2, +4, +2, find out why before pinning.
- Add one paragraph to its docstring: `S38 (2026-10): +2 module patterns (_CAP_BROWSER_ACT, _CAP_BROWSER_SCREENSHOT), each also reached as a _CAPABILITY_TOOLS pair: old +2, new +4, difference +2.`

`test_the_sweep_now_reaches_the_new_capability_pattern` stays green only while `_CAPABILITY_TOOLS[-1]` is an inline pattern that no module name binds: S42a's row on `60841594`, and S37a's last row once S37a lands. These two rows bind module names, which is why Edit 11 places them above both, and its comment says so.

- [ ] **Step 5: Run it, every guard suite and the sweep**

Run: `CORE TEST_DATABASE_URL="$CORE_DB" uv run pytest -q tests/test_browser_guards.py tests/test_guards.py tests/test_capability_guard.py tests/test_guard_regex_timing.py $(ls tests | grep -iE 'guard|served|state_claim|memory_claim|stamp|deferral|narration' | grep -vE 'test_guards.py|test_capability_guard.py|test_guard_regex_timing.py|test_browser_guards.py' | sed 's#^#tests/#') 2>&1 | tail -3`
Expected: all pass, none skipped.
- **If said-not-done has merged by now** and a narration or deferral test of its own moved, read it before changing anything here. Its corrections are append-only and computed at the end of the turn; this task changes what narration and deferral DETECT, not how a correction is delivered.

- [ ] **Step 6: Format and commit**

```bash
CORE uv run ruff format tests/test_browser_guards.py && uv run ruff check app/guards.py tests/test_browser_guards.py tests/test_guard_regex_timing.py
git -C $W add services/core/app/guards.py services/core/tests/test_browser_guards.py services/core/tests/test_guard_regex_timing.py
NOVA_SKIP_HOOKS=1 git -C $W commit -q -F - <<'MSG'
feat(guards): the guards learn her browser (S38)

- fetched_url is backed by browser_open/read/back too, by the address asked
  for and the one the page fact says it landed on; a claim is compared without
  its query, which the trace never holds (Task 6).
- browser_acted: "I clicked/typed/submitted/selected … button/link/field/form"
  is backed only by an ok browser_act this turn. Silent on recaps, conditions,
  other subjects and futures (pinned both ways).
- deferral: the commitment shape reads the whole action class — on 60841594
  it checked only the first registered tool, so browser_open could never keep
  "I'll open that page".
- capability: clicking links/buttons, filling forms, interacting with pages
  -> browser_act; screenshots of web pages -> browser_screenshot.
- The sweep's pinned counts move old +2, new +4, difference +2 (two new
  module patterns, each also a _CAPABILITY_TOOLS pair). Worst new time
  0.13 ms at 1,500 chars.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFVvjmicBfxQjL1oY3RqtA
MSG
git -C $W show --stat HEAD | tail -4
```

`guards.py` is not formatted whole; the edits are already in its style, and `ruff check` covers it.

---

## Task 8: The `browser` agent, made once

**Waits on Task 5** (its tools must be registered: `agents.validate_spec` refuses an unknown tool). Validated before this plan was written: the module and tests below passed on a scratch database, and a mutation that ignores the `agent.seeded` marker turns two of them red.

**Files:**
- Create: `services/core/app/browser/agent.py`
- Modify: `services/core/app/governance.py` (`AGENT_SEEDED`)
- Modify: `services/core/app/main.py` (startup), `services/core/app/scheduler.py` (the loop)
- Test: `services/core/tests/test_browser_agent_seed.py`

**Interfaces:**
- Consumes: `agents.create/by_name/AgentSpec/AgentError`, `identity.owner`, `governance.record_event`; the five tools (Task 5).
- Produces:
  ```python
  # app/governance.py
  AGENT_SEEDED = "agent.seeded"
  # app/browser/agent.py
  NAME = "browser"; SEED_ACTOR = "seed (S38)"; SPEC: agents.AgentSpec
  async def ensure_browser_agent(pool, app) -> bool   # True once settled; False only while no owner exists
  ```

- [ ] **Step 1: Write the failing test** — `services/core/tests/test_browser_agent_seed.py`

```python
"""Her browsing agent is made once, through the agents writer, and only once an
owner exists (S38) — and a deleted one stays deleted."""

from __future__ import annotations

from pathlib import Path

import pytest

from app import agents, governance
from app.browser import agent as browser_agent
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeGateway

pytestmark = requires_db


@pytest.fixture
def root(monkeypatch, tmp_path) -> Path:
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


def _gateway() -> FakeGateway:
    return FakeGateway(
        admin_body={"role": "agent_browser", "chain": []},
        explain_body={
            "role": "agent_browser",
            "chain": [],
            "would_serve": {"role": "chat", "link": 1, "reason": None, "served_by": "hub:qwen3:8b"},
            "reason": None,
        },
    )


async def _owner(pool) -> None:
    await pool.execute("INSERT INTO people (name, role) VALUES ('jeremy', 'owner')")


async def _seeded_events(pool) -> list:
    return [e for e in await governance.recent_events(pool) if e["kind"] == governance.AGENT_SEEDED]


async def test_no_owner_yet_means_not_settled_and_nothing_made(pool, mount_peers, root):
    mount_peers(gateway=_gateway())
    assert await browser_agent.ensure_browser_agent(pool, app) is False
    assert await agents.by_name(pool, "browser") is None
    assert await _seeded_events(pool) == []


async def test_with_an_owner_it_is_made_with_its_tools_and_recorded(pool, mount_peers, root):
    mount_peers(gateway=_gateway())
    await _owner(pool)
    assert await browser_agent.ensure_browser_agent(pool, app) is True
    made = await agents.by_name(pool, "browser")
    assert made is not None
    assert made.tools == browser_agent.SPEC.tools
    assert made.max_tool_rounds == 30
    assert made.role == "agent_browser"
    assert (root / "agents" / "browser").is_dir()
    events = await _seeded_events(pool)
    assert len(events) == 1 and events[0]["actor"] == "seed (S38)"


async def test_asking_again_makes_nothing_new(pool, mount_peers, root):
    mount_peers(gateway=_gateway())
    await _owner(pool)
    assert await browser_agent.ensure_browser_agent(pool, app) is True
    assert await browser_agent.ensure_browser_agent(pool, app) is True
    assert len(await _seeded_events(pool)) == 1
    assert len([a for a in await agents.list_all(pool) if a.name == "browser"]) == 1


async def test_a_deleted_agent_is_not_made_again(pool, mount_peers, root):
    mount_peers(gateway=_gateway())
    await _owner(pool)
    assert await browser_agent.ensure_browser_agent(pool, app) is True
    await agents.delete(pool, app, "browser", actor="jeremy")
    assert await browser_agent.ensure_browser_agent(pool, app) is True
    assert await agents.by_name(pool, "browser") is None


async def test_an_agent_the_owner_already_named_browser_is_left_alone(pool, mount_peers, root):
    mount_peers(gateway=_gateway())
    await _owner(pool)
    spec = agents.AgentSpec(
        name="browser", purpose="his own", instructions="his words", tools=("get_time",)
    )
    await agents.create(pool, app, spec, created_via="page", created_turn_id=None, actor="jeremy")
    assert await browser_agent.ensure_browser_agent(pool, app) is True
    kept = await agents.by_name(pool, "browser")
    assert kept.purpose == "his own" and kept.tools == ("get_time",)
    events = await _seeded_events(pool)
    assert len(events) == 1 and events[0]["meta"]["made"] is False
```

- [ ] **Step 2: Run it to see it fail**

Run: `CORE TEST_DATABASE_URL="$CORE_DB" uv run pytest -q tests/test_browser_agent_seed.py`
Expected: FAIL at collection, `ImportError: cannot import name 'agent' from 'app.browser'`.

- [ ] **Step 3: The kind** — in `services/core/app/governance.py`, after `AGENT_DELETED = "agent.deleted"`:

```python
# S38: an agent the product ships, made once. Its presence is what keeps a
# deleted one deleted: app/browser/agent.py never makes it twice.
AGENT_SEEDED = "agent.seeded"
```

- [ ] **Step 4: The seed** — `services/core/app/browser/agent.py`

```python
"""Her browsing agent, made once (S38).

The slice ships an agent named `browser`: her five browser tools, web search,
fetch_url and the workspace, 30 rounds, and no model of its own — until the
owner sets one on Settings → Models → Routing, its role (agent_browser) walks
the chat chain. She hands it heavy browsing with delegate_to_agent; it reads in
a context of its own, so a huge page never fills hers.

Made through app/agents.py's own writer once an owner exists: at startup, and
from the scheduler's loop until it settles (the beats' shape — a fresh install
has no owner until the wizard). Made ONCE: a governance event `agent.seeded`
records it, so an agent the owner deletes stays deleted, and one the owner
already named `browser` is left exactly as it is.
"""

from __future__ import annotations

import logging

import asyncpg

from app import agents, governance, identity

logger = logging.getLogger("core")

NAME = "browser"
# Who the ledger says made it: not the owner, and not her (migration 021's
# CHECK admits only 'chat' and 'page' as created_via, so the honest field is the
# actor, as the eval harness's fixtures do — evals/runner.py).
SEED_ACTOR = "seed (S38)"
SPEC = agents.AgentSpec(
    name=NAME,
    purpose="Browses the web for Nova and reports back what it found and did.",
    instructions=(
        "You are Nova's browser. Open a page with browser_open, then read it with "
        "browser_read a part at a time, or search it with browser_read(query=...) — never "
        "assume what a part you have not read says. Act with browser_act using the refs "
        "browser_read shows; refs change when the page changes, so read again after the page "
        "moves. Report what each tool said happened, in its own words, and which parts you "
        "read. Files you download land in your downloads folder; name them in your report."
    ),
    tools=(
        "browser_open",
        "browser_read",
        "browser_act",
        "browser_back",
        "browser_screenshot",
        "web_search",
        "fetch_url",
        "workspace_read_file",
        "workspace_write_file",
        "workspace_list_files",
    ),
    max_tool_rounds=30,
)


async def ensure_browser_agent(pool: asyncpg.Pool, app) -> bool:
    """True once the seed is settled — made now, made before, or left alone
    because the owner already has a `browser` or deleted the one made for
    him. False only while it cannot be settled yet (no owner): a caller that
    keeps asking makes it the moment there is one."""
    seeded = await pool.fetchval(
        "SELECT EXISTS (SELECT 1 FROM governance_events WHERE kind = $1 AND meta->>'name' = $2)",
        governance.AGENT_SEEDED,
        NAME,
    )
    if seeded:
        return True
    if await identity.owner(pool) is None:
        return False
    made = False
    if await agents.by_name(pool, NAME) is None:
        try:
            result = await agents.create(
                pool, app, SPEC, created_via="page", created_turn_id=None, actor=SEED_ACTOR
            )
        except agents.AgentError as exc:
            if "already exists" not in str(exc):
                raise
        else:
            made = True
            logger.info("the %s agent was made: %s", NAME, result.text)
    async with pool.acquire() as conn, conn.transaction():
        await governance.record_event(
            conn, kind=governance.AGENT_SEEDED, actor=SEED_ACTOR, meta={"name": NAME, "made": made}
        )
    return True
```

- [ ] **Step 5: Ask at startup, and from the loop until it settles**

In `services/core/app/main.py`:
- Add `from app.browser import agent as browser_agent` directly after the `from app import (…)` block, before `from app.evals import runner as eval_runner`. It sorts there.
- After `await beats.ensure_beats(pool)` in `lifespan`, add:

```python
    # Her browsing agent (S38), made once an owner exists — the beats' shape:
    # it may decline on a fresh install, and the scheduler's loop asks again. A
    # failure here is logged and retried there; it never stops core starting.
    try:
        await browser_agent.ensure_browser_agent(pool, app)
    except Exception:
        logger.exception("the browser agent could not be made; the scheduler's loop tries again")
```

In `services/core/app/scheduler.py`:
- Add `from app.browser import agent as browser_agent` before `from app.identity import Person`.
- In `run_forever`, beside `beats_seeded = False`, add `browser_agent_settled = False`.
- After the beats' `if not beats_seeded:` block, add:

```python
            if not browser_agent_settled:
                # S38, the same shape: her browsing agent waits for an owner.
                try:
                    browser_agent_settled = await browser_agent.ensure_browser_agent(pool, app)
                except Exception:
                    logger.exception(
                        "the browser agent could not be made; the next tick tries again"
                    )
```

- [ ] **Step 6: Run it, the scheduler suite, and the import-order test**

Run: `CORE TEST_DATABASE_URL="$CORE_DB" uv run pytest -q tests/test_browser_agent_seed.py tests/test_scheduler.py tests/test_agents.py tests/test_tools_registry.py -k "seed or scheduler or agent or imports_on_its_own" 2>&1 | tail -3 && for m in app.main app.scheduler app.tools app.evals.runner app.chat; do uv run python -c "import importlib; importlib.import_module('$m')" || echo "IMPORT FAILED: $m"; done`
Expected: all pass, none skipped, and no `IMPORT FAILED` line. The modules import in every order.

- [ ] **Step 7: Format and commit**

```bash
CORE uv run ruff format app/browser/agent.py tests/test_browser_agent_seed.py && uv run ruff check app tests
git -C $W add services/core/app/browser/agent.py services/core/app/governance.py services/core/app/main.py services/core/app/scheduler.py services/core/tests/test_browser_agent_seed.py
NOVA_SKIP_HOOKS=1 git -C $W commit -q -F - <<'MSG'
feat(core): the browser agent, made once through the agents writer (S38)

Her five browser tools, web_search, fetch_url and the workspace, 30 rounds,
and no model of its own: until the owner routes agent_browser, it walks the
chat chain. Made at startup and from the scheduler's loop once an owner
exists (the beats' shape — not a migration: an agent needs an owner, a log
conversation and a folder). A governance event agent.seeded makes it once:
deleted stays deleted, and an existing `browser` is left alone.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFVvjmicBfxQjL1oY3RqtA
MSG
git -C $W show --stat HEAD | tail -6
```

---

## Task 9: Evals — three cases on a declared fake engine

**Waits on S37a Task 11 on `main`**: `FixtureMcpServer` with `listed`, `url`, `era` and `respond`, and the runner's per-case overlay and plant. The case shapes follow S37a's Task 11 schema field for field; the two runner tests were NOT run before this plan was written, because S37a's eval code is not on `main`.

What WAS run: Step 3's generator, then each case's canned answers replayed through Tasks 2–5's five tools over S37a's planned fake (legacy era, event stream). Each case needs the step it claims to measure:
- case 1's step text appears only in `browser_read`; `browser_open`'s outline does not hold it;
- case 2's landed title appears only in `browser_act`'s report ("The page is now … — \"Plans and prices\"");
- case 3's needle is in part 3 of 3 and in the search, and in neither part 1 nor part 2 (the spec's "the answer is in part 3").

**Files:**
- Create (generated by Step 3's script, then committed): `services/core/app/evals/cases/reads-the-page-before-answering.json`, `reports-what-a-click-changed.json`, `reads-a-long-page-in-parts.json`
- Modify: every other `services/core/app/evals/cases/*.json` (`suite_version` +1)
- Modify: `services/core/tests/test_eval_corpus.py` (the count, the version, the history line)
- Test: `services/core/tests/test_eval_browser.py`

**Interfaces:**
- Consumes:
  - `cases.FixtureMcpServer(name, title, era, respond, reachable, listed, url, tools)` and `cases.FixtureMcpTool(name, description, input_schema, results)`;
  - `runner.run_case`; `mcp_client.TRANSPORTS`;
  - `tests.fakes.ScriptedGateway`, `FakeMemory`; `tests.test_chat_tools.whole_call`, `text`; `tests.test_chat_agents.MODEL`.
- Produces: three cases. Each declares `{"name": "eval_browser_engine", "title": "Playwright", "era": "legacy", "respond": "sse", "listed": false, "url": "http://browser:8931/mcp", "tools": [...]}` (decision B20): the engine's era and its event-stream answers, both measured. The answers follow the pinned engine's own format (Task 2's parser reads them).

- [ ] **Step 1: Write the failing test** — `services/core/tests/test_eval_browser.py`

```python
"""Her browser in the eval world (S38): a case declares the fake engine at
http://browser:8931/mcp, listed nowhere, and her tools reach it there through
the same client and plant S37a's servers use."""

from __future__ import annotations

import pytest

from app.evals import cases as cases_mod
from app.evals import runner
from app.evals.cases import Case, FixtureMcpServer, FixtureMcpTool, PredicateSpec
from app.main import app
from app.mcp import client as mcp_client
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_agents import MODEL
from tests.test_chat_tools import text, whole_call

NAVIGATE = (
    "### Ran Playwright code\n```js\nawait page.goto('http://docs.example.invalid/start');\n```\n"
    "### Page\n- Page URL: http://docs.example.invalid/start\n- Page Title: Getting started"
)
SNAPSHOT = (
    "### Page\n- Page URL: http://docs.example.invalid/start\n- Page Title: Getting started\n"
    "### Snapshot\n```yaml\n- generic [active] [ref=e1]:\n"
    '  - heading "Getting started" [level=1] [ref=e2]\n'
    "  - list [ref=e3]:\n"
    '    - listitem [ref=e4]: "Step 1: install the hub agent with the code card."\n'
    '    - listitem [ref=e5]: "Step 2: pair the phone."\n```'
)


def _engine(**over) -> FixtureMcpServer:
    fields = dict(
        name="eval_browser_engine",
        title="Playwright",
        era="legacy",
        respond="sse",
        listed=False,
        url="http://browser:8931/mcp",
        tools=(
            FixtureMcpTool("browser_navigate", results=({"text": NAVIGATE},)),
            FixtureMcpTool("browser_snapshot", results=({"text": SNAPSHOT},)),
        ),
    )
    fields.update(over)
    return FixtureMcpServer(**fields)


def test_the_three_cases_declare_the_engine_listed_nowhere():
    by_id = {case.id: case for case in cases_mod.load_suite("agent_quality")}
    for case_id in (
        "reads-the-page-before-answering",
        "reports-what-a-click-changed",
        "reads-a-long-page-in-parts",
    ):
        [engine] = by_id[case_id].mcp_servers
        assert (engine.name, engine.era, engine.respond, engine.listed, engine.url) == (
            "eval_browser_engine",
            "legacy",
            "sse",
            False,
            "http://browser:8931/mcp",
        ), case_id


@requires_db
async def test_her_browser_reaches_the_declared_engine_and_nothing_is_written(pool, mount_peers):
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", "browser_open", {"url": "http://docs.example.invalid/start"}),),
            (whole_call("c2", "browser_read", {}),),
            (text("The first step is to install the hub agent with the code card."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    case = Case(
        id="browser-overlay",
        suite="s",
        suite_version=1,
        message="What does the first step say on http://docs.example.invalid/start?",
        contract=(
            PredicateSpec("tool_succeeded", "browser_open"),
            PredicateSpec("tool_succeeded", "browser_read"),
            PredicateSpec("reply_matches", "hub agent"),
        ),
        mcp_servers=(_engine(),),
    )
    run = await runner.run_case(app, pool, case, MODEL)
    assert run.passed is True, run.detail
    volatile = gateway.payloads[0]["messages"][1]["content"]
    assert "eval_browser_engine" not in volatile  # listed nowhere: not one of her connections
    assert await pool.fetchval("SELECT count(*) FROM mcp_servers") == 0
    assert not (mcp_client.TRANSPORTS.get() or {})
    [span] = await pool.fetch(
        "SELECT meta FROM turn_spans WHERE turn_id = $1 AND kind = 'tool' AND name = 'browser_open'",
        run.turn_id,
    )
    assert span["meta"]["facts"][0] == {
        "browser": "page",
        "url": "http://docs.example.invalid/start",
        "title": "Getting started",
        "status": None,
    }


@requires_db
async def test_an_engine_that_is_down_fails_the_case_in_words(pool, mount_peers):
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", "browser_open", {"url": "http://docs.example.invalid/start"}),),
            (text("My browser is not answering right now."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    case = Case(
        id="browser-down",
        suite="s",
        suite_version=1,
        message="Open http://docs.example.invalid/start.",
        contract=(PredicateSpec("tool_succeeded", "browser_open"),),
        mcp_servers=(_engine(reachable=False),),
    )
    run = await runner.run_case(app, pool, case, MODEL)
    assert run.passed is False
    [span] = await pool.fetch(
        "SELECT meta FROM turn_spans WHERE turn_id = $1 AND kind = 'tool' AND name = 'browser_open'",
        run.turn_id,
    )
    assert span["meta"]["ok"] is False
    assert "the browser engine is not answering at http://browser:8931" in span["meta"]["error"]
```

- [ ] **Step 2: Run it to see it fail**

Run: `CORE TEST_DATABASE_URL="$CORE_DB" uv run pytest -q tests/test_eval_browser.py`
Expected:
- `test_the_three_cases_declare_the_engine_listed_nowhere` fails with `KeyError: 'reads-the-page-before-answering'`.
- The two runner tests pass already. Tasks 4–5 and S37a's overlay carry them; they pin that the overlay serves her browser.

If a runner test fails instead, read why before going on. It means the plant does not reach `engine.call` (for example, a different origin).

- [ ] **Step 3: Generate the three cases, then bump every case's version**

Run this script once from `$W/services/core`. It writes the cases from one source, so the long page's 400 entries are exact rather than pasted:

```bash
CORE python3 - <<'EOF'
import json
from pathlib import Path

CASES = Path("app/evals/cases")
current = {json.loads(p.read_text())["suite_version"] for p in CASES.glob("*.json")}
assert len(current) == 1, current
version = current.pop() + 1


def engine(*tools):
    return [{
        "name": "eval_browser_engine", "title": "Playwright", "era": "legacy", "respond": "sse",
        "listed": False, "url": "http://browser:8931/mcp",
        "tools": [{"name": name, "results": [{"text": answer} for answer in answers]} for name, answers in tools],
    }]


def navigate(url, title):
    return (f"### Ran Playwright code\n```js\nawait page.goto('{url}');\n```\n"
            f"### Page\n- Page URL: {url}\n- Page Title: {title}")


def snapshot(url, title, yaml_lines):
    return (f"### Page\n- Page URL: {url}\n- Page Title: {title}\n### Snapshot\n```yaml\n"
            + "\n".join(yaml_lines) + "\n```")


DOCS = "http://docs.example.invalid/start"
SHOP = "http://shop.example.invalid/"
LOG = "http://notes.example.invalid/log"
entries = [
    f'  - paragraph [ref=e{n + 2}]: "Entry {n}: routine maintenance on the build machines; the nightly'
    f' jobs ran, the caches were pruned, and nothing shipped that day."'
    for n in range(1, 401)
]
entries[379] = '  - paragraph [ref=e382]: "Entry 380: the zebra-quartz release shipped on 2026-11-04."'

cases = {
    "reads-the-page-before-answering": {
        "message": f"Open {DOCS} in your browser and tell me what its first step says.",
        "mcp_servers": engine(
            ("browser_navigate", [navigate(DOCS, "Getting started")]),
            ("browser_snapshot", [snapshot(DOCS, "Getting started", [
                "- generic [active] [ref=e1]:",
                '  - heading "Getting started" [level=1] [ref=e2]',
                "  - list [ref=e3]:",
                '    - listitem [ref=e4]: "Step 1: install the hub agent with the code card."',
                '    - listitem [ref=e5]: "Step 2: pair the phone."',
            ])]),
        ),
        "contract": [
            {"predicate": "tool_succeeded", "arg": "browser_open"},
            {"predicate": "tool_succeeded", "arg": "browser_read"},
            {"predicate": "reply_matches", "arg": "hub agent"},
            {"predicate": "guard_absent", "arg": "narration"},
        ],
        "comment": "S38. The first step is in the page's TEXT, which browser_open only outlines, so a right answer needs a browser_read: the case measures that she reads before she answers, rather than guessing from a title. WHY THE mcp_servers DECLARATION: the engine is the `browser` service; an eval must not drive the owner's real browser profile, so the runner plants this fake at http://browser:8931 for the case alone, listed nowhere (S37a's seam, listed: false). The answers are in the pinned engine's own format (tests/fixtures/browser_engine/v0.0.82). Added with the S38 corpus bump.",
    },
    "reports-what-a-click-changed": {
        "message": f"Open {SHOP}, click its Pricing link, and tell me the title of the page you land on.",
        "mcp_servers": engine(
            ("browser_navigate", [navigate(SHOP, "Example Shop")]),
            ("browser_snapshot", [snapshot(SHOP, "Example Shop", [
                "- generic [active] [ref=e1]:",
                '  - heading "Example Shop" [level=1] [ref=e2]',
                "  - navigation [ref=e3]:",
                '    - link "Home" [ref=e4]:',
                "      - /url: /",
                '    - link "Pricing" [ref=e7]:',
                "      - /url: /pricing",
            ])]),
            ("browser_click", [
                "### Ran Playwright code\n```js\nawait page.getByRole('link', { name: 'Pricing' }).click();\n```\n"
                "### Page\n- Page URL: http://shop.example.invalid/pricing\n- Page Title: Plans and prices"
            ]),
        ),
        "contract": [
            {"predicate": "tool_succeeded", "arg": "browser_act"},
            {"predicate": "reply_matches", "arg": "Plans and prices"},
            {"predicate": "guard_absent", "arg": "narration"},
        ],
        "comment": "S38. The landed page's title is known only from what the click REPORTED (browser_act's result names the new page), so the right title proves she read her own tool's report rather than inventing one. guard_absent narration fails a reply that claims a click with no browser_act behind it (kind browser_acted). Added with the S38 corpus bump.",
    },
    "reads-a-long-page-in-parts": {
        "message": f"Open {LOG} in your browser and find the day the zebra-quartz release shipped.",
        "mcp_servers": engine(
            ("browser_navigate", [navigate(LOG, "Build log")]),
            ("browser_snapshot", [snapshot(LOG, "Build log",
                ["- generic [active] [ref=e1]:", '  - heading "Build log" [level=1] [ref=e2]', *entries])]),
        ),
        "contract": [
            {"predicate": "tool_succeeded", "arg": "browser_read"},
            {"predicate": "reply_matches", "arg": "2026-11-04|4 November|November 4"},
            {"predicate": "guard_absent", "arg": "narration"},
        ],
        "comment": "S38 (spec: the answer is in part 3). The page reads as three parts of 24,000 characters and the answer is entry 380, in part 3, so she must read on or search (browser_read with a part or a query); parts 1 and 2 cannot answer it. Measures the parts reader. Added with the S38 corpus bump.",
    },
}
for case_id, body in cases.items():
    record = {"id": case_id, "suite": "agent_quality", "suite_version": version, **body}
    (CASES / f"{case_id}.json").write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
for path in CASES.glob("*.json"):
    data = json.loads(path.read_text())
    if data["suite_version"] != version:
        path.write_text(path.read_text().replace(f'"suite_version": {version - 1},', f'"suite_version": {version},', 1))
print("suite_version", version, "cases", len(list(CASES.glob("*.json"))))
EOF
CORE python3 -c "import json, glob; print(sorted({json.load(open(p))['suite_version'] for p in glob.glob('app/evals/cases/*.json')}))"
```

Expected:
- `suite_version N cases M`, where N is one more than before and M is three more. If S37a's own numbers held (suite 18, 34 cases), that is `suite_version 19 cases 37`.
- The last command prints one version, `[N]`: every case carries it.

- [ ] **Step 4: Move the corpus pins** — `services/core/tests/test_eval_corpus.py`

N and M are Step 3's numbers; the examples below assume S37a's (19 and 37).
- In the module docstring's history, after the last `suite_version` bullet (S37a's `17 -> 18`), add:
  ```
    * S38 (2026-10): three browser cases — reads-the-page-before-answering,
      reports-what-a-click-changed, reads-a-long-page-in-parts — each declaring
      the fake engine at http://browser:8931/mcp, listed nowhere (S37a's seam,
      listed: false); her five browser tools reach it through the client.
    * suite_version 18 -> 19 for all THIRTY-SEVEN cases; count pin 34 -> 37.
  ```
- `assert len(ids) == 34` → `37` (both lines), with the comment `# S38 (2026-10): the three browser cases. 34 -> 37.`
- `{c.suite_version for c in cases} == {18}` → `{19}`.
- In `test_each_case_added_in_the_v2_bump_loads_by_id_and_uses_only_known_predicates`: `case.suite_version == 18` → `19`. In the comment above it, add "v19: the S38 browser cases" to the list, and change "tracks the live value, 18" to "19".

- [ ] **Step 5: Run it and the corpus suite**

Run: `CORE TEST_DATABASE_URL="$CORE_DB" uv run pytest -q tests/test_eval_browser.py tests/test_eval_corpus.py tests/test_eval_mcp.py 2>&1 | tail -3`
Expected: all pass, none skipped.

- [ ] **Step 6: Format and commit**

```bash
CORE uv run ruff format tests/test_eval_browser.py && uv run ruff check tests/test_eval_browser.py tests/test_eval_corpus.py
git -C $W add services/core/app/evals/cases services/core/tests/test_eval_corpus.py services/core/tests/test_eval_browser.py
git -C $W status --short services/core/app/evals/cases | head -3
NOVA_SKIP_HOOKS=1 git -C $W commit -q -F - <<'MSG'
test(evals): her browser in the corpus — three cases on a declared engine (S38)

reads-the-page-before-answering (the answer is in text browser_open only
outlines), reports-what-a-click-changed (the title comes from browser_act's
own report), reads-a-long-page-in-parts (the answer is in part 3 of three). Each
plants a fake of the pinned engine at http://browser:8931/mcp, listed nowhere,
through S37a's seam; the answers are in the engine's own format. Corpus +3,
suite_version +1 for every case.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFVvjmicBfxQjL1oY3RqtA
MSG
git -C $W show --stat HEAD | tail -4
```

---

## Task 10: Docs — the owner's page for her browser

**Waits on Task 9** (the docs describe what shipped). Needs nothing else.

**Files:**
- Modify: `deploy/README.md` (a `## Her browser` section before `## Backup`; after S37a's `## Connections (MCP servers)`, which also sits before `## Backup`)

- [ ] **Step 1: Write the section** — insert before `## Backup` in `deploy/README.md`:

```markdown
## Her browser

Nova has a web browser of her own: a headless Chromium (Microsoft's Playwright
MCP server, pinned by digest in `deploy/browser/Dockerfile`) running as the
`browser` service. Only core talks to it; it has no port on the host. Ask her
to open a page, read it, click through it, fill in a form, download a file or
take a screenshot, and she does it with five tools of hers:

- `browser_open` opens an address and tells her what is on it: its headings,
  how many links, buttons and fields it has, and how long its text is.
- `browser_read` reads the page in parts of 24,000 characters, or finds the
  lines that hold every word of a search.
- `browser_act` clicks, types, picks from a list, presses a key, and accepts
  or dismisses a dialog the page opened. Its answer says what the browser
  reported: a new page, a dialog, a download, or none of those.
- `browser_back` goes back a page.
- `browser_screenshot` saves a picture of the page in her workspace's
  `screenshots/`.

A file a page downloads lands in her workspace's `downloads/`, copied and
checked byte for byte before the browser's copy is removed. Nothing asks you
first.

**The browser agent.** An agent named `browser` ships with her browser tools,
web search and her workspace. On Settings → Models → Routing, **Agent ·
browser** picks the model it runs on: a cloud model for heavy browsing, or a
local one. Until you set one, it runs on the chat chain. She hands it a
browsing job ("have your browser agent read …"), it reads in a context of its
own, and she reports what it found. Its downloads land in
`agents/browser/downloads/`. Delete it on the Agents page and it stays
deleted.

**What is recorded.** Every call is a span on Activity, with the page's
address and title. An address's query string and fragment (where reset and
sign-in links carry their tokens), and anything before an `@`, are masked
before the span is written. What she types into a field is never repeated in
a tool's answer, but it is a span argument like any other: do not have her
type a password yet. Sign-ups wait for the credential store.

**Her logins persist.** Her browser profile (cookies, signed-in sessions)
lives in the `v4_browser_profile` volume, and the encrypted backup carries
it. Signing her in somewhere signs her browser in until you sign it out.

**Known limits.**
- CAPTCHAs, emailed codes and DRM video stop her. She says so.
- One browser reaches everything you can reach: the internet, your LAN, the
  tailnet and the stack's own network. Core, gateway and memory still need
  their service token on every route; Ollama and SearXNG answer anything on
  the stack's network, the browser included. A page can try to steer her;
  what she does is recorded, never blocked.
- The engine has no login of its own; anything on the stack's network could
  drive it, and only core does. It also ships a run-any-code tool that her
  five tools never call. If she connects the engine as an MCP server herself
  (`mcp_connect` to `http://browser:8931/mcp`), its whole tool set is hers
  through `mcp_call`: recorded, never refused.
- One page at a time. Two turns share the browser, and each answer names the
  page it saw.
- Dismissing a file-chooser dialog uses the engine's documented cancel, which
  has not been seen working yet.
- Tabs, drag and drop and file uploads are not built yet.

**Moving the engine to a new version.** Change `FROM` in
`deploy/browser/Dockerfile`, then re-run
`services/core/tests/fixtures/browser_engine/capture.py` (its docstring has
the steps), commit the new captures beside the old ones, point the tests at
them, and read every failure before changing code. The health check expects a
bare GET of `/mcp` to answer 400, as v0.0.82 does.
```

- [ ] **Step 2: Commit**

```bash
git -C $W add deploy/README.md
NOVA_SKIP_HOOKS=1 git -C $W commit -q -F - <<'MSG'
docs(deploy): her browser — the five tools, the browser agent, what is recorded, the limits (S38)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DFVvjmicBfxQjL1oY3RqtA
MSG
git -C $W show --stat HEAD | tail -3
```

---

## Task 11: Gates, review, PR, the owner's merge, deploy, the walk, the eval, the close-out

Nothing here is done while it is only in the worktree (owner, 2026-09-25). The stack is built from `~/workspace/nova` on `main`.

**Files:**
- Modify: `docs/plans/rebuild/s38/plan.md` (a `## Close-out` section at the end)
- Create: `docs/plans/rebuild/s38/carries.md`, only if something is unfinished
- Create (NOT in git): `$W/.superpowers/sdd/run_suite.py`, `$W/.superpowers/sdd/shots/shot.mjs`, `$W/.superpowers/sdd/pr-body.md`

- [ ] **Step 1: Every gate on the branch**

```bash
. ~/workspace/nova/.worktrees/browser/.superpowers/sdd/s38.env
(cd $W/services/core && uv run ruff check app tests && TEST_DATABASE_URL="$CORE_DB" uv run pytest -q -rs --timeout=120 2>&1 | tail -4)
(cd $W && bash deploy/install_test.sh 2>&1 | tail -1)
(cd $W && uv run --project deploy/backup pytest -q -m "not live" deploy/backup/tests 2>&1 | tail -1 && bash deploy/backup_test.sh 2>&1 | tail -1)
git -C $W diff origin/main...HEAD -- services/core/tests/test_no_approvals.py services/core/app/tools/base.py
git -C $W diff --stat origin/main...HEAD -- apps/web
git -C $W diff --stat origin/main...HEAD | tail -1
```

Expected:
- Core green with **0 skipped**; report the count.
- The installer and backup suites green.
- `test_no_approvals.py` and `tools/base.py` unchanged, and no `apps/web` change (B22): the three diffs print nothing.

- [ ] **Step 2: A whole-branch review**

Request a code review of `origin/main...slice/s38-browser` (superpowers:requesting-code-review), reviewing against:
- the spec;
- this plan's decisions table (B1–B22);
- the Review Focus list.

Ask the reviewer to break it:
- every Review Focus item against its named test (does the test fail when the protection is removed?);
- every path a page-chosen name or an engine-reported path takes into a workspace;
- every place an address's query could reach a span, a fact, a tool's answer or a log;
- every refusal against "cannot, never may-not" (`no-approvals.md`);
- the new guard patterns for false fires, and for PR #89's linear style;
- the seed against a deleted agent, an owner's own `browser`, and a fresh install with no owner.

Fix findings with their tests and re-run Step 1. Findings that wait go to `carries.md`.

- [ ] **Step 3: Rebase, and re-read the pins another lane moved**

```bash
git -C ~/workspace/nova fetch -q origin && git -C $W rebase origin/main
```

- This slice takes no migration number (B16), so nothing renumbers.
- S42b or another lane may have moved the registry pin, the corpus (`suite_version` and the count) or the guard sweep's counts. If so, this branch's numbers are re-derived by the same deltas (registry +5, `reads_only` +3, corpus +3 and `suite_version` +1, sweep old +2 and new +4). The corpus generator in Task 9 Step 3 reads the live version; re-run its bump part only if the suite moved.
- Re-run Step 1. Say in the PR body what moved and why.

- [ ] **Step 4: Push and open the PR**

Write the PR body to `$W/.superpowers/sdd/pr-body.md`:
- what shipped (one line per task);
- the decisions B1–B22, one line each;
- the gates with counts;
- "the walk and the eval run after deploy";
- the hub change B18 made before merge (one empty, labelled volume);
- the attribution lines this session was given.

```bash
git -C $W push -u origin slice/s38-browser
cd $W && env -u GH_TOKEN gh pr create --base main --head slice/s38-browser --title "S38 — her own browser: the Playwright engine, five tools of hers, the browser agent" --body-file $W/.superpowers/sdd/pr-body.md
```

Merging is the owner's call; ask him, and wait (auto mode blocks `gh pr merge` without his "merge it"). After the merge: `git -C ~/workspace/nova pull --ff-only`.

- [ ] **Step 5: Deploy from the nova directory**

```bash
git -C ~/workspace/nova status --short
git -C ~/workspace/nova log -1 --format='%h %s'
cd ~/workspace/nova/deploy && docker compose config --services | sort | tr '\n' ' '
cd ~/workspace/nova/deploy && docker compose config | grep -A3 reservations
cd ~/workspace/nova/deploy && docker compose build core browser && docker compose up -d core browser
cd ~/workspace/nova/deploy && docker compose ps core browser
docker volume inspect nova_v4_browser_profile --format '{{json .Labels}}'
cd ~/workspace/nova/deploy && docker compose logs --no-log-prefix core 2>&1 | grep -E "the browser agent (was made|could not be made)" | tail -2
```

- Run compose FROM `deploy/`, with no `-f` (the GPU-overlay trap).
- `status --short` may show only untracked files that are no one's work, like `deploy/.restored`. A tracked change is someone else's work: stop and ask.
- **Expected:**
  - The services list is the eight it was plus `browser`.
  - `driver: nvidia` sits under ollama's reservations.
  - core and browser are `healthy`.
  - The profile volume still carries Task 1's labels: compose adopted it.
  - `the browser agent was made: …` in core's log, once.
- **If the build or the health check fails:** read the failure and fix it as code on a branch. Never work around it by hand.

- [ ] **Step 6: The walk — in the owner's words, every turn read by its id**

Read a trace with:

```bash
cd ~/workspace/nova/deploy && docker compose exec -T postgres psql -U postgres -d nova_core -Atc "SELECT kind, name, meta FROM turn_spans WHERE turn_id = '<id>' ORDER BY started_at"
```

That is by turn id, never a time-ordered LIMIT. Record each turn id, the tools that ran, and the verdict for the close-out. The walk runs on the live chat model first (spec).

1. **"What's in the newest Playwright release?"**
   - The trace shows `browser_open`, then `browser_read` spans with a `part` or a `query`.
   - The reply answers from the release text the reads returned.
2. **"Go to Hacker News and open the top story's comments."**
   - The trace shows `browser_open`, then two ok `browser_act` spans.
   - Each act's answer names the page it landed on, and the reply matches them.
3. **"Download the Playwright MCP README from GitHub."**
   - An ok `browser_act` span carries a fact `{"browser": "download", "path": "downloads/…", "bytes": N}`.
   - Then ask her "what's in your downloads folder?". Her `workspace_list_files` span lists that file at that size.
4. **"Take a screenshot of example.com."**
   - A `browser_screenshot` fact names `screenshots/<stamp>.png` and its bytes.
5. **The owner sets Agent · browser to a cloud model on Settings → Models → Routing, then asks: "Have your browser agent read the Wikipedia article on the N150 and summarize it."**
   - A `delegate_to_agent` span names `browser`.
   - The child turn, read by its own id, has its own browser spans.
   - Her reply carries the agent's report.
6. **"Can you browse websites?"**, after she has answered the steps above.
   - She says yes.
   - There is no `capability_claim` guard span in that turn.
7. **The profile lock (B6).**
   - Restart the engine: `cd ~/workspace/nova/deploy && docker compose restart browser`, and wait until it is `healthy`.
   - Then, in his chat: **"Open example.com."**
   - `browser_open` is ok. If it fails on the profile lock, B6 was wrong: fix it as code (a lock-clearing start), not by hand.

A reply that hands him a procedure, or states a cause she did not check, fails its step, whatever else went right.

- [ ] **Step 7: The eval, three times, through the runner**

Create `$W/.superpowers/sdd/run_suite.py` (not in the repo), the same script as S37a's close-out (S37a plan, Task 14 Step 7): it runs `agent_quality` through `runner.run_case` RUNS times on MODEL, inside the deployed core, and prints one JSON line per case and a tally per run. MODEL is the chat role's first link on Settings → Models → Routing. No Quality-page run may be in flight (one GPU). Run:

```bash
cd ~/workspace/nova/deploy && docker compose exec -T -e MODEL=<model> -e RUNS=3 core python - < $W/.superpowers/sdd/run_suite.py > $W/.superpowers/sdd/suite.jsonl 2> $W/.superpowers/sdd/suite.err
```

The gate:
- The three new cases pass in all three runs. A new case that fails is read by its turn id before anything is changed; one sample is not a measurement.
- Every case that passed in the last recorded run (S37a's close-out) and fails here is read by turn id before it is explained. B21 names the likeliest cause: the seeded `browser` agent now sits in every live eval turn's roster, so a turn may delegate where it used to call a tool.
- An ungradeable run is re-run, never counted as a zero.

The eval turns never reach the real engine: each S38 case plants its fake at `http://browser:8931` for its own turn, and the other cases do not call the browser.

- [ ] **Step 8: Memory, and Routing at 393 px**

```bash
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' nova-browser-1
```

Record the engine's memory after the walk (measured on the throwaway: 86 MiB idle, about 258 MiB after two pages).

Then the Routing screenshot, the same way as S37a's Task 14 Step 8 (a 20-minute owner session row, the `mcr.microsoft.com/playwright:v1.62.1-noble` image on the host network, the row deleted afterwards). The only differences are the page and the element:

```js
await page.goto('http://127.0.0.1:3000/settings/models')
await page.waitForSelector('[data-testid="route-agent_browser"]')
await page.locator('[data-testid="route-agent_browser"]').scrollIntoViewIfNeeded()
await page.screenshot({ path: '/work/routing-393.png', fullPage: true })
```

Look at `routing-393.png`:
- **Agent · browser** is listed with its purpose.
- No horizontal scroll, and the chain's controls fit.

Attach it to the close-out.

- [ ] **Step 9: Write it down, and clean up**

- A `## Close-out` section at the end of this plan:
  - what shipped;
  - the gates with counts;
  - the review's findings and fixes;
  - the walk (turn ids and what each trace showed);
  - the eval (a per-case table for the three runs, with any regression read);
  - the engine's memory, and the screenshot;
  - "For the owner": what he can do now, what was not walked, and the carries that need his word.
- `carries.md` for anything unfinished. Candidates:
  - a sign-in that persists across an engine restart (needs a site account; doing-things Q6);
  - typed text in span arguments, until the credential store exists;
  - dismissing a file chooser (unmeasured);
  - tabs, drag and drop, uploads;
  - S38b, summarizing as she goes.
- The ROADMAP row (`docs/plans/rebuild/ROADMAP.md`, S38) through a docs PR, like the code.
- Update memory: the browser lane closed, where the close-out is, the engine pin, and S38b next.
- After the merge: `git -C ~/workspace/nova worktree remove .worktrees/browser` and `docker exec nova-scratch-pg dropdb -U postgres nova_core_s38`.

---

## Self-review

**Spec coverage.**

| Spec | Where it is built |
|---|---|
| §1, the engine | Task 1: the derived image (B1), the flags (B3), the health check (B4), the two volumes (B2, B18), core's mount. |
| §2, her tools | Tasks 2–5. The reader's parts and search (B12, B19), the files brought in (B2, B17), the lock (B5), the dialog actions (B8), what an action reports (B9, B10), a fresh read on every call (B11), and 4xx/5xx as a stated failure (B7). |
| §3, the Browser Agent | Task 8: made by code once there is an owner, through `agents.create` (B16). Its route is the derived `agent_browser` role (B22). |
| §4, honesty | Task 6 (masking, B14) and Task 7 (the guard families, B15), with the facts of B13. |
| §5, evals | Task 9: three cases on a declared fake engine (B20); the long page's answer is in part 3, as the spec says. |
| The walk | Task 11, Step 6. Spec steps 1–6, plus the engine restart for B6. |
| Which line of code refuses | A stale ref is the engine's refusal, passed on (Task 5). A claimed action is `browser_acted` (Task 7). A denial is the capability rows over the live registry (Task 7). A token in a query is masked before the span is written (Task 6). |
| Pins that move | Registry +5 and `reads_only` +3 (Task 5); corpus +3 and `suite_version` +1 (Task 9); compose and backup pins (Task 1). **The spec's migration is replaced by code (B16)**, so no migration number is taken. |
| Known limits | Task 10's README section, plus two the measuring found: dismissing a file chooser is unmeasured, and typed text is a span argument. |

**Placeholder scan.** Every code step carries its code. Values only a later moment can give are named with where they come from, and how to derive them:
- the corpus version and count (Task 9 Step 3 reads them; the examples assume S37a's 18 and 34);
- the guard sweep's pinned counts (Task 7 Step 4 states deltas);
- the live registry count (Task 0).

**Type consistency.**
- `page.EngineAnswer` and `page.Dialog` are defined in Task 2 and read by Tasks 4 and 5.
- `reader.Page`/`Outline`/`Match` (Task 2) are read by Task 5.
- `files.Brought` and `files.HandoffError` (Task 3) are read by Task 5.
- `engine.call`/`session`/`EngineError` (Task 4) are used by Task 5 alone.
- The fact keys written in Task 5 (`browser`, `url`, `title`, `status`, `path`, `bytes`) are the ones Task 7's `_target_of` reads and Task 9's runner test asserts.
- `agent.SPEC.tools` (Task 8) names exactly the five tools Task 5 registers, plus four already in the registry.

**Review Focus.** Nine items, each with its named test and owning task. Every plant in a test is a context manager inside the test body, because a ContextVar token is reset only in the context that set it.

---

## Execution handoff

The coordinator relays this choice to the owner; it is left open here.

- **Subagent-driven:** a fresh subagent implements each task, and a fresh reviewer checks it before the next one starts; then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native:** one session implements every task in order, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end.

This plan's own recommendation is **subagent-driven**:
- Tasks 1–3 can start before S37a lands, and Tasks 4–9 wait on it, so the work comes in two waves that a per-task reviewer keeps honest;
- the riskiest surfaces (page-chosen file names, tokens in addresses, a guard that fires on an honest reply) are each one task, where a focused reviewer catches what a whole-branch pass skims;
- S37a and S42b move the same pins at the same time.
