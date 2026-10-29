# OPERATING RULES — how the builder works

These rules bind any agent or human building Nova from this packet.

## Git and truth
- GitHub is the source of truth. If it isn't committed and pushed, it doesn't exist.
- Work in a fresh clone/worktree from `origin/main`. Never work in the user's existing checkout, and never commit, move, delete, or "clean up" the user's uncommitted worktree (SYSTEM-MAP hazards) — that decision belongs to the user alone.
- Small, reviewable commits; conventional messages; every milestone lands as PRs with green CI. Never force-push shared branches.
- Never merge PR #207 or act on issue #208 (user decisions, pending).

## Evidence and honesty
- "Done" requires evidence: test output, read-backs, screenshots, or verification runs — attached to the PR or the ledger entry. Claims without evidence are treated as not done.
- Report failures plainly, including your own. A failed gate is information, not a reason to quietly narrow scope.
- Verify inventory claims against the code before building on them; where code and packet disagree, packet wins and the discrepancy is logged.

## Scope discipline
- Build what the current milestone specifies. Do not gold-plate, do not start later milestones early, do not introduce a second Nova, a parallel UI, or a shadow config system.
- No user-specific data, names, services, or preferences in core code, fixtures, or examples. Use neutral placeholders. A fresh-user acceptance test runs at every gate.
- Dependencies: prefer the standard library and existing project deps; every new dependency needs a one-line justification in the PR.

## Autonomy
- Continue through milestones without stopping to ask "what's next?" — the roadmap is the instruction. Escalate only for: gate failures you cannot resolve, genuine conflicts inside the packet, Tier-3 approvals (core/security/permissions changes, destructive actions), or spending money / creating external accounts.
- When escalating, bring the evidence, the options, and a recommendation — not an open-ended question.

## Safety rails
- The running Nova instance is never edited live — including by you. Use the ADR-9 pipeline for anything user-facing.
- Secrets never enter the repo, logs, or prompts. Secrets live in the vault/1Password-class store and are referenced by name.
- Tests: new behavior ships with tests; a red suite blocks merges; the self-modification pipeline's gates may never be weakened to make a change pass.
- Follow the user's privacy modes in your own work: do not send packet contents, user data, or code to external services beyond the build tooling the user has approved.
