# Slice 2c — Durable turn (a reply survives the browser leaving)

Parent: the Master Roadmap; trigger: owner QA finding 2026-08-29 — a HARD
REFRESH during Nova's response interrupted and broke it. Slice type:
behavior-changing (chat core). Size: S/M.

The nav-survival fix (S2-T1) kept the stream alive across in-app navigation.
A full page reload is different: the browser tears down the JS context and
kills the fetch, so the S1 disconnect handler cancels generation and
persists only the partial — the operator returns to a truncated/broken
reply. The connection that dies is only browser↔core; core↔gateway is
still open. So the fix is to let the turn finish server-side.

## DoD (operator-visible, real stack)
1. Ask a question that takes a few seconds; HARD REFRESH (F5/Ctrl-R) mid-
   reply. After the reload, the COMPLETE answer is present in the
   conversation (arriving on its own if still generating, or already there
   if it finished) — never a truncated/broken reply.
2. The turn's status is 'ok' (completed), not 'interrupted', and Activity
   shows the full spans.
3. Closing the tab mid-reply and reopening later shows the completed reply
   too (same mechanism).

## Backend (services/core/app/chat.py)
- On client disconnect (CancelledError/GeneratorExit) during a turn:
  instead of cancelling generation and persisting the partial, DETACH the
  turn to a background task (bg.spawn) that continues draining the gateway
  stream, finishes the remaining tool-loop rounds, and persists the
  COMPLETE assistant message with status 'ok' and full spans — exactly as
  if the client had stayed. The trace/atomic-close contract is unchanged;
  only the "who is watching" is decoupled from "does it finish."
- Guard against double-persist / double-run: the detached completion is
  the ONLY writer once the SSE generator hands off; the streaming path and
  the detached path must be mutually exclusive (a flag/handoff, tested).
- A turn already finishing when the disconnect arrives just completes
  normally (no detach needed).
- NOTE: there is no explicit user "stop" yet, so every disconnect means
  "keep going." A real Stop affordance (cancel-on-purpose) is separate,
  later work — carry it, do not build it here. (Meaning: today, refresh =
  finish; deliberate cancel is a future button.)

## Web (apps/web)
- On chat load / ChatPage mount: if the active conversation's newest turn
  is still in progress (turns.status NULL / an in-flight flag surfaced by
  the messages or a small status read), show a subtle "Nova is still
  responding…" state and POLL (or reconnect) until the assistant message
  lands, then render it — so a hard refresh lands the operator back and
  the answer appears without a second manual refresh.
- If the turn already completed while away, the normal message re-fetch
  shows it (no special case needed beyond the poll terminating).
- No duplicate bubbles across the reload/poll/refetch (the S2-T1
  reconcile discipline applies — reconcile by conversation identity, and
  the in-flight poll resolves into the same row).

## Tests
- Core: a disconnect mid-turn → the detached task completes and persists
  the FULL reply with status ok (drive a fake gateway that keeps yielding
  after the SSE consumer goes away; assert the final message + spans);
  no double-persist; a disconnect after completion is a no-op.
- Web: mount with an in-flight newest turn → shows the responding state
  and resolves to the full reply on poll; mount with a just-completed
  turn → shows it once; no duplicate bubbles.

## Rails
No success unchecked (the detached completion persists only a verified
final); atomic trace close preserved; no double-run; comments
self-contained; real-stack testing (no isolation).

## Process
One implementer + review + fix rounds; rebuild the real stack and hand to
the owner to walk (hard-refresh test). Carry the "explicit Stop button"
follow-up.
