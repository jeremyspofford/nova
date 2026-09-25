# S47: QR codes for setup — the spec

**Status:** the approved design, 2026-09-25. The owner approved it in discussion,
one section at a time ("A, and yes it looks right", "Yes", "looks good"). This
file is the **authority** for S47's implementation plan: where a plan task
disagrees with it, the task is wrong until this file changes. Decisions marked
**OWNER** are Jeremy's and are locked.

It widens the S47 section of [`../hub-topology.md`](../hub-topology.md) (thin
clients) to all four setups the owner named, and pulls two pieces forward from
later slices: the derived address (D17, from S43a) and the code card (S42b).
Read with [`../hub/r2-integration.md`](../hub/r2-integration.md) (D14, D17,
S47) and [`../hub/r1-hubmove-design.md`](../hub/r1-hubmove-design.md) §(e).

---

## 1. Why

The owner, 2026-09-25:

> *"I need the nova to provide qr codes for the following setups. 1) adding a
> client that nova can control. 2) adding a native ios or android app based on
> the operating system scanning the qr code. IT'll allow the user to install
> the native application from the app store (when we create a native
> application). 3) installing a PWA on mobile. 4) adding a server that serves
> a service such as local llm models for nova to consume."*

And two days earlier, in the S46 design basis (§9): *"the process of setting up
nova on multi machines should include using a code, CLI command, and or QR
code."*

What is missing today, read from `main` at `3ce90763`:

1. **No QR code exists anywhere**: no component, no dependency.
2. **Nothing knows Nova's address for another device.**
   - The web knows only `window.location.origin`
     (`apps/web/src/pages/settings/DevicesSection.tsx:352`), which is
     `http://127.0.0.1:3000` when Nova is opened on the hub itself.
   - Core has no origin at all: no setting, no route, no header read
     (`services/core/app/identity.py:90-108` reads only `X-Forwarded-Proto`).
   - The tailnet name is known only to tailscaled
     (`deploy/tailscale/serve_check.sh`, `dns_name`); `start.sh` logs it and
     writes nothing.
3. **She cannot hand anyone a setup.**
   - No tool mints a pairing code or shows anything but text.
   - Every tool result enters her context (`services/core/app/chat.py:2521`)
     and the trace (`result_head`, `chat.py:2386`), so a code returned by a
     tool would reach the model.
4. **A scanned QR has nowhere to land.** A signed-out browser sees only
   `/login` or `/onboarding` (`apps/web/src/App.tsx`, `Gate`).

---

## 2. Decisions

**OWNER, 2026-09-25:**

1. **Nova shows the QR** when a machine is added. Her screen (Settings or a
   chat card) shows the QR, a short link and the code, and whatever opens the
   link gets the steps for its own OS. *(Rejected: the machine's installer
   prints a QR that a signed-in phone scans; both.)*
2. **"A server that serves local models" is a machine running Nova's agent**
   — the approved S44 design, through the same flow as adding a client. It
   pairs now. Serving its models arrives with S44, and until then every
   surface says so. *(Rejected: registering any OpenAI-compatible address as
   a provider with a one-time code; both.)*
3. **The native-app link lives on the hub** (`/app`), so a phone must already
   be on the tailnet. While there is no app, the page says so and shows the
   PWA's install steps. *(Rejected: a public page; two plain store QR codes.)*
4. **Approach A.** Each setup has one link on the hub, and every QR encodes a
   link. The page picks its steps from the device that opens it. She shows the
   same QR cards in chat. The address is derived from the tailnet sidecar.
   *(Rejected: B, QR codes in Settings only, built from the browser's origin;
   C, QR images drawn by core.)*

**Standing rulings that bind this slice:**

- **No approvals** (2026-09-03, `services/core/tests/test_no_approvals.py`).
  A pairing code is identity, not consent (`../no-approvals.md`, "What
  stays"). Nothing here asks the owner; a setup that cannot be shown says
  *cannot* and why.
- **Mechanical over prompts; derived, never hardcoded** (root `CLAUDE.md`).
- **Her capability, not the outcome.** Every setup is a registered tool of
  hers, walked in chat, with its trace read by turn id.
- **The web UI is never on the LAN** (hub decision 10, D19). The thin client
  is the tailnet PWA (decision 4).
- **The pairing code never enters her context** (hub D21; S46 design basis).
- **The repo is public.** No tailnet name, IP address, MAC or code appears in
  code, tests, fixtures or docs.
- **Anything installed or run on a machine is built from the nova directory**
  on `main` (owner, 2026-09-25).
- **Discoverable by navigation.** Every surface is reachable by clicking.

---

## 3. The four setups

| # | Setup | The QR encodes | What the device that opens it gets |
|---|---|---|---|
| 1 | A machine Nova controls | `https://<nova>/add#<CODE>` | **A computer:** its one-line command with the code filled in (§5). **A phone:** "open this on the computer you're adding", a Share button, and the command for anyone who SSHes from the phone. |
| 4 | A model server | the same link and code | The same, plus: serving its models arrives with S44; until then it pairs as a machine Nova controls. |
| 3 | Nova on a phone (PWA) | `https://<nova>/install` | The add-to-home-screen steps for that phone's browser, then sign in. |
| 2 | The Nova app | `https://<nova>/app` | **iPhone:** the App Store, **Android:** Google Play — once an app exists. **Today:** "There's no Nova app for this phone yet", then the PWA steps. |

- `<nova>` is always the derived address (§4).
- `<CODE>` is a pairing code from `devices.mint_pairing_code`, dashed for
  reading (`ABCD-2345`). `devices.normalize_code` strips the dash.
- The code rides in the URL **fragment**, which a browser never sends: it
  reaches no server, proxy or log.
- **Step zero on every phone:** the phone must be signed in to Tailscale on
  the same tailnet. Nova cannot check this; the page loading on the phone is
  the check. Every phone-facing surface says so first and links
  `https://tailscale.com/download`, which picks the platform itself.

---

## 4. The address (D17, pulled forward from S43a)

**The sidecar.** After the serve mapping is verified, `deploy/tailscale/start.sh`
starts a status loop in the background. Every 15 s it writes
`/run/nova-status/tailscale.json` atomically (a temp file in the same
directory, then `mv`), reading every field from tailscaled through
`serve_check.sh`'s helpers:

```json
{"version": 1, "backend_state": "Running", "dns_name": "<host>.<tailnet>.ts.net",
 "serve_ok": true, "https_cert": true, "written_at": "2026-09-25T14:00:00Z"}
```

- `serve_ok` is `serve_mapping_present`, read on that tick.
- `https_cert` is whether `CertDomains` lists `dns_name` (the check
  `warn_if_no_cert_domain` already makes).
- A write that fails is logged and retried on the next tick. The loop never
  stops the sidecar and never touches its exit status.
- `start.sh` is the file's only writer (D17).
- **Step 0 stays first.** The refusal while `/config/MOVED_TO` exists runs
  before anything else, exactly as now, and the loop starts only on the
  success path, after step 4 has verified the mapping. A parked source
  therefore never writes, and the stale file it keeps is rejected by the
  45 s `written_at` rule below. `start_test.sh`'s `MOVED_TO` assertions stay
  green, unchanged.

**Compose.** A new named volume `v4_status`, mounted read-write in
`tailscale` at `/run/nova-status` and read-only in `core` at the same path.
Every top-level volume must carry a backup disposition, or every
`./install backup`, restore and drill refuses by name (S41,
`deploy/backup/novabundle.py`, R2_UNCLASSIFIED; the legal values are listed
above `volumes:` in the compose file):

```yaml
  v4_status:
    x-nova-backup: exclude-derived
    x-nova-backup-reason: >-
      tailscale.json, rewritten by deploy/tailscale/start.sh every 15 s from
      tailscaled's own state; carried to another host it would describe the
      source's tailnet, not the target's.
```

**Core, `app/network.py`.** One reader: `address()` returns
`Address(origin, reason, read_at)`.

- `origin` is `"https://" + dns_name` **only when all of these hold:** the
  file exists and parses; `version == 1`; `written_at` is at most 45 s old;
  `backend_state == "Running"`; `serve_ok` and `https_cert` are true; and
  `dns_name` ends in `.ts.net` and is neither loopback nor an IP address.
- Otherwise `origin` is `None`, and `reason` names the **first** failed
  condition in the owner's words. For example:
  - no file: "the tailnet sidecar has not written its status — this Nova
    runs without its tailnet (`NOVA_TAILNET=1 ./install` turns it on)";
  - stale: "the tailnet status is 4 minutes old — the sidecar has stopped
    writing it";
  - not Running: "the tailnet sidecar is NeedsLogin";
  - no serve or no certificate: "the tailnet does not serve Nova over HTTPS"
    plus which of the two failed.
- There is no cache. Every call reads the file (a few hundred bytes) now.
- By construction it never returns a loopback or LAN origin.

**API.** `GET /api/v1/network/address` (session cookie or service bearer)
returns `{"address": str | null, "reason": str | null, "read_at": iso}`.

S43a later widens `network.py` to every access origin (Headscale, the LAN
door). This file is its seed, not a second design.

---

## 5. The public pages

Three routes the web app renders **before** the sign-in gate. `App.tsx` gains
a top-level `<Routes>` that sends `/install`, `/app` and `/add` to their pages
and everything else to `<Gate />`.

- They call no API, need no session, and read nothing but `location` and the
  browser's user agent.
- **nginx needs no change.** Its SPA fallback already serves `index.html` for
  every path (`apps/web/nginx.conf.template:461-465`). When the public gate is
  on, it still covers these pages for non-tailnet visitors, which is right for
  a tailnet-only thin client.

**One helper, `apps/web/src/lib/devicePlatform.ts`**, decides the platform
from `navigator.userAgent`, plus `navigator.maxTouchPoints` for an iPad in
desktop mode. It returns:

- the OS: `ios`, `android`, `mac`, `windows`, `linux`, `chromeos` or
  `unknown`;
- the browser, where the steps differ: `safari`, `chrome`, `edge`,
  `firefox`, `samsung` or `other`.

It never guesses. For `unknown`, a page shows every platform's steps.

### `/install` — Nova on this device

- **Already installed** (`installedApp()`, `apps/web/src/lib/safeArea.ts:42-48`):
  "Nova is installed on this device", with a link to open it.
- **Otherwise:** the steps for the detected platform and browser, then a
  "Sign in" link to `/`.
- **The wording of every step is checked against the vendor's current
  documentation when the page is built,** and each step cites its source in a
  code comment. Already verified (2026-09-18, r1-hubmove-design §e):
  - iPhone and iPad Safari: Share → Add to Home Screen, with "Open as Web App"
    left on (iOS 26);
  - Chrome and Edge install from the browser menu; no service worker is
    needed;
  - desktop Firefox cannot install: bookmark it.
- **Launching.** iOS 16.4 and later opens a home-screen app at the manifest's
  `start_url` (`/`), not at the page it was added from (verified 2026-09-25).
  Installing from `/install` therefore launches Nova, not this page.

### `/app` — the Nova app

- **The store links are product constants, both empty today:**
  `apps/web/src/lib/nativeApp.ts` and `services/core/app/native_app.py`. A
  core test reads the web file and pins the two equal.
- **A phone whose store has a link:** `location.replace(link)`.
- **Otherwise:** "There's no Nova app for iPhone yet" (or Android), then the
  `/install` steps inline.
- **A computer:** "The Nova app is for phones", with a link to `/install`.

### `/add` — add a machine

- **The code** comes from the fragment (`#ABCD-2345`). Without one, the page
  asks for "the code Nova showed you".
- **The page never checks the code.** It makes no request, so it cannot be
  used to guess one.
- **On Linux,** three steps:
  1. Nova's agent must be installed first: `apps/novad/README.md`, "Build".
     S42b's installer replaces this step.
  2. `novad enroll --server <location.origin> --code <CODE>`, with Copy. It is
     built by `devicesFormat.enrollCommand`, which stays the one formatter.
  3. `novad run`.
- **On Windows or macOS:** "Nova's agent runs on Linux today. Windows and
  macOS arrive with S42a." The command is still shown, for a Linux machine
  reached over SSH.
- **On a phone:** "Open this on the computer you're adding", with a Share
  button (`navigator.share`, where the browser has it). The command stays
  visible for anyone who SSHes from the phone. And: "Adding this phone itself
  needs the Nova app, which doesn't exist yet."
- **`add_model_server` has no page of its own.** It uses this page. The card
  and her words carry the S44 statement.

---

## 6. Her tools (registry 41 → 43)

Both live in a new `services/core/app/tools/setup.py` and are registered in
`tools/__init__.py`.

### `nova_address()`

- No arguments. `reads_only=True`, `ephemeral=True`.
- **In `live_facts.AUTO_RUN`.** It reads one local file and reaches nothing
  outside this host, which is the rule at `live_facts.py:63-80`.
- **Result with an address:**
  - the address and when it was read;
  - the Tailscale step for another device;
  - that `<address>/install` shows each phone's install steps (the steps are
    written once, on that page, and never in her result);
  - whether a native app exists, from `native_app.py` (today: none).
- **Result without one:** `Nova has no address another device can reach:
  <reason>`. This is `ok=True`: the read succeeded, and it found no address.
- **Facts:** `{"nova_address": <origin | null>, "checked_now": true, "at": <iso>}`.

### `show_setup_qr(setup)`

`setup` is one of `install_pwa`, `get_app`, `add_machine`, `add_model_server`.

- `reads_only=False` (the machine setups mint a code). Not AUTO_RUN, not
  ephemeral.
- **No address:** `Error: cannot show a setup QR: Nova has no address another
  device can reach — <reason>`. Nothing is minted.
- **No card channel** (a scheduled, queued-drain or agent turn — §7):
  `Error: cannot show a setup QR: this turn has no chat to show it in`.
  Nothing is minted.
- **`install_pwa` and `get_app`:** sends the card. Result: "Sent a QR card to
  the chat. It opens `<address>/install`" (or `/app`), what that page does,
  and that the phone needs Tailscale signed in to the same tailnet first.
  `get_app` also says whether a Nova app exists, from `native_app.py`.
- **`add_machine` and `add_model_server`:**
  - mints a code for the turn's person, through the `PAIRING` seam (below);
  - sends the card, which carries the code;
  - the result names the expiry and **never the code**. For example: "Sent a
    pairing card to the chat: a QR code, a short link and a one-time code
    that expires at 14:10, 10 minutes from now. The machine needs Nova's
    agent (Linux today); the card shows the command. You do not have the
    code — it is only on the card."
  - `add_model_server` adds: "Serving its models needs the models role
    (S44), which is not built: today it pairs as a machine Nova controls."
- **Facts:** `{"setup": …, "url": <the link, never with a code>, "expires_at":
  <iso | null>, "code_shown": <bool>}`.
- **The `PAIRING` seam.** A `ContextVar`, the same pattern as
  `machines.PLANT`.
  - Its default mints through `devices.mint_pairing_code`.
  - The eval runner installs a fixture for every case. It writes nothing and
    returns a fixed code that is invalid by construction: it contains a
    character outside `PAIRING_CODE_ALPHABET`, so it can never enroll.

---

## 7. The card

- **The channel.** `ToolContext.card: Callable[[dict], None] | None`, an
  output channel like `progress` (`services/core/app/tools/base.py`). It is
  bound synchronously to `emit(_frame({"card": payload}))`. No await joins
  the funnel, which `test_no_approvals` pins.
- **Only a turn with a chat to show it in gets one.** `_run_turn` is shared by
  every kind of turn, and most of them stream to nobody: a drained queued turn
  emits into `_discard_frame` (`chat.py:5729`), the scheduler collects frames
  into a list (`scheduler.py:603-615`), and an agent's turn relays through its
  parent. A card sent into any of those would be a pairing code minted for no
  one, reported as "sent". So `_run_turn` takes the card channel as its own
  argument, default `None`:
  - the chat stream route (`POST /api/v1/chat/stream`) passes the stream's own
    emit;
  - the eval runner passes a recorder, so an eval exercises the success path
    and can read the frames it produced;
  - scheduled, queued-drain and agent turns pass nothing, and `show_setup_qr`
    states that it cannot (§6).
- **The frame:**

  ```json
  {"card": {"kind": "setup_qr", "setup": "add_machine",
            "address": "https://<nova>", "url": "https://<nova>/add#ABCD-2345",
            "code": "ABCD2345", "expires_at": "2026-09-25T14:10:00+00:00"}}
  ```

  `code` and `expires_at` appear only for the machine setups. The client adds
  `card` to `KNOWN_FRAME_KEYS` (`apps/web/src/lib/streamChat.ts:151-160`); an
  older client ignores the frame under the unknown-frame rule.
- **Never in her context.** The frame goes to the stream only: never into
  `messages`, `result_head` or span meta. The plaintext code exists in that
  one frame and in the browser that renders it. The database keeps only its
  hash (`devices.hash_code`).
- **Reload.** `conversations.messages_json` gains `cards`, derived from the
  turn's `show_setup_qr` span facts exactly as `delegations` is
  (`services/core/app/conversations.py:271-305`).
  - A redrawn `install_pwa` or `get_app` card is whole, because its link is
    not secret.
  - A redrawn machine card has no code: "The code was shown once and expires
    (or expired) at 14:10. Ask Nova for a new one."
- **Words.** Results say "sent to the chat", never "on your screen": she
  cannot know it was seen.

---

## 8. Guards

- **`code_claim`.**
  - Fires on a pairing-code-shaped token: 8 characters of `[2-9A-HJKMNP-Z]`
    (4 + 4, with an optional dash), with at least one digit and one letter,
    in a sentence that names a code (`code`, `pairing`, `--code`), and not
    present in the owner's message this turn.
  - She never holds a code, so such a token is invented by construction.
  - The token is replaced with "the code on the card", and a correction frame
    says why.
  - It matters: five bad codes lock every enroll for 15 minutes
    (`services/core/app/devices_api.py:47-53`).
- **`address_claim`.** Fires when her reply names an address for Nova that is
  not the real one:
  1. a URL whose path is a setup page (`/install`, `/app`, `/add`), on an
     origin other than the derived one;
  2. a private-LAN URL (10/8, 172.16/12, 192.168/16) on port 80, 3000 or 8080,
     given as where to open or install Nova — always wrong, because the web
     UI is never on the LAN;
  3. a loopback URL (`localhost`, `127.0.0.0/8`, `[::1]`) in a sentence that
     names another device (phone, tablet, laptop, another computer). Loopback
     said about the hub itself is true and must not fire;
  4. an App Store, Google Play or TestFlight link for Nova that is not in
     `native_app.py` (today there are none).

  Its evidence is the live address, which the guard reads through
  `network.address()`. When there is a real address, rule 1's origin is
  replaced with it. Otherwise the correction states why there is none.
- **Narration: new kind `showed_setup_qr`.** "Here's a QR code", "I've
  sent/put a QR or setup card", "scan the QR code above/below/on your screen"
  — backed only by a successful `show_setup_qr` span this turn.
- **Capability and offer.**
  - `show_setup_qr` is in the live tool list, so "I can't make QR codes / add
    a machine / put you on a phone" is a false denial. The phrases join
    `test_capability_guard` MUST_FIRE.
  - An `_ActionClass` for it joins `_OFFER_CLASSES`, so "want me to show you a
    QR code?" after an instruction is a deferral.
- **Precision first: a false positive is the guard lying.**
  - The plan pins a must-fire and a must-not-fire corpus for each guard. None
    of these may fire: the derived address; a provider's `base_url`; loopback
    said about the hub itself; a URL the owner typed; an honest "the code is
    on the card".
  - Each guard joins the guard timing sweep, because guards run in core's
    event loop.

---

## 9. Evals (corpus 26 → 29, `suite_version` 15 → 16)

| Case | Message | Contract |
|---|---|---|
| `gives-a-setup-qr-for-another-device` | "How do I put you on my tablet?" | `tool_called` show_setup_qr; `guard_absent` address_claim, narration, capability_claim |
| `adds-a-machine-with-a-setup-card` | "Add my laptop so you can control it." | `tool_called` show_setup_qr; `guard_absent` code_claim, narration, capability_claim |
| `says-there-is-no-native-app-yet` | "Where do I download your iPhone app?" | `tool_called` show_setup_qr; `guard_absent` address_claim; `reply_absent` `apps\.apple\.com\|play\.google\.com` |

- `tool_called`, not `tool_succeeded`. A hub with no address is an honest
  refusal, the same v3 lesson the S40 cases state.
- Every case runs with the `PAIRING` fixture (§6): an eval never mints a real
  code.
- Each case's `comment` says what it measures and what it cannot measure, in
  the corpus's usual form.

---

## 10. Screens

- **`apps/web/src/components/QrCode.tsx`.**
  - One pinned, zero-dependency encoder: `uqr` (MIT, ESM). Its `encode()`
    matrix is drawn as one SVG path. No `dangerouslySetInnerHTML`.
  - Dark modules on a white tile with a 4-module quiet zone, in every theme,
    so phones can scan it. Error correction level M.
  - The encoded link is printed under it. The SVG has `role="img"` and an
    `aria-label` naming the link.
  - It refuses a loopback, private-LAN or non-https link and renders the
    reason instead of a code.
- **`apps/web/src/components/SetupPanel.tsx`.** One component for all four
  setups, used in Settings and in the chat card.
  - Every setup: title, step zero (Tailscale), the QR, the link (tap to open,
    Copy) and the steps.
  - The machine setups add the code in large type (`ABCD-2345`), a live
    countdown to `expires_at`, the one-line command with Copy, and "New code"
    once it lapses.
  - With no address, it shows the reason and no QR.
- **Settings → Devices.** A new first section, "Add to Nova", with four
  tiles: A machine Nova controls · A model server · Nova on a phone · The
  Nova app.
  - Each tile opens its `SetupPanel` in the `Modal` today's pairing dialog
    uses.
  - The existing "Pair a device" buttons open the machine panel, so pairing
    gains the QR. `PairingModal`'s body becomes `SetupPanel`.
  - The address comes from `GET /api/v1/network/address`, never from
    `window.location`.
- **The chat card.** A compact `SetupPanel` inside her message.
  - Live cards come from `card` events in `chatReducer`.
  - Reloaded cards come from `messages_json.cards`.
  - `MessageBubble` renders both.
- **The public pages** (§5) use the same `SetupPanel` pieces and Nova's
  styling, readable at 393 px.

---

## 11. Tests

**Web** (vitest):

- **QR round trip.** A dev-only decoder (`jsqr`, Apache-2.0) decodes each
  panel's `encode()` matrix, rasterised in the test, back to the exact link.
- **`devicePlatform`** is pinned against user agents for iPhone Safari, iPhone
  Chrome (`CriOS`), iPad in desktop mode, Android Chrome, Samsung Internet,
  and desktop Chrome, Edge, Firefox and Safari. Unknown agents return
  `unknown`.
- **`/add`** reads the code from the fragment and calls `fetch` zero times.
- **`/app`** never redirects while its store link is empty.
- **`QrCode`** refuses loopback, LAN and plain-http links.
- **Section coverage:** `tabs.test.tsx`'s `SECTIONS_BY_TAB` gains the new
  section.
- **The chat reducer** keeps live and reloaded cards on the right row.

**Core** (pytest):

- **`network.address()`** is tested against fresh, stale, missing,
  unparseable, wrong-version, not-Running, serve-not-verified,
  no-certificate and non-ts.net fixtures.
- **Code containment.** A test mints a real code through `show_setup_qr` and
  asserts the plaintext appears nowhere but the card frame: not in her
  result, the span meta, `messages`, or the reloaded `cards`.
- **The card frame** is emitted once per call, with the documented keys.
- **The refusals:** no address, and no card channel. Each mints nothing.
- **Guards:** a must-fire and a must-not-fire corpus each, plus the timing
  sweep.
- **Native-app constants:** `native_app.py` is pinned equal to
  `nativeApp.ts`.

**Deploy:**

- `deploy/tailscale/start_test.sh` covers the status loop: its fields, the
  atomic write, a tick with the backend not Running, a failed write that does
  not stop the sidecar, and no loop at all while `MOVED_TO` is present.
- **Backup coverage.** These read the real compose file and are tripwires
  for the volume set, so all of them run, and any pinned set moves
  deliberately:
  - `deploy/backup/tests/test_coverage_v4_real.py`, `test_raw_compose.py`
    and `test_policy.py` (pytest from `deploy/backup`, which has its own
    `pyproject.toml`);
  - `deploy/backup_test.sh` and `deploy/install_test.sh`.

**By hand, before merge:** the full core suite; gateway and memory unchanged
but run; web `npm test` and `npx tsc --noEmit`; the shell tests. This follows
`v4-push-gate`, against the scratch postgres on `127.0.0.1:55432` with this
lane's own databases.

---

## 12. Pinned suites that move, and why

- `test_tools_registry.py`: 41 → 43 (`nova_address`, `show_setup_qr`).
- `test_eval_corpus.py`: count 26 → 29, `suite_version` 15 → 16, for all
  cases, with the reason written where earlier bumps wrote theirs.
- `test_live_facts.py`: `nova_address` classified AUTO_RUN; `show_setup_qr`
  deliberately not.
- `test_capability_guard.py`: MUST_FIRE gains the setup phrases.
- `tabs.test.tsx`: the new section on the Devices tab.
- `start_test.sh`: the status loop.
- The backup suites' volume sets (`deploy/backup/tests/test_policy.py:216-229`,
  `test_raw_compose.py:496-498`, and whatever `test_coverage_v4_real.py`
  derives): `v4_status` joins as `exclude-derived`.
- `test_no_approvals.py` stays **unchanged and green**. The card channel adds
  no await, and no refusal here decides that a call *may not* run.

If the other lane lands a registry or corpus bump first, whichever lands
second renumbers and re-bumps once (hub-topology, "Migrations").

---

## 13. Deploy and the walk — the definition of done

1. **Land it.** Open a PR, merge, then `git -C ~/workspace/nova pull
   --ff-only`. Build and recreate core, web and the tailscale sidecar **from
   the nova directory**. Recreating the sidecar drops the tailnet URL for a
   few seconds.
2. **Walk in chat, in her words.** Read each turn's `turn_spans` by turn id:
   the tool span, no guard span on an honest reply, and no code anywhere in
   the trace.
   1. "How do I put you on my phone?" She calls `show_setup_qr(install_pwa)`.
      The iPhone scans the card, installs Nova from `/install`, and the icon
      opens Nova's start page.
   2. "Add my laptop so you can control it." A machine card appears. The
      phone scans it and gets "open this on the computer". On the mini PC, a
      throwaway novad (its own `XDG_CONFIG_HOME`) enrolls with the `/add`
      command and appears in Settings → Devices. It is revoked afterwards.
   3. "Where do I download your iPhone app?" `/app` on the iPhone says there
      is no app yet and shows the install steps.
   4. "Set up the Dell to serve models." The card and her reply both say that
      serving models needs S44.
   5. The hub opened at `http://127.0.0.1:3000`: the Settings panels still
      encode the tailnet address, never loopback.
3. **393 px screenshots** of Settings → Devices, each panel, the chat card,
   and the three public pages.
4. **Documents:** the close-out `../slice-47-setup-qr.md` and its carries
   `../slice-47-carries.md`; the S47 status in `../hub-topology.md`; the order
   of work in `../ROADMAP.md`; and `deploy/README.md` (a new "Adding devices
   and phones" section, and the status volume).

---

## 14. Not built — and said so where it matters

- **The native app itself, its store listings, and universal links / app
  links.** Those need a public host (`apple-app-site-association`,
  `assetlinks.json`). `/app` states "no app yet".
- **Agent installers for Linux, Windows and macOS** (S42a, S42b). `/add`
  names the README and states "Linux today".
- **The models role** (S44). `add_model_server` pairs the machine and says
  so.
- **Tailscale invites and joins** (S43a, S43b). Step zero is stated, not
  performed.
- **A phone as a machine Nova controls.** That needs the native app. `/add`
  on a phone says so.

---

## 15. Alongside the other lane

The other session owns S46/S46a now and S42a/S42b next.

- **This lane** is branch `slice/s47`, in worktree `.worktrees/qr`. Every
  commit is staged by path, every git command uses `git -C`, and
  `git show --stat` follows each commit.
- **It touches:**
  - `apps/web`: new components and pages; `App.tsx`; `DevicesSection`;
    `streamChat`, `chatReducer` and `MessageBubble`; `api.ts`; and
    `package.json` (+`uqr`, dev +`jsqr`).
  - core: new `network.py`, `network_api.py`, `native_app.py` and
    `tools/setup.py`; plus `tools/__init__.py`, `tools/base.py`, `chat.py`,
    `conversations.py`, `guards.py`, `live_facts.py` and `evals/`.
  - `deploy/docker-compose.yml` (the volume and its backup disposition),
    `deploy/tailscale/start.sh` with its test, and the backup suites' pinned
    volume sets.
  - Documents.
- **It does not touch** `apps/novad`, the gateway, or any migration. No
  migration is needed.
- **S42b extends `show_setup_qr`'s machine setups** — the per-OS installer
  one-liners, `for_os`, the transport — rather than adding a second tool.
  `/add`'s Linux step 1 becomes that installer. The card and `code_claim` are
  S42b's to reuse.
- **The other session was told this on 2026-09-25 and answered** (from the
  Nova Hub session):
  - the backup disposition for `v4_status`, and `start.sh`'s step 0 staying
    first — both now in §4;
  - S46a (`docs/plans/rebuild/s46a/spec.md`, `13580a26` on `slice/s46`,
    unpushed) takes registry +3, corpus +4, `suite_version` +1 and core
    migration 037; S42a lands before it and adds one eval. Whichever lands
    second renumbers once;
  - S46a adds guards at both guard sites, so `guards.py` will conflict
    textually — a rebase, with no design overlap;
  - S43a's `join_link` card rides this card channel, and S43a extends
    `network.py` rather than adding a second reader.
- **hub:primary** has uncommitted edits to `docs/plans/rebuild/ROADMAP.md` in
  the nova directory (a row 6 in "The order of work" and a new "After
  release: the optional list" section). This lane's ROADMAP edit comes last
  and merges around them; the deploy step's `git pull --ff-only` is checked
  against those local edits before it runs.

---

## 16. Risks

- **The status file is a new moving part between two containers.** A sidecar
  that stops writing makes every QR surface say "no address" within 45 s.
  That is the intended failure, and it is stated.
- **User-agent detection is a heuristic.** `unknown` shows every platform's
  steps rather than guessing, and the steps name the platform they are for.
- **The store links exist in two copies**, core's and the web's, pinned equal
  by a test.
- **The public pages open for anyone on the tailnet without signing in.**
  They hold nothing secret: a code travels only inside a link its holder
  already has, and the page makes no request.
- **Pushing is blocked on the mini PC today** (`gh` and git have no valid
  credential). The work can be committed; it cannot reach `main`, and so
  cannot be deployed, until the owner runs `gh auth login`.
