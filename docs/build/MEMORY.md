# Build memory

Standing facts for whoever builds Nova next. Dated notes sit beside this
file; decisions with reasons are in [../LEDGER.md](../LEDGER.md).

## Where things are

- Phases 1 and 2 approved and merged (#198, #199). Phase 3 (skills, Add your
  own with Claude's format, and the Gmail connector) delivered for review; do not start Phase 4 without
  Jeremy's approval.
- Reviews: [../phase-1-review.md](../phase-1-review.md),
  [../phase-2-review.md](../phase-2-review.md),
  [../phase-3-review.md](../phase-3-review.md). Screenshots:
  [../screenshots/](../screenshots/).
- The previous attempt is preserved at the `archive/attempt-6` tag.

## How to run and check

- `npm run dev` — hot reload at http://127.0.0.1:4317.
- `npm run dev:follow` — the same, plus `git pull` from the branch every few
  seconds, so a local machine can watch a cloud build.
- `npm run check` — unit and API tests, token lint, theme contract.
- `npm run shots` — the browser walkthrough: golden screens, keyboard path,
  budgets. Set `CHROMIUM=/path/to/chrome` if Chromium is elsewhere.
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
