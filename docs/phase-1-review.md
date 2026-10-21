# Phase 1 — experience review

Phase 1 delivers the design tokens (Paper complete; Aurora and Obsidian
applied as proof), the seeded standing files, and the chat surface with the
agent loop behind it. This is the checklist from the build prompt, filled in
with the evidence for each line. Screenshots are in
[`screenshots/`](screenshots/); the walkthrough that produced them is
`npm run shots`, and its raw results are in
[`screenshots/results.json`](screenshots/results.json) (27 of 27 checks pass).

## Every state designed

| State | What you see | Evidence |
| --- | --- | --- |
| Empty | The spelled-out date, "Nothing needs you yet.", the composer focused | [paper-empty](screenshots/paper-empty.png) |
| Thinking | A breathing accent dot until the first word (screen readers hear "Nova is thinking") | [paper-streaming](screenshots/paper-streaming.png) |
| Streaming | Markdown renders as it arrives, with a caret; tool markup never shows | [paper-streaming](screenshots/paper-streaming.png) |
| Approval | A card asks for one small decision; Enter allows, Esc denies | [paper-approval](screenshots/paper-approval.png) |
| Decided | The card files itself as a stamped record in the thread | [paper-approval-decided](screenshots/paper-approval-decided.png) |
| Error | A sentence a person would write, the detail folded away, Try again | [paper-error](screenshots/paper-error.png) |
| Stopped | Esc stops the reply and keeps what was written, with Regenerate | [paper-stopped](screenshots/paper-stopped.png) |
| Interrupted | If the server dies mid-reply, the turn reads as interrupted, with Regenerate | reducer test, `tests/reduce.test.js` |
| Offline | A quiet banner; the draft stays in the box | [paper-offline](screenshots/paper-offline.png) |
| Server unreachable | A banner, and the unsent message stays in the box | [paper-unreachable](screenshots/paper-unreachable.png) |
| Long content | Code blocks scroll in place, tables in their own region, a jump-to-latest pill | [paper-long](screenshots/paper-long.png) |
| Mobile | Sidebar becomes a drawer, no horizontal scroll | [mobile-chat](screenshots/mobile-chat.png), [mobile-drawer](screenshots/mobile-drawer.png) |
| Real model | `claude -p` end to end, including an approved command | [paper-real-model](screenshots/paper-real-model.png) |

## Motion audit

Every timing is `--m-fast`, `--m-med` or `--m-slow` with `--ease`; the token
lint fails the build on any raw duration or curve.

| Motion | Purpose |
| --- | --- |
| `rise` (fade + small lift) | A new thing arrived: your message, the empty state, an approval card, the jump pill, the settings sheet |
| `fade-in` | Nova's reply blocks and banners appear without moving the reading line |
| `breathe` | The thinking dot and the streaming caret: alive, not spinning |
| `stamp` | The decided approval is pressed into the record, once |
| Drawer slide (mobile) | Shows where the sidebar came from and goes back to |
| Theme crossfade | Background and text colors ease on theme or mode change |

Reduced motion: `--shift` becomes 0 (Paper only crossfades; the walkthrough
measured 0 px of translation), Obsidian's durations become 1 ms (measured),
the dot and caret hold still, and the stamp fades instead of pressing.

## Typography and spacing

Every font, size, line height, color, radius, shadow and duration comes from
a token. `npm run lint:tokens` enforces it across `ui/` (outside the theme
files) and `npm run check:themes` checks every theme defines the full
contract and passes its contrast pairs. Two deliberate exceptions remain as
literals because the contract has no token for them: `font-weight` (400 for
prose headings, 500 for buttons, 600 for bold) and `letter-spacing` on the
two small-caps labels. The living reference at `/styleguide.html` shows every
token in every theme ([styleguide](screenshots/styleguide.png)).

## Keyboard

The whole flow works without a mouse; the walkthrough drives it by keyboard.

| Key | Does |
| --- | --- |
| Enter / Shift+Enter | Send / new line |
| Esc | Stop a reply, or deny an approval |
| Enter on an approval | Allow once (the card takes focus when it appears) |
| ⌘/Ctrl+Shift+O | New conversation |
| / | Focus the composer |
| Alt+↑ / Alt+↓ | Previous / next conversation |

Focus is visible everywhere as a solid accent ring (checked in the
walkthrough). The composer is focused on arrival.

## Budgets

Measured in the build container, not on your Mac.

| Budget | Target | Measured |
| --- | --- | --- |
| Cold start | ≤ 2 s | 152 ms server + 146 ms page |
| Send → visible feedback | ≤ 100 ms | 18 ms (5–18 ms across runs) |
| First token (real `claude -p`) | considered progress, never frozen | 1.2–1.35 s, with the thinking dot from 5 ms |
| Reply done (short, real model) | — | ~1.65 s (was ~4.2 s before Nova stopped waiting for the CLI to exit) |
| Scrolling a long thread | 60 fps | Nova's work per frame: p95 3.9 ms, max 6.1 ms (of a 16.7 ms frame) |

On scrolling: the container has no GPU, so Chromium draws every frame in
software, which by itself takes about 16 ms at 2x. A trace showed over 90% of
each frame there and about 1 ms in Nova's code. Raw frame intervals swung
between passing and failing from run to run on the same code, so the check
now judges the work Nova controls (script, style, layout and paint, from a
trace of the same scroll) and reports the raw interval alongside it. Older
turns also skip off-screen layout and paint (`content-visibility`), which
roughly halved slow frames; a new check confirms a long conversation still
opens exactly at its latest message. Worth confirming by feel on your Mac.

## Copy review

Written as a product, not a developer tool. Some lines:

- Empty: "Nothing needs you yet."
- Approval: "A small decision, when you're ready" — Allow once / Deny.
- Missing CLI: "Nova couldn't find `claude`. Check that it's installed and on
  your PATH, or set agent_cmd in nova.config.json."
- Busy: "Nova is still replying in this conversation."
- Margin notes: "recalled from yesterday: …" rather than a file path.
- Tool rows read as actions: "Read USER.md", "Ran `git status`".

## One more thing

The approval card doesn't just disappear when you decide. It folds into the
thread as a small record with an ink stamp, Allowed or Declined, so the
conversation keeps an honest account of what you let Nova do. And the date
at the top of each day is spelled out the way a letter would be: "Wednesday,
the twenty-first of October".

## Screenshot index

Paper: [empty](screenshots/paper-empty.png),
[chat](screenshots/paper-chat.png),
[approval](screenshots/paper-approval.png),
[decided](screenshots/paper-approval-decided.png),
[streaming](screenshots/paper-streaming.png),
[stopped](screenshots/paper-stopped.png),
[error](screenshots/paper-error.png),
[offline](screenshots/paper-offline.png),
[unreachable](screenshots/paper-unreachable.png),
[long](screenshots/paper-long.png),
[real model](screenshots/paper-real-model.png).
Paper dark: [empty](screenshots/paper-dark-empty.png),
[chat](screenshots/paper-dark-chat.png),
[approval](screenshots/paper-dark-approval.png).
Aurora: [empty](screenshots/aurora-empty.png),
[chat](screenshots/aurora-chat.png),
[approval](screenshots/aurora-approval.png); dark
[empty](screenshots/aurora-dark-empty.png),
[chat](screenshots/aurora-dark-chat.png),
[approval](screenshots/aurora-dark-approval.png).
Obsidian: [empty](screenshots/obsidian-empty.png),
[chat](screenshots/obsidian-chat.png),
[approval](screenshots/obsidian-approval.png).
Mobile: [chat](screenshots/mobile-chat.png),
[drawer](screenshots/mobile-drawer.png).

## Gaps and decisions for you

1. **Token values changed from the specs** to pass contrast (Paper
   `--text-2`, `--text-3`, dark `--accent`; Aurora dark `--accent-text`).
   Table in [LEDGER.md](LEDGER.md#theme-token-gaps).
2. **Six contract additions** (`--font-mono`, `--t-mono`, `--t-wordmark`,
   `--column`, `--material-blur`, `--shift`) proposed for THEMING.md.
3. **Fonts in screenshots are Linux fallbacks.** On your Mac, Paper renders
   in New York (Safari) or Iowan Old Style (Chrome).
4. **No rename or delete for conversations** in Phase 1, on purpose.
5. **Localhost only.** Phone access would need `NOVA_HOST` and has no
   authentication yet.
6. **Margin notes need Phase 2.** Recall works and shows when a message
   matches a dated note, but nothing writes dated notes automatically yet.
