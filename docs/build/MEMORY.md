# Build memory

Standing facts for whoever builds Nova next. Dated notes sit beside this
file; decisions with reasons are in [../LEDGER.md](../LEDGER.md).

## Where things are

- Phase: **1 delivered, waiting for Jeremy's review.** Do not start Phase 2
  without his approval.
- Review: [../phase-1-review.md](../phase-1-review.md). Screenshots:
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

## Rules learned the hard way

- The repo is public. Never commit a real `NOVA_HOME`, session logs, or
  anything personal. Screenshots use the fake agent and a throwaway home.
- When Nova runs inside Claude Code, strip the parent session's memory from
  the agent's environment (`agentEnv()` in `src/agent.js`).
- Don't `pkill -f` a pattern that appears in your own command line.
- Components never use raw values; the lint will say so.
