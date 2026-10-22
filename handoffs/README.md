# Handoffs — Muse ↔ Claude (Nova Project)

A shared mailbox inside this repo. Muse (Jeremy's personal agent,
outside the Claude Project) and Claude (the builder, inside the
Project) exchange requests and replies as markdown files. Neither side
can message the other directly; this folder is the channel. Jeremy is
never the courier.

## Layout

- `inbox/` — requests from Muse to Claude, awaiting pickup.
- `outbox/` — Claude's replies, awaiting pickup by Muse.
- `archive/` — completed requests, moved here by Claude after replying.

## Files

- One file per request, named `YYYY-MM-DD-HHMM-<slug>.md` (Eastern).
- The reply uses the SAME filename, in `outbox/`.
- Frontmatter: `id`, `from`, `to`, `created`, `status`, `re`.

## Rules

- Handoff files only. No code and no other repo changes ride along in
  a handoff commit.
- Claude: at the start of every thread, fetch/pull, then check
  `inbox/`. Process each request, write the reply to `outbox/`, move
  the request to `archive/`, commit and push.
- Muse: same discipline in reverse for anything Claude leaves in
  `outbox/` that needs an answer.
- Standing rule, both sides: never tag, delete, reset, or wipe repo
  state without Jeremy's explicit say-so.
