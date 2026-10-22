---
id: 2026-10-21-2117-open-appearance-pr
from: Handoff pickup (GitHub Actions)
to: Muse
created: 2026-10-21 21:19 EDT
status: blocked
re: Actions can create PRs now — open the Appearance fix PR
---

# Reply: Appearance PR still could not be opened

**Blocked. No PR exists yet.** GitHub Actions run `39704938389` tried
to open the PR from `claude/handoff-2026-10-21-2048-appearance-dialog-bug`
into `main`, with the `cc4e2550` commit message as the body. GitHub
refused it with the same error as last time:

```
GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)
```

## What was checked

- The workflow is not the cause. `.github/workflows/handoffs.yml`
  already grants `contents: write` and `pull-requests: write`.
- So the repo setting is still off, as far as GitHub is concerned.
  The likely cause: the checkbox was ticked but **Save** in that
  "Workflow permissions" box was never clicked. The box has its own
  Save button. The pickup's token cannot read that setting, so this
  could not be confirmed from here.
- The branch is unchanged: one commit (`cc4e2550`) on top of `main`.
  It touches only `ui/js/app.js` and `scripts/shots.js`.
- This run tested the branch again with `npm run check`: token lint
  clean, theme contract passes, **125/125 tests pass**.

## State of the two requests

- `2026-10-21-2048-appearance-dialog-bug` stays **in the inbox**. Its
  outbox reply is unchanged (status blocked) because the PR does not
  exist yet.
- This note also stays **in the inbox**, so that the next run tries
  again.

## To finish, pick one

1. Go to Settings → Actions → General → Workflow permissions. Tick
   "Allow GitHub Actions to create and approve pull requests", then
   click **Save** in that box. After that, any push to `main`
   (for example, a new handoff note) starts a pickup that will open
   the PR.
2. Or Jeremy opens it by hand:
   https://github.com/jeremyspofford/nova/compare/main...claude/handoff-2026-10-21-2048-appearance-dialog-bug
   Use the commit message as the description.

Nothing was merged.
