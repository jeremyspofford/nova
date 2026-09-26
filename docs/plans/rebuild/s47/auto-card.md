# S47 follow-up: core sends the setup card on a plain request

**Status:** owner decision 2026-09-26; built on `slice/s47-auto-card`.

## Why

In S47's first walk, on 2026-09-26 at 22:49Z, the owner asked "How do I put you on my
phone?" (turn `798ccf87`). The chat model, `dell:qwen3:8b`, was advertised the whole
registry, `show_setup_qr` included (11,025 prompt tokens, 5.6 s of thinking). It made
**zero tool calls**. Instead it answered with an invented plan: a web page served from the
Dell, and an iOS app sideloaded through AltStore.

Memory recall had pulled in the owner's 2026-09-15 conversations about building an iOS app
without a Mac, and the reply replays them. No guard fired, and none could: nothing in the
reply was a Nova address, a pairing code, a claimed card or a capability denial.

S47 relied on her calling the tool, and on the eval corpus measuring whether she does.
That is the failure mode the house rule exists for: "If a property must hold, the backend
enforces it. A prompt is a request, not a control."

## The owner's decision (2026-09-26)

> **Core sends the card.** When your message plainly asks for one of the four setups, core
> runs show_setup_qr itself, like nova_address's auto-run; she writes around the result.
> The card never depends on the model. Cost: a phrase match decides, so a false match
> shows an unasked card (for a machine, a 10-minute code).

## Design

### 1. `setup_request(message) -> SetupKind | None`

This is a new pure module, `services/core/app/setup_request.py`, and it is precision
first. It answers with a setup only when the owner's own message plainly asks for that
setup. Anything else gets None, and None leaves the turn exactly as it is today.

| Setup | Plain requests it answers (the pins; not the whole grammar) |
|---|---|
| `install_pwa` | "How do I put you on my phone?", "Put Nova on my iPad", "How can I get you on my tablet?", "Install Nova on my phone", "Add you to my home screen" |
| `get_app` | "Where do I download your iPhone app?", "Is there a Nova app for Android?", "Get me the Nova app" |
| `add_machine` | "Add my laptop so you can control it.", "Pair my desktop with Nova", "Connect my laptop to you" |
| `add_model_server` | "Set up the Dell to serve models.", "Add a model server", "Use my desktop to serve models" |

The object must be Nova herself ("you", "yourself", "Nova") or a device of the owner's.
The device words are phone, iPhone, iPad, tablet, Android, laptop, computer, desktop, PC,
Mac, machine, server, the Dell, or any "my <device>".

It answers None for:

- **A negated or past request:** "don't put you on my phone", "I already put you on my
  phone", "I put you on my phone yesterday".
- **Something else put on a device:** "put my calendar on my phone", "put the shopping
  list on my phone", "add my laptop's files to the note".
- **A capability question with no request:** "can you control my laptop?". This is a
  question about her, not "add my laptop".
- **Two different setups in one message.** Nothing is sent, and her own call still works.
- **A message only mentioning a phone:** "my phone died".

A match reads the owner's MESSAGE only. It never reads recalled memory or earlier turns.

### 2. The backend sends the card before her first round

`_run_turn` does this only when the turn has a card channel: a stream turn, or an eval
case through the recorder. Scheduled, drain and agent-delegation turns have no channel,
so nothing is sent there, exactly as her own call would state. If `setup_request(message)`
returns a setup, core dispatches `show_setup_qr {"setup": <it>}` through `tools.dispatch`,
with the turn's own ToolContext (card channel, person, facts_sink).

The span follows S18's `_run_script_step` precedent:

- it is `kind="tool"`, named `show_setup_qr`, with `args_redacted`, `ok`, `result_head`
  and `facts` exactly as `_run_tool` files them;
- `requested_by_owner: true` tells a reader why it ran without her call;
- an activity frame is emitted for it.

Every reader downstream therefore works unchanged: the narration guard's
`showed_setup_qr` backing, the eval's `tool_called`, the reload's `_card_json` from span
facts, and the pairing-code containment tests.

This is not live_facts. live_facts' invariant is that nothing it runs unasked may change
anything, and this call changes something (a card is sent, and for a machine a code is
minted). But it is not unasked either: the owner asked, in so many words. It gets its own
small path, and live_facts is untouched.

### 3. She is told what was sent, and cannot send it twice

Her turn carries one factual line, stated plainly, beside the turn's other facts. It says
the owner asked for the `<setup>` setup, core sent its card to the chat, and here is what
the tool returned (the result text as-is). She is not to call show_setup_qr again for it.
If the dispatch failed, the line says core tried and could not, with the stated reason,
so her reply can say why.

That line is a request, not a control. The control is this: when she calls
`show_setup_qr` for a setup core already sent this turn, the call does not dispatch.

- It gets the first result back, marked "(already sent to the chat this turn)".
- No second card is sent and no second code is minted.
- It is decided synchronously in the dispatch funnel, with no new `await`, so the pins in
  `tests/test_no_approvals.py` hold.
- It is recorded as a span with `already_sent: true`.
- A call for a DIFFERENT setup dispatches normally.

### 4. Evals: suite_version 16 → 17

The three S47 cases ask plain requests, so their `tool_called('show_setup_qr')` now
measures that the card goes out, not the model's own choice. The stored numbers change
meaning, so the corpus moves to `suite_version` 17. The rule is "measurement frames
outlive their code"; `test_eval_corpus` pins the version and each case's comment. Each of
the three comments gains one sentence: core sends the card on this plain request, so the
case measures the product's guarantee; the model's own call is measured by the phrasings
`setup_request` leaves alone. The contracts do not change.

### 5. Not in scope

- The memory recall that primed the reply. It is legitimately relevant history, and it
  is framed as such.
- The earlier walk turn that timed out on `hub:qwen3:1.7b` (turn `7e87ff19`). That is
  routing, the hub lane's.
- Her prose around the card. The existing guards still judge it.

## Tests (each written first, and shown RED)

- **`tests/test_setup_request.py`:** every row in the table above answers its setup, and
  every None row answers None. Add a timing row with a 1500-character padded message,
  under the guard timing budget.
- **The wiring, in a DB test beside `test_chat_setup_card.py`, using its fixtures and the
  real stream route:**
  - "How do I put you on my phone?" produces a `show_setup_qr` span with
    `requested_by_owner`, and a `card` frame before any model delta. The model payload of
    round 1 carries the factual line.
  - The model then calling `show_setup_qr {"setup": "install_pwa"}` produces no second card
    frame and no second mint, and a span with `already_sent: true`.
  - "Add my laptop so you can control it." produces a machine card with a real minted code.
    That code is absent from every non-card frame, the model payloads, turn_spans,
    messages and the log, as the existing containment test checks.
  - "What's the weather?" produces no backend span and no card.
  - A turn with no card channel (the scheduler's path) produces no backend span.
  - When the mint fails, the line states the failure, no card is sent, and the span has
    `ok: false`.
- **The corpus pins:** `suite_version` 17 for every case; the three comments carry the
  new sentence; the count stays 29.

## Done means

- All the above are green; the full core suite has no new red beyond the known timing set.
- Reviewed, merged by the owner, deployed from `~/workspace/nova/deploy`.
- The walk asks "How do I put you on my phone?" again. The trace, read by turn id, shows
  the `requested_by_owner` span and a card, and the owner scans it.
