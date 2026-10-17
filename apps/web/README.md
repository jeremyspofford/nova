# @nova/web

The web UI (FR-125), served by the Hub and installable as a PWA. `npm run dev -w @nova/web` runs
Vite with the API proxied to a local Hub.

## Layout

| Path | What it is |
| --- | --- |
| `src/App.tsx` | Root: Hub connection, first-run setup code, sign-in, then the workspace and its stores |
| `src/shell/` | Workspace (sidebar, main, inspector, top bar with the bottom-panel toggle and Layout menu, global commands and key handler) and Sidebar; live status chips and "Go to the next item that needs input" (`SidebarStatus.ts`), active Work runs in the sidebar (`SidebarRuns.tsx`) |
| `src/chat/` | Chat view, composer (slash-command list and suggested follow-ups in `slash.ts`), thread list, search, Markdown, attachment checks, thread state reducer, MCP Apps under tool cards (`tool-apps.tsx`); M5: the run card for `work.start` (`RunCard.tsx`), the question card for `ask_user` (`UserAskCard.tsx`), document previews in `Artifacts.tsx`, and `embedded` / `composerAccessory` props so a Code session can host the chat |
| `src/layout/` | The pane layout tree (`model.ts`: split, move, maximize, close, reset; 12 panes, 6 levels), per-mode save and restore in `workspace.layout` (`useLayouts.ts`), and `PaneWorkspace.tsx` / `panes.tsx`, which render pane contents into movable elements so a layout change never remounts them (FR-005) |
| `src/terminal/` | Bottom panel and terminal panes (FR-006): terminal sessions over `/terminals/:id/ws` (`input`/`resize` out, `output`/`exit`/`error` in), reconnect, tabs; xterm.js loads in its own chunk on first use |
| `src/files/` | File browser (the Inspector's Files tab), editor (line numbers, undo, Ctrl/Cmd+S, conflict and approval handling) and preview with "Open with" for file apps (FR-039) |
| `src/apps/` | MCP Apps (FR-198): the JSON-RPC bridge (`bridge.ts`), display modes and the one picture-in-picture slot (`display.ts`), the App frame (`McpAppFrame.tsx`) and the Apps page, the Inspector's Apps tab and file apps (`AppsView.tsx`) |
| `src/work/` | Work mode (M5, FR-051..FR-057, FR-181, FR-182, FR-186, FR-187, FR-220): the run list and New run dialog (`WorkList.tsx`, `NewRunDialog.tsx`), the run page with budget meters and the budget banner, goal panel, plan card, sub-agents, result card, read-only conversation and Activity trace (`RunPage.tsx`, `GoalPanel.tsx`, `PlanCard.tsx`, `ResultCard.tsx`, `RunConversation.tsx`, `ActivityTrace.tsx`, `ExtendBudgetDialog.tsx`), Scheduled with its dialog and history (`ScheduledView.tsx`, `ScheduleDialog.tsx`, `schedule-when.ts`), the shared Work event stream (`events.ts`) and the palette commands (`commands.ts`) |
| `src/code/` | Code mode (M5, FR-061..FR-066, FR-069, FR-074): the session list and New session dialog, the session view with the conversation beside its Diff, Review, Terminal and File tabs (`SessionView.tsx`), the mode selector and its availability rules (`ModeSelect.tsx`, `modes.ts`), the diff with hunk decisions and batched comments (`DiffPane.tsx`, `diff.ts`), the review card (`ReviewPane.tsx`), the commit dialog (`CommitDialog.tsx`), session terminals and exec sessions (`TerminalPane.tsx`), Go to symbol (`SymbolSearch.tsx`) |
| `src/library/` | Library (FR-041): one paged list filtered by kind and searched by title |
| `src/projects/` | Projects, sources and local project folders with indexing status (`ProjectFolders.tsx`, FR-035) |
| `src/settings/` | Settings pages: General (with Work runs), Profile & usage, Accounts, Models, Memory, Tools & MCP (with bundle install and OAuth), Code (`CodePage.tsx`), Plugins & skills (plugins, catalogs, install preview, skills, hooks), Apps & clients, Permissions, Notifications, Devices, Appearance (with theme export and import), Keyboard, Import, Diagnostics |
| `src/onboarding/` | First-run wizard, the bundled sample document and a link to Import |
| `src/providers/` | Provider connect-and-test form shared by onboarding and Settings |
| `src/api.ts` | Typed client for the Hub endpoints (`@nova/shared` api types) |
| `src/sse.ts` | Typed EventSource helper: named events, de-duplication, reopen after `?after=` |
| `src/commands.ts`, `src/keys.ts`, `src/workspace-commands.ts` | Command and shortcut registry (FR-003, FR-004): bindings, when-clauses, conflicts, browser-reserved keys and their Alt variants; the navigation commands |
| `src/router.ts` | History API routes: `/chat`, `/chat/:id`, `/work`, `/work/:id`, `/work/scheduled`, `/code`, `/code/:id`, `/agents`, `/projects`, `/projects/:id`, `/library`, `/apps`, `/apps/:id`, `/settings/:section`, `/onboarding`, `/open?url=` |
| `src/deeplinks.ts` | `nova://` and `web+nova://` links mapped to routes, including `nova://theme?data=` (FR-007, FR-011) |
| `src/settings.tsx`, `src/stores.tsx` | Mirrors of Hub settings, threads and models (the Hub stays the source of truth) |

## Behavior notes

- Modes stay mounted while hidden, so switching keeps each mode's selection, scroll and drafts.
- Key bindings are stored in `keyboard.bindings` with `mod` (Cmd on macOS, Ctrl elsewhere). In a
  plain browser tab, keys the browser reserves (Ctrl+N, Ctrl+J, Ctrl+`, Ctrl+1..9, …) are shown
  as their Alt variant (docs/04 §5); the installed PWA uses the defaults.
- Streaming text arrives as ephemeral `chat.delta` events; the stored message is refetched after
  `chat.message.completed`. A failed send puts the text and attachments back in the composer.
- API keys typed in onboarding or Settings go straight to `POST /providers` and are never stored
  in the browser.
- The pane layout is read once from `workspace.layout` and written 300 ms after a change. While a
  terminal has focus, only the panel toggle, the terminal toggle and Ctrl+Shift+P reach the app.
- An MCP App runs in an iframe sandboxed to scripts only. Its tool calls go to the Hub with
  `initiator: 'app'` (no user authority), approval cards render in Nova's chrome, and state the
  app marks private (`_meta["nova/private"]`) never leaves the browser. A chat's apps live at
  shell level, so switching Inspector tabs never stops them (ADR-091).
- A user message started by a stop hook is labelled "Hook", never "You".
- Work and Code load only while their mode is on screen (the shell keeps every mode mounted).
  Every Work view and card follows one shared global event stream (`run.*`, `goal.*`,
  `schedule.*`, `request.*`, `thread.status.changed`, `approval.*`); Code views reload on
  `code.*` events and after each turn of the session.
- Status chips come from the Hub's derived status and stay live from `thread.status.changed`;
  lists sort Needs input, Blocked, Running, Ready. `status.nextNeedsInput` (Ctrl/Cmd+Alt+A)
  cycles through chats and runs that wait on the user (ADR-092 notes its clash with the native
  shell's global key).
- The Code mode selector explains why Auto (no reviewer model) or Bypass (no container or VM
  environment, or `code.allowBypass` off) cannot be picked; the Hub enforces the same rules. A
  user message started by a run, schedule, goal or sub-agent shows that origin, never "You".

## Tests

`npm test` in `apps/web` (jsdom, a fake Hub, fake EventSource, WebSocket and terminal screen in
`test/fakes*.ts`; no network). `npm test -- --coverage` enforces 70 % line coverage.
