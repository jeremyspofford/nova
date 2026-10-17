# @nova/ui

The design system (`docs/04` §4): CSS tokens (`tokens.css`), built-in themes that pass WCAG 2.2 AA
contrast checks, theme merge/apply helpers, color helpers (`mixHex`, `readableOn`, `contrastRatio`)
and accessible components. Components use tokens only; a test fails on hard-coded colors in
`src/components/`.

| Component | Notes |
| --- | --- |
| `Button`, `IconButton`, `TextField`, `Kbd`, `Switch` | Foundation primitives |
| `SelectField`, `RadioGroup`, `ColorField` | Labelled fields with hint, error and a managed-policy lock |
| `Dialog` | `aria-modal`, labelled, traps Tab, Esc and backdrop close, returns focus to the opener |
| `Menu` | Menu button or context menu (`at`), roving tabindex, arrows/Home/End/type-ahead, Esc |
| `Tabs` | One tab stop, arrow keys with automatic activation |
| `Tooltip` | Hover and focus, Esc dismisses, linked with `aria-describedby` |
| `ToastProvider` / `useToast` | Polite live region (errors assertive), optional action, auto-dismiss |
| `Spinner`, `EmptyState`, `VisuallyHidden`, `StatusChip`, `Icon` | Feedback; `StatusChip` is the FR-215 vocabulary |

Motion tokens drop to 0 ms under `prefers-reduced-motion` or `data-motion="reduce"` on the root;
`data-motion="full"` restores them when the user turns reduced motion off.
