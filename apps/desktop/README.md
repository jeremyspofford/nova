# @nova/desktop

The desktop shell (ADR-001): an Electron client of the Hub, never the Hub itself (ADR-031). It
shows the Hub's own web UI in native windows and adds what a browser tab cannot: a tray icon
with a quick overlay (FR-008), windows of their own for any thread or panel (FR-009), attach
window (FR-214), global shortcuts, `nova://` links and OS notifications.

```bash
npm run build -w apps/web              # the Hub serves the web UI
node apps/hub/src/main.ts              # a Hub to connect to
npm start -w apps/desktop              # the shell (Electron runs src/main.ts with type stripping)
npm test -w apps/desktop               # unit and integration tests (Vitest, coverage floor 70 %)
npm run test:shell -w apps/desktop     # the Playwright Electron journey (xvfb-run on headless
                                       # Linux; --no-sandbox only inside a container)
```

`NOVA_SHELL_DATA_DIR` puts the shell's data (settings, the Hub session's cookies) in another
folder; by default it is the platform's per-user folder for "Nova".

## Connecting to the Hub (FR-134, `docs/22` §5)

First run asks for the Add Device link (Devices, Add a device, Client: the QR link or the
`nova://add-device?h=…&p=…&fp=…#c=…` link) or for the Hub address and its fingerprint. Before anything
is sent the shell opens TLS without trusting it, keeps the presented chain, asks
`GET /api/v1/trust/identity?nonce=<fresh 192-bit nonce>` on that same connection and checks the
statement (`src/pinning.ts`, a copy of `checkHubIdentity` in `@nova/core`): the key hashes to the
pin, the signature verifies, the nonce is its own, and the leaf is listed or is a server
certificate for the dialed host from the listed CA. With pinning off (signed) the platform roots
decide. Plain HTTP is used only for a Hub on this computer (loopback), where the statement is
still checked. A refusal says why and that nothing was sent.

Afterwards the Hub windows' session accepts the Hub's certificate only as that statement vouched
for (`setCertificateVerifyProc`); an unknown leaf (a renewal) triggers the check again with a new
nonce. The address, the pin and the CA hash are kept in `shell.json`. A first Hub, or another
identity even at the same address, starts from an empty session: storage, cache, credentials and
open connections are cleared before anything loads. Replacing the Hub (an Add Device link for
another Hub, or Change Hub) asks for an explicit confirmation naming the current Hub and the new
address and fingerprint before the new Hub is contacted.

## Windows

- **Hub windows** use their own partition (`persist:nova-hub`) with `contextIsolation`,
  `sandbox`, no Node integration and no `<webview>`. Navigation stays on the Hub's origin
  (`src/allowlist.ts`), and the top level shows app pages only, never the Hub's API (it serves
  untrusted previews and app UIs); web links open in the system browser (rate limited; mail
  links lose their query); every other request is cancelled. Only the top frame whose real origin
  is the Hub's (a sandboxed document reports `null`) gets the bridge and permissions: the
  clipboard, fullscreen and the microphone (never the camera); OS notifications are the shell's,
  so the page's own Notification permission is denied.
- **`window.novaShell`** (preload `src/preload/hub.js`, `NovaShellBridge` in `@nova/shared`):
  `version`, `platform`, `openWindow(path)` (only app routes, `src/routes.ts`), `shortcuts()`,
  `setShortcut(action, accelerator)` and `localRuntime` (below). The channels are listed in
  `contracts/ipc-channels.md` ("As built in M7"). `src/routes.ts` mirrors
  `apps/web/src/router.ts`, M7 sections, `/team` and `/approvals` included.
- **The shell's own pages** (`src/renderer`: connect, quick chat, attach preview) load only
  their files and talk to the main process through `window.novaLocal`, an allowlist of channels.
  Every payload is validated in the main process (`shell*Schema` in `@nova/shared`), and each
  channel checks which page is asking.

## Tray, quick chat and shortcuts (FR-008, FR-215)

The tray icon is drawn in code (`src/glyph.ts`; a template image on macOS, an amber badge when
something needs input). Its menu and the quick overlay show Quick chat, New task, Attach window,
the status list from the Hub (chats, Work runs, Code sessions and agents, Needs input first) and
Open Nova and Quit. Quick chat sends to the chat open in the last used window or to a new chat.

Global shortcuts (`src/shortcuts.ts`): Ctrl+Alt+N / ⌃⌥N opens the quick overlay (again: Nova),
Ctrl+Alt+A / ⌃⌥A attaches the frontmost window. A global key needs two modifiers besides Shift and
never takes one the system uses (Ctrl+Alt+Delete, Ctrl+Alt+T, workspace and console keys, force
quit). A key another app holds is reported (tray menu,
quick overlay, `novaShell.shortcuts()`), never forced; both can be remapped or unbound.

## Attach window (FR-214)

The shortcut, the tray or the overlay captures the frontmost window: a screenshot through
`desktopCapturer` and its accessibility text.

- **Which app (fail closed):** the app behind the window is named per platform
  (`src/capture/identity.ts`): AT-SPI with the process from the bus and `/proc`, X11 through
  `xprop`, Windows through PowerShell and user32, macOS through System Events. A window whose app
  cannot be named is not captured. Excluded apps (`attach.excludedApps` in `shell.json`, empty by
  default and not editable in the UI yet) match the app name, the process or bundle id, and the
  window title; Nova's own windows (by name or process) are never captured.
- **That very window:** the screenshot is the capture source with the window's id where the
  platform gives one (X11, Windows), else the one source with exactly its title; anything
  ambiguous attaches no image.
- **Text:** on Linux it comes from AT-SPI over D-Bus through the `gdbus` CLI
  (`src/capture/atspi.ts`), including text scrolled off screen; password fields are never read.
  macOS and Windows say that text is not offered yet.
- **Redaction:** the text and the title are redacted with the default rules of `@nova/security`
  in a utility process with a 5 s limit; text not checked in time is left out.

The preview shows the image and the text as separate parts the user can drop; nothing is sent
until Send, and then the parts go to the current or a new chat as message attachments.

## Links and notifications

`nova://` links (`src/deeplinks.ts`, `docs/04` §5.1 and ADR-095 decision 7: `run/<id>`,
`code/<id>`, `approval/<id>`, `chat/<id>?m=`, …) go to the window already at that place, else the
last used one. An Add Device link for another Hub opens the connect page filled in; the user
confirms. An installed build registers `nova://` with the OS; a development run does not.

The shell reads the Hub's event stream and raises an OS notification for each
`notification.created` whose `os` flag is true (the Hub folds in the category rule and quiet
hours); clicking it opens its place.

## Local models while the Hub is away (FR-128)

`window.novaShell.localRuntime` (`NovaShellLocalRuntime` in `@nova/shared`) gives the web UI
`models()` and a streaming `chat()`. The main process talks to this computer's `novad`
local-runtime module (`src/local-runtime.ts`); the page never sees the socket, the token or the
address. It looks, in order, at `localRuntime` in `shell.json` (or `NOVA_LOCAL_RUNTIME_SOCKET`,
`NOVA_LOCAL_RUNTIME_URL` with `NOVA_LOCAL_RUNTIME_TOKEN_FILE`; only a loopback address), else the
per-user socket a system `novad` offers in the user's runtime folder
(`$XDG_RUNTIME_DIR/nova/runtime.sock`, on macOS `~/Library/Application Support/Nova/run/`), then
`novad`'s own `/var/lib/nova/local-runtime/runtime.sock`. It refuses with a reason: `no_novad`,
`no_access` (novad runs as another user), `scope_missing` (the Hub has not granted Local models),
`no_model_server`, or `failed`.

When the remembered Hub is unreachable at start, the shell still opens its window: the web UI
runs from its offline copy (its service worker). Every request to the Hub waits (`src/hold.ts`: at
most 64, 8 s each) while the shell checks the Hub at once; it goes out when the check passes, and
fails when the Hub is unreachable, the wait runs out or the queue is full (logged with the reason),
so the page falls back to its offline copy. The Hub is checked again every 15 s; once it passes,
the windows reload. Any other refusal (a wrong identity) shows the connect page instead.

## Known limitations

Window text on macOS and Windows, voice in quick chat and redaction of the screenshot are not
built; the macOS and Windows window identity (System Events, PowerShell) is unit-tested only; on
Wayland the screenshot may be missing; Electron fuses, installers, signing and the shell's own
updates are not built; the journey runs only on Linux.
