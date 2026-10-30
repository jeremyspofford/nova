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

## Addendum — owner's standing orders (2026-10-29)
These come from the owner and supersede any reading of the packet that waits for owner review. A fresh session inherits them.

1. **Continue without stopping.** Owner review is not a gate. End-of-milestone updates are progress reports, not requests for permission. Work through the milestones in roadmap order. Stop only for the packet's hard limits, and report each with evidence, options and a recommendation:
   - Tier-3 actions: creating external accounts, spending money, destructive or irreversible actions, core security or permission changes.
   - A genuine conflict inside the packet.
   - A gate failure that can't be resolved after a real attempt.
2. **Merge as you go.** Merge every milestone PR into `main` as soon as its own gate passes and CI is green; don't wait for the owner. If the owner comments later, fix forward in a new PR. This covers PRs from this build only: PR #207 stays untouched, and issue #208 stays alone.
3. **Decisions already made:**
   - **Noul** is Jev's yes/no question type. It returns one calibrated probability in [0, 1] that the answer is yes. There is no separate confidence field: the probability is the certainty, and 0.5 means maximum uncertainty. It is part of the decision interface, the Jev stub and decision templates.
   - **Jev account:** do not create one. The real Jev adapter stays a stub behind the interface until the owner decides. This never blocks a milestone.
   - **Local-only** never falls back to the cloud, not even with a warning. Making local models easy is M6's job.
4. **Forgetting is complete.** Deletion of a memory must also hold in backups: either deletion propagates to them, or they are destroyed or rebuilt under a stated retention rule. Tested. This is part of M2.
5. **Localhost preview.** Keep the latest merged `main` running at http://localhost:4317:
   - It runs from the nova-build clone, in a persistent tmux session named `nova-preview`, with its own data home `~/Nova-preview`, never the owner's real data. `scripts/preview.sh` does this.
   - After every merge, restart it from the new `main` and verify that it answers an HTTP request.
   - Put the URL in every progress report.
   - Serve only what is built. Don't fake UI that doesn't exist yet.

## Addendum — Amendment 2026-10-30-C (owner, approved)
`AMENDMENT-2026-10-30-C.md` is binding spec, and `UX-RESEARCH-2026-10-30.md` is its evidence base. The owner approved all of it, including two research-backed overrides of their first instincts:
- chat bubbles have no tails;
- timestamps are grouped, not shown on every message.

It also sets the hybrid theme flow: a theme for this device applies instantly with a visible Undo; a theme for all devices needs an explicit Save.

Where it lands:
- **Part 1, UI fixes:** one PR, straight after M7.
- **Part 2:** milestone M9, "Feel & Polish".
- **Part 3, the ingest security gate:** built before any Nova browser opens a real page.
- **Part 4:** milestone M10, "Execution Plane", with a design doc first.
- **The progress rules:** in DESIGN-SYSTEM §1.

Where it differs from earlier packet text, the amendment wins: for example, the orb shows once per view and is no longer a per-message chat avatar. Standing orders are unchanged. Nothing in it waits on a Jev account or on real-device pairing.
