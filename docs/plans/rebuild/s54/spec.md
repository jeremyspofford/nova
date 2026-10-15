# S54 — Her replies can carry interface, not only markdown

**Status:** S54a built 2026-10-15, live walk + eval run owed (what you will see:
[`what-she-can-draw.md`](what-she-can-draw.md)); S54b and S54c not built.
Fable-authored; the decisions marked
**LOCKED** are the owner's, from the 2026-10-14 chat.

## Why

The owner asked her and ChatGPT the same question — "What's a software factory
and how do I build one?" — and hers "reads like an old school text book", while
ChatGPT's was "easy to follow and read".

The ChatGPT answer (share `6acfbe01-c56c-83e9-a8db-1e49e3b18d00`, read from its
page data and screenshotted 2026-10-14) is **not markdown alone**. It is
markdown — `##` headings, pipe tables, bold — with component blocks between
the paragraphs, drawn by the app:

- a five-step flow: coloured cards, an icon and a two-line caption each, arrows
  between them;
- a five-layer architecture list: icon + title + secondary line + body, divided;
- a week-by-week timeline: a big "Week 1" label beside each step;
- a closing form: four radio groups and a button. The button sends a NEW chat
  turn composed from the choices ("Design a practical AI-powered software
  factory tailored to me. Goals: … Model execution: … Autonomy: …").

Its vocabulary is small and general — `box`, `row`, `text`, `title`, `bold`,
`icon`, `divider`, `table`, `list`, `blockquote`, `radio-group`, `radio`,
`button`. "Flow diagram" is not a component; it is boxes, icons and arrow
icons composed in that reply. That is what makes it on-the-fly.

Hers renders through `apps/web/src/components/Markdown.tsx`, which by design
never renders model-authored HTML. No prompt can make her draw a card.

The prose half of the gap — answer first, sectioned, one idea per bullet,
headings that read as headings — was fixed separately on 2026-10-14
(`fix/reply-readability`: the `ANSWER_LAYOUT` prompt block in `chat.py` and
the heading/spacing rhythm in `Markdown.tsx`). This slice is the other half.

## Decisions

1. **Markdown stays the base. LOCKED.** A reply is markdown with component
   blocks inside it, never a component tree instead of markdown. Most replies
   are prose and lists, and text is what notifications, copy, search and memory
   distillation consume.
2. **Components grow through a registry, and she can compose on the fly.
   LOCKED** ("we'll want to build up more nova components, or allow her to do
   it on the fly").
3. **Which model draws them is decided by measurement, not assumed. LOCKED
   direction** ("we may need to have nova switch to a specific cloud llm for
   rendering UI components") — see §5: the layout role exists only if the eval
   numbers say the answering model cannot do it.

## 1. The wire format

A component block is a fenced block tagged `nova-ui` holding ONE JSON object:

````text
```nova-ui
{"type": "steps", "items": [
  {"icon": "lightbulb", "title": "Idea or requirement", "caption": "A feature request or bug report"},
  {"icon": "bot", "title": "AI development agents", "caption": "Plan, write, review, fix"}
]}
```
````

Why a fence and JSON:

- **The reply stays valid markdown.** Any surface that does not draw
  components (a notification, an Inbox item, an export) shows a code block —
  readable, never broken.
- **The persisted text is the source.** `messages.content` stores the reply as
  written; drawing happens in the browser. Rewind, search, distillation and the
  guards all keep reading text.
- **JSON, not JSX or HTML.** JSON parses with a schema check and nothing else:
  there is no expression, attribute or script in it to evaluate. ChatGPT's
  JSX-with-state (`DIL.useState`, `onClick: () => GenUI.issueNewTurn(...)`) is
  code; ours must not be.
- **The guards see it.** The markup strip at the persist boundary
  (`without_markup`, `_refuse_call`) treats a fence as quoted text, so a block
  never dispatches anything (prose-never-causes-an-action holds unchanged).
  `nova-ui` is added to the fence tags the guards recognise as non-claims, the
  same way a `text` fence is.

## 2. The registry (web)

`apps/web/src/components/ui-blocks/` — one file per component, each exporting:

```ts
export const block = {
  type: 'steps',
  schema,          // zod: the props it accepts, with length caps
  describe: '…',   // one line for her prompt: when to use it
  example: {...},  // one valid instance, also used by the tests
  Render,          // React component, props = schema output
}
```

`index.ts` collects them into `UI_BLOCKS`. `Markdown.tsx`'s `pre` override
routes a `language-nova-ui` fence to `<UiBlock source=…>`, which:

1. parses JSON; validates against `UI_BLOCKS[type].schema`;
2. on success renders `Render`;
3. on ANY failure renders the original fence as a code block, plus a one-line
   caption "couldn't draw this block: <first schema error>" — visible, never
   silent (silence-reads-as-coverage). The failure is also counted
   (§6).

While a block is still streaming (unclosed fence) it renders as code, exactly
like an unclosed code fence today; it becomes the component when the fence
closes and parses.

### The vocabulary, phase 1

Two layers, so composition is possible without new code:

**Primitives** (what makes on-the-fly layouts possible):
`stack` (vertical, gap), `row`, `card` (border/surface, optional tone),
`text` (size: sm/md, tone: primary/secondary, weight), `title` (sm/md/lg),
`icon` (a name from the lucide set the app already ships — unknown name renders
nothing, not a broken glyph), `divider`, `badge`.

**Composites** (the shapes the ChatGPT reply used, so she does not have to
rebuild them every time): `steps` (numbered/arrowed flow), `layers` (icon +
title + secondary + body list), `timeline` (label + title + body rows),
`choices` (§3), `compare` (columns of option cards with pros/cons),
`callout` (note/warning/tip).

Tables stay markdown tables — they already render, scroll and copy.

**Colour:** a tone from the theme (`accent`, `success`, `warning`, `danger`,
`neutral`), never a hex value. A model's `#23354D` would ignore the owner's
theme and dark mode; tones follow both.

Limits enforced by the schema: nesting depth ≤ 4, ≤ 40 nodes per block, string
lengths capped. Over the limit fails validation and falls back to code.

### Adding a component

One file in `ui-blocks/`, registered in `index.ts`. Her prompt and the core
side learn of it mechanically (§4), so nothing else is edited. That is how
"build up more nova components" happens, by us or by her (§7).

## 3. Interactivity: `choices`

```json
{"type": "choices",
 "questions": [
   {"id": "goal", "label": "What should the factory produce?",
    "options": [{"value": "personal", "label": "Tools for myself"},
                {"value": "both", "label": "Both"}], "default": "both"}],
 "submit": {"label": "Design my factory",
            "message": "Design a software factory for me. Goal: {goal}."}}
```

- Each question is a radio group; `default` preselects.
- The button fills `{id}` placeholders with the chosen LABELS and **sends the
  result as an ordinary user message** through the existing send path, in the
  same conversation — exactly as if the owner had typed it. It is shown in his
  bubble, so what was sent is visible.
- It never calls a tool, an API route or a URL. Nothing a block contains can
  do anything a typed message could not. This is not an approval surface
  (no-approvals ruling 2026-09-03): it is a shortcut for typing an answer.
- After sending, the block is shown as answered (selections frozen) for that
  message; a reload derives "answered" from the next user message existing,
  not from client state.

## 4. Her side (core)

- **Advertised from the registry, never hand-written.** The web build emits
  `ui-blocks.json` (type, describe, example, and the JSON Schema produced from
  each zod schema), committed to the repo and checked by a web test that
  regenerates it and fails on a diff. Core reads that file, and
  `stable_system_prompt` appends a block listing every type with its one-line
  use and example. Registering a component puts it in her prompt by that fact
  alone (derived-never-hardcoded), and a test fails if the prompt and the
  registry disagree.
- **Guidance, placed with `ANSWER_LAYOUT`:** use a block when it carries
  structure prose would bury (a flow, layers, a timeline, options to pick);
  never for a short answer; never more than ~3 per reply; everything in a block
  must also be understandable without it (a sentence before it says what it
  shows).
- **A check, not a hope:** core validates each `nova-ui` fence in her final
  reply against the same JSON Schema before persisting, and records the result
  on the turn's span (`ui_blocks: n, invalid: k, first_error`). It does not
  rewrite the reply — the browser's fallback already keeps it readable — but
  the trace is how we know the rate (read-the-trace).

## 5. Which model draws them

Order, each step gated on the one before:

1. **Measure (this slice).** Eval cases where a good answer needs structure
   (the software-factory question; "compare these three options"; "walk me
   through setting up X"; one where a block would be wrong — a one-line
   question). Predicates: blocks parse and validate; at least one block where
   the case expects structure; none where it does not; the prose still answers
   without the blocks. Run the corpus on her local default (dell:qwen3.8:27b),
   the 8B, and one cloud model. Bump `suite_version`.
2. **If the local models pass**, done: whatever answers, draws.
3. **If they do not**, a **`layout` gateway role** (beside `judge` and
   `decisions` in `routing.py` `BUILTIN_ROLES`, the owner picks its model on
   the Models page like any role). After her reply is final, core sends the
   reply text to the layout role with the block registry and asks for the same
   reply with suitable parts turned into blocks — text unchanged otherwise. Core
   validates the result; if it fails, or the role has no model, or it times
   out, the original reply stands. Conditions:
   - runs only when the reply has structure worth drawing (≥ 2 `##` sections,
     or a numbered list ≥ 4, or a table) — a mechanical test of the text, not
     a model's guess;
   - **privacy is stated on the role**: "your reply text is sent to this
     model". With no model set, replies stay markdown — local-only installs
     lose nothing (nova-product-principles: local-model users primary);
   - the second pass streams as a replacement of the finished reply, so the
     owner reads the answer immediately and sees it gain its blocks.

## 6. What the owner can see

- A block that failed to draw says so, inline (§2).
- The turn's span carries the block counts (§4) and, with a layout role, the
  role's model and outcome (`applied`, `invalid`, `skipped: no structure`,
  `skipped: no model`).

## 7. Her building new components

Two tiers, so she is never blocked and the app is never exposed:

1. **Composition — every reply, no code.** New layouts from the primitives.
   This covers most "on the fly".
2. **A new registered component — through self-coding.** When composition
   cannot express it (a chart of her own data, a live device card), she writes
   the component file + test through `start_change` in her worktree and opens a
   PR; it ships on merge like any change. Its addition is mechanically visible
   to her afterwards (§4).

**Ruled out: running model-written JavaScript in the app.** The app's origin
holds the owner's session cookie; script there can call every API as him. If
throwaway widgets are ever wanted, they run in a sandboxed `iframe`
(`sandbox="allow-scripts"`, no `allow-same-origin`, served from a separate
origin, no network) talking to the page only by `postMessage` with the same
"send a message" verb as `choices`. That is a later slice (S54c), not this one.

## Phases

- **S54a** — registry + primitives + composites + `choices`; `Markdown.tsx`
  routing and fallback; `ui-blocks.json` emitted and advertised in her prompt;
  the core-side validation + span counts; eval cases + first scored run on the
  three models. Docs: the chat page in the user docs gets a "what she can
  draw" section (document-as-we-ship).
- **S54b** — the `layout` role, only if S54a's numbers call for it (§5.3).
- **S54c** — sandboxed widgets, only if a real need shows up that composition
  and registered components cannot meet.

## Done when (S54a)

- Asked "What's a software factory and how do I build one?" through :5173, her
  reply opens with the answer, and draws at least one block (a `steps` or
  `layers`) — verified in the real chat, screenshot kept beside this spec.
- A malformed block in a reply shows as code with the "couldn't draw" line,
  never a blank or a crash (unit test + one live turn).
- A `choices` submit sends the composed text as his message and the reply
  answers it (live).
- Adding a test component file changes her prompt with no other edit (test).
- The eval run is recorded with per-model validity rates, and S54b's go/no-go
  is written here from those numbers.
- `npm test`, `npx tsc --noEmit`, core `uv run pytest`, ruff on touched files.

## Owner answers (2026-10-14)

1. **Icons: the app's lucide set only, no emoji. LOCKED.** An unknown icon name
   renders nothing; a schema test rejects non-lucide names.
2. **Chat only. LOCKED.** Scheduled messages and Inbox items show the code
   fallback; drawing blocks there is not in S54.
3. **Roadmap placement:** the owner did not place it. Fable's recommendation,
   recorded as such: after S32.5, before the boot agent. The prose half of the
   gap shipped on its own (`fix/reply-readability`), so S54a is not urgent
   enough to interrupt the S32 lane.
