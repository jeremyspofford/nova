# @nova/ui

The design system (`docs/04` §4): CSS tokens (`tokens.css`), built-in themes that pass WCAG 2.2 AA
contrast checks, theme merge/apply helpers, color helpers (`mixHex`, `readableOn`, `contrastRatio`)
and accessible components. Components use tokens only; a test fails on hard-coded colors in
`src/components/`.

| Component                                                       | Notes                                                                                                                                                                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`, `IconButton`, `TextField`, `Kbd`, `Switch`            | Foundation primitives                                                                                                                                                                                             |
| `SelectField`, `RadioGroup`, `ColorField`                       | Labelled fields with hint, error and a managed-policy lock                                                                                                                                                        |
| `Dialog`                                                        | `aria-modal`, labelled, traps Tab, Esc and backdrop close, returns focus to the opener                                                                                                                            |
| `Menu`                                                          | Menu button or context menu (`at`), roving tabindex, arrows/Home/End/type-ahead, Esc; `checked` items are `menuitemcheckbox`                                                                                      |
| `PresetScale`                                                   | The Faster to Smarter preset control (FR-221): native radios in a fieldset, visible labels, optional trailing link                                                                                                |
| `Tree`                                                          | WAI-ARIA tree: one tab stop, Up/Down/Home/End, Right/Left expand and collapse, Enter activates, Space multi-selects; `expandable` branches load on demand and `expanded` lets the owner control open branches     |
| `Splitter`, `PaneGroup`                                         | Window splitter (`role="separator"` with its value and limits): arrows (Shift for bigger steps), Home/End, pointer drag; `PaneGroup` lays panes out in a row or column with a splitter between each pair (FR-005) |
| `Tabs`                                                          | One tab stop, arrow keys with automatic activation                                                                                                                                                                |
| `Tooltip`                                                       | Hover and focus, Esc dismisses, linked with `aria-describedby`                                                                                                                                                    |
| `ToastProvider` / `useToast`                                    | Polite live region (errors assertive), optional action, auto-dismiss                                                                                                                                              |
| `Spinner`, `EmptyState`, `VisuallyHidden`, `StatusChip`, `Icon` | Feedback; `StatusChip` is the FR-215 vocabulary                                                                                                                                                                   |
| `CodeBlock`, `highlight`                                        | Built-in highlighter for code artifacts (FR-038): tokens render as text, never HTML                                                                                                                               |

Motion tokens drop to 0 ms under `prefers-reduced-motion` or `data-motion="reduce"` on the root;
`data-motion="full"` restores them when the user turns reduced motion off.
