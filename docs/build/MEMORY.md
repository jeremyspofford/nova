# Build memory

Standing facts for whoever builds Nova next. Dated notes sit beside this
file; decisions with reasons are in [../LEDGER.md](../LEDGER.md).

## Where things are

- Phases 1 to 4 approved and merged (#198, #199, #200, #201). Phase 5
  (helpers and the Activity view) delivered for review. It is the last
  planned phase; MCP connectors were agreed as a later extra, not started.
- Reviews: [../phase-1-review.md](../phase-1-review.md),
  [../phase-2-review.md](../phase-2-review.md),
  [../phase-3-review.md](../phase-3-review.md),
  [../phase-4-review.md](../phase-4-review.md),
  [../phase-5-review.md](../phase-5-review.md). Screenshots:
  [../screenshots/](../screenshots/).
- The previous attempt is preserved at the `archive/attempt-6` tag.

## How to run and check

- `npm run dev` — hot reload at http://127.0.0.1:4317.
- `npm run dev:follow` — the same, plus `git pull` from the branch every few
  seconds, so a local machine can watch a cloud build.
- `npm run check` — unit and API tests, token lint, theme contract.
- `npm run shots` — the browser walkthrough: golden screens, keyboard path,
  budgets. Set `CHROMIUM=/path/to/chrome` if Chromium is elsewhere.
- `npm run shots:map` — the Stellar Map's walkthrough on a made-up home
  (`scripts/sample-home.js`): every interaction checked, screenshots saved.
  WebGL runs on SwiftShader in the container, so it takes several minutes.
- `NOVA_AGENT_CMD="node scripts/fake-agent.js"` runs without a model.
- `node scripts/fake-google.js` starts a stand-in Google (OAuth, Gmail API, search); `startFakeImap()` in the same file is a stand-in Gmail IMAP (app password `abcd efgh ijkl mnop`)
  on :4399; point Nova at it with `NOVA_GOOGLE_BASE=http://127.0.0.1:4399` and
  `NOVA_SEARCH_URL=http://127.0.0.1:4399/search`. All its mail is made up.

## Rules learned the hard way

- The repo is public. Never commit a real `NOVA_HOME`, session logs, or
  anything personal. Screenshots use the fake agent and a throwaway home.
- When Nova runs inside Claude Code, strip the parent session's memory from
  the agent's environment (`agentEnv()` in `src/agent.js`).
- Don't `pkill -f` a pattern that appears in your own command line.
- Components never use raw values; the lint will say so.
- Memory is gitignored inside the home folder (Jeremy agreed), so Forget
  never needs to rewrite history. Code that rewrites git history is blocked
  by the build environment's safety check anyway.
- Nothing real reaches Gmail from the build container: there are no Google
  credentials here. Gmail is verified against the stand-in, plus the real
  model reading the stand-in's mailbox.
- Permissions: every tool that needs an OK declares `permission`; Settings
  lists them from the tools, all "ask" by default (Jeremy's choice), stored in
  `~/permissions.md`. Switched on: taken without asking anywhere
  (`auto: true`). Off: unattended runs and helpers wait for the answer; a
  waiting scheduled run moves to `scheduler.waiting` so the queue continues.
- After a helper's report, `runner.followUp()` starts a turn with no user
  text (`followup: <handoff id>`) so Nova comments on it.
- Helpers are sessions too (`kind: "helper"`). Their context is scoped in
  `buildSystem(..., { helper })`; keep memory out of it. A helper's report is
  delivered by `Helpers.hand()`, which also records `delivered` in the
  helper's log, so Activity and the log can link to the report.
- Activity reads every log modified in the week. If it ever gets slow, the
  per-file cache in `src/activity.js` is the place to look, not a new store.
- The Stellar Map (Nova theme only) is drawn from files and nothing else:
  `buildMap()` in `src/map.js` reads USER.md, MEMORY.md, day notes,
  `memory/people|groups|topics/*.md` and `workspace/goals/*/GOAL.md`. Layout
  (`ui/js/stellar/layout.js`) is deterministic from that data, so the same
  files always give the same sky. Don't add a separate store for positions.
- Stellar Map colours are the sanctioned starlight tokens in
  `ui/themes/nova.css`; shaders get them as uniforms. The token lint still
  applies to its JS.
