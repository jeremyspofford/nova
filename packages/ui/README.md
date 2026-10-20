# @nova/ui

The design system (`docs/04` §4): CSS tokens (`tokens.css`), built-in themes that pass WCAG 2.2 AA
contrast checks, theme merge/apply helpers, color helpers (`mixHex`, `readableOn`, `contrastRatio`)
and accessible components. Components use tokens only; a test fails on hard-coded colors in
`src/components/`.

| Component                                                       | Notes                                                                                                                                                                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`, `IconButton`, `TextField`, `Kbd`, `Switch`            | Foundation primitives                                                                                                                                                                                             |
| `SelectField`, `RadioGroup`, `ColorField`                       | Labelled fields with hint, error and a managed-policy lock                                                                                                                                                        |
| `Dialog`                                                        | `aria-modal`, labelled, traps Tab, Esc, and backdrop close only on a press that starts and ends on the backdrop; returns focus to the opener (even one disabled while it worked)                                                                                                                            |
| `Menu`                                                          | Menu button or context menu (`at`), roving tabindex, arrows/Home/End/type-ahead, Esc; `checked` items are `menuitemcheckbox`                                                                                      |
| `PresetScale`                                                   | The Faster to Smarter preset control (FR-221): native radios in a fieldset, visible labels, optional trailing link                                                                                                |
| `Tree`                                                          | WAI-ARIA tree: one tab stop, Up/Down/Home/End, Right/Left expand and collapse, Enter activates, Space multi-selects; `expandable` branches load on demand and `expanded` lets the owner control open branches     |
| `Splitter`, `PaneGroup`                                         | Window splitter (`role="separator"` with its value and limits): arrows (Shift for bigger steps), Home/End, pointer drag; `PaneGroup` lays panes out in a row or column with a splitter between each pair (FR-005) |
| `Tabs`                                                          | One tab stop, arrow keys with automatic activation                                                                                                                                                                |
| `Tooltip`                                                       | Hover and focus; the pointer may move onto it; Esc dismisses it wherever focus is; linked with `aria-describedby`                                                                                                                                                    |
| `ToastProvider` / `useToast`                                    | Polite live region (errors assertive), optional action; auto-dismiss pauses while hovered or focused, and a toast with an action never times out                                                                                                                                              |
| `Spinner`, `EmptyState`, `VisuallyHidden`, `StatusChip`, `Icon` | Feedback; `StatusChip` is the FR-215 vocabulary                                                                                                                                                                   |
| `CodeBlock`, `highlight`                                        | Built-in highlighter for code artifacts (FR-038): tokens render as text, never HTML                                                                                                                               |

Locked fields (`SelectField`, `RadioGroup`, `ColorField`) render their lock note through
`LockNoteProvider`, linked to the control with `aria-describedby`; the web app's
`ManagedLockNotes` (`apps/web/src/managed/ManagedNote.tsx`) supplies a note that names the policy's
source, using the field's `setting` prop. Field edges use `--u-control-border` (3:1 in
every theme) and placeholders the muted text color (FR-015, `docs/04` §4.4).

The components' own words (status names, field locks and errors, the toast region, the preset
scale's ends, spoken key names) come from `@nova/i18n` (`UI_TEXT`, `KEY_TEXT` in
`src/strings.ts`) and follow the active locale; `Kbd` keeps the printed caps and names them in
the locale for assistive tech (FR-016).

Motion tokens drop to 0 ms under `prefers-reduced-motion` or `data-motion="reduce"` on the root;
`data-motion="full"` restores them when the user turns reduced motion off.

## Right-to-left (FR-016)

The layout rules are `docs/04` §4.5; the messages and locales are §4.6.


- Styles use logical properties only (`margin-inline-start`, `inset-inline-end`, `text-align:
  start`, `border-start-end-radius`); `apps/web/test/rtl-css.test.ts` fails on a physical left or
  right in any stylesheet or inline style unless it is allowlisted there with its reason.
- `Icon` mirrors the direction-bearing icons listed in `MIRRORED_ICONS` (back, forward, undo,
  redo, the sidebar and inspector toggles, split right) where the text runs right to left, through
  one rule in `tokens.css`; `mirror` overrides it per use. Every other icon keeps its drawing.
- `code`, `pre`, `kbd` and `samp` stay left to right, isolated from surrounding text; `CodeBlock`
  and `Kbd` also carry `dir="ltr"`, and `TextField` takes `dir="auto"` so typed text follows its
  own direction.
- `rovingIndex` (horizontal lists and tabs), `Tree` and `Splitter` swap Left and Right in
  right-to-left (`readingDirection(el)`), so the arrow keys and drags follow what the user sees.
