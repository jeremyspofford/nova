# What she can draw in chat

S54a, built 2026-10-15. The design and its reasons are in [`spec.md`](spec.md);
this page is what you will see.

Her replies are still markdown. Where a reply has structure (a flow, a set of
parts, a plan over time, options to weigh), she can put a component block
between the paragraphs and the chat draws it. Short answers stay prose.
She uses at most three blocks in a reply, and the prose reads on its own
without them.

## The vocabulary

**Primitives**, which she composes on the fly:

- **text**: a short paragraph (small or normal size, primary or secondary tone).
- **title**: a one-line heading inside a block.
- **icon**: one icon from a fixed list of 44 lucide icons.
- **divider**: a thin line between parts.
- **badge**: a short label pill (a status, a tag, a version).
- **stack**: children drawn top to bottom.
- **row**: children side by side, wrapping on a narrow screen.
- **card**: a bordered panel around its children, optionally tinted.

**Composites**, ready-made shapes for common structure:

- **steps**: a numbered flow of up to 8 steps, cards with arrows between them.
- **layers**: a divided list of up to 8 parts, each with an icon, title,
  secondary line and body.
- **timeline**: up to 8 rows, each with a label such as "Week 1", a title and
  a body.
- **compare**: 2 to 4 options side by side, each with pros and cons.
- **callout**: a boxed note, warning or tip.

**Choices**: one to six radio questions and a button. Pressing the button sends
a message from you, in your bubble, built from what you picked. It goes through
the same path as anything you type. It never calls a tool, a route or a link,
and it can never send a message that starts with "/", so a block cannot run a
slash command. Once you have sent any message after it, the block is frozen: its
options and button are disabled, and it cannot send twice.

## Limits that always hold

- **Icons only, no emoji.** An icon name outside the list draws nothing.
- **Colours are theme tones** (accent, success, warning, danger, neutral) and
  follow your theme. A block cannot carry its own colours.
- **Nothing she writes runs.** A block is data checked against a fixed
  schema. There is no script, HTML or link in it.
- **Size is capped**: 4 levels deep, 40 parts, and short strings.

## When a block cannot be drawn

A block that is malformed, too big or of an unknown type is never blank and
never breaks the page. It shows as a code block with a line under it,
"couldn't draw this block:", followed by the first thing that was wrong. While
a reply is still streaming, an unfinished block shows as code and is drawn once
it is complete.

## Chat only

Blocks are drawn in chat and nowhere else. The Files viewer and any other
place that renders her markdown show the block as code. The saved message
is exactly what she wrote, so search, rewind and memory read the same text.

## How it is checked

Every reply is checked when it is saved: the turn's trace gets a `ui_blocks`
record with the number of blocks, how many failed, and the first error. Four
eval cases measure whether each model draws valid blocks when the answer has
structure, and draws none for a one-line question. Those eval runs, and the
live walk in chat, are still owed.
