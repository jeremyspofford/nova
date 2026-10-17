# @nova/web

The web UI (FR-125), served by the Hub and installable as a PWA. `npm run dev -w @nova/web` runs
Vite with the API proxied to a local Hub.

## Layout

| Path | What it is |
| --- | --- |
| `src/App.tsx` | Root: Hub connection, first-run setup code, sign-in, then the workspace and its stores |
| `src/shell/` | Workspace (sidebar, main, inspector, global commands and key handler) and Sidebar |
| `src/chat/` | Chat view, composer, thread list, search, Markdown, attachment checks, thread state reducer |
| `src/settings/` | Settings → General, Accounts, Appearance, Keyboard |
| `src/onboarding/` | First-run wizard and the bundled sample document |
| `src/providers/` | Provider connect-and-test form shared by onboarding and Settings |
| `src/api.ts` | Typed client for every M1 Hub endpoint (`@nova/shared` api types) |
| `src/sse.ts` | Typed EventSource helper: named events, de-duplication, reopen after `?after=` |
| `src/commands.ts`, `src/keys.ts` | Command and shortcut registry (FR-003, FR-004): bindings, when-clauses, conflicts |
| `src/router.ts` | History API routes: `/chat`, `/chat/:id`, `/work`, `/code`, `/agents`, `/settings/:section`, `/onboarding` |
| `src/settings.tsx`, `src/stores.tsx` | Mirrors of Hub settings, threads and models (the Hub stays the source of truth) |

## Behavior notes

- Modes stay mounted while hidden, so switching keeps each mode's selection, scroll and drafts.
- Key bindings are stored in `keyboard.bindings` with `mod` (Cmd on macOS, Ctrl elsewhere). In a
  plain browser tab, keys the browser reserves (Ctrl+N, Ctrl+1..9, …) are shown as their Alt
  variant (docs/04 §5); the installed PWA uses the defaults.
- Streaming text arrives as ephemeral `chat.delta` events; the stored message is refetched after
  `chat.message.completed`. A failed send puts the text and attachments back in the composer.
- API keys typed in onboarding or Settings go straight to `POST /providers` and are never stored
  in the browser.

## Tests

`npx vitest run` (jsdom, a fake Hub and a fake EventSource in `test/fakes.ts`; no network).
`npx vitest run --coverage` enforces 70 % line coverage.
