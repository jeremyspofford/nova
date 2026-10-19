# @nova/extension

Nova's browser extension (Manifest V3) for Chromium-family browsers: it lets your Nova agents act
in tabs **you share**, on sites **you allow**, through `novad` on the same computer (FR-096,
docs/11 §4.3). It is also how an agent continues a site in your own browser when the site blocks
the agent's browser and you choose so (the local browser fallback, FR-209, docs/11 §4.6).

## How it connects

```
extension  --native messaging-->  novad bridge-host  --per-user socket-->  novad  --device link-->  Hub
```

- The native host `ai.nova.bridge` exists only after you run `novad bridge enable` (and goes with
  `novad bridge disable`). It accepts only this extension's id (`bridge.extensionId` in novad's
  configuration). No third-party relay is involved.
- Messages (4-byte length + JSON, at most 1 MiB): the host sends `{type: "status", connected,
  reason}` first and then `{type: "call", id, method, params}`; the extension answers
  `{type: "result", id, result}` or `{type: "error", id, error: {code, message}}` and reports
  `{type: "event", event}` with the kinds `tab.shared`, `tab.unshared`, `tab.closed`,
  `host.granted` and `host.revoked`. novad reports `connected` and `disconnected` itself.
  `tab.shared` is `{tabId, host, title?, origin?: "shared"|"agent"}`: hosts only, never full URLs.
- After every (re)connection the extension reports the shared tabs, the tabs the agent opened
  (`origin: "agent"`) and the granted sites again.

## What it can and cannot do

- **Tabs:** the agent sees and acts only in tabs you shared from the popup and the tabs it opened
  itself, which live in a tab group named "Nova". Every such tab has a "NOVA" badge; a tab the
  agent controls also shows the browser's own "is debugging this browser" banner. Cancelling that
  banner, closing the tab or choosing "Stop sharing" ends the consent at once.
- **Sites:** the extension starts with no access to any site. Sharing a tab asks the browser for
  that one site. The agent acts only on pages of sites the browser granted and navigates only to
  them; the Hub also needs your confirmation for each site (Settings, the device's extension
  bridge), and "all sites" is a separate grant there with its own confirmation.
- **Methods:** only the DevTools commands the Hub's page reader and actions need pass
  (`Runtime.evaluate`, `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`,
  `Page.navigate`, `Page.captureScreenshot`). `Runtime.evaluate` runs only one of the
  extension's own 13 named page scripts (`src/scripts.ts`), never an expression sent from
  upstream, and each script returns nothing on another host. Every call names the host it
  expects; a tab that is somewhere else, or navigating there, is refused (`host_changed`). Key
  and mouse events may carry Shift only: Ctrl, Alt, Meta and editor `commands` are refused (no
  paste from your clipboard).
- **Never:** the extension has no `cookies` permission and never reads cookies, passwords, tokens
  or page storage for export.
- **History:** no standing permission. Each search opens a prompt; only your "Allow this search"
  asks the browser for history access, which the extension removes right after the search.
  Results carry `{title, host, lastVisit}`, never full URLs.

## Build and load

```sh
npm run build            # dist/: compiled scripts, manifest, pages, icons
```

Load `apps/extension/dist` as an unpacked extension (Developer mode), note its id, and set it as
`bridge.extensionId` in novad's configuration before `novad bridge enable`. The icons are drawn
by `scripts/icons.mjs` (our own shape, no third-party asset).

## Layout

- `src/bridge.ts`: the background logic (consents, calls, events, history prompt), written
  against the `chrome.*` subset typed in `src/chrome.ts`.
- `src/protocol.ts`: the host messages, the allowed methods and small helpers.
- `src/background.ts`, `src/popup.ts`, `src/prompt.ts`: the entry points and the two pages.
- `test/`: the logic against a fake `chrome.*` API (`npm test`).
