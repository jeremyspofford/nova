# UI fixes gate (Amendment 2026-10-30-C Part 1): evidence

Run 2026-10-30 on branch `ui/amendment-c-part1` at `1c801264`, on this machine. The browser tests ran in the Playwright v1.56.1 image (`scripts/ui-test.sh`), against the real server on a blank home.

## Counts

| Suite | Command | Tests | Pass | Fail | Skipped |
| --- | --- | --- | --- | --- | --- |
| Unit, core, acceptance (with lint:tokens, check:themes, typecheck) | `npm run check` | 815 | 807 | 0 | 8 |
| Browser (the whole UI gate, Chromium and WebKit) | `scripts/ui-test.sh` | 35 | 35 | 0 | 0 |

The 8 skipped tests are opt-in runs that need real outside things:
- real Claude Code (`NOVA_REAL_CLAUDE`);
- the local Ollama (`NOVA_REAL_OLLAMA`, three of them);
- a Relay checkout (`NOVA_RELAY_DIR`, three of them);
- a desktop `secret-tool`.

None of the 8 is new.

The fresh-user test still passes: `tests/acceptance/fresh-user.test.ts`, "blank profile → conversational setup → a delegated task verified with evidence, local-only, durable across a restart". So does the blank-profile setup from the PWA at phone, tablet and desktop widths (`tests/ui/setup-pwa.test.ts`).

## The gate: `tests/ui/ui-fixes.test.ts`

Each test runs at 390×844 (phone) and 1280×820 (desktop), in Orb Teal and in Companion Light.

**✔ UI fixes 1–3: the orb once per view; chat in the AI-chat style; grouped, readable timestamps**
- All nine destinations show exactly one visible orb. There is no orb or avatar in the conversation.
- Your turn is a tinted bubble on the right, with four equal corners. Nova's turn starts at the left edge, is full width, and has no background or border. Its prose is at most 76ch.
- Turns are at least 24px apart, and at least twice the gap inside a turn.
- There are two date dividers, and one gap divider ("11:30 AM").
- Group times show on the first message of each group: 9:00, 9:00, 9:03, 9:03, 11:30, 11:30, 8:00, 8:00.
- Nova's follow-up (at 9:02:30, inside its 9:00 group) shows no time. Its exact time appears on hover and on keyboard focus.
- On a touch phone, a tap shows the exact time.
- The work-trail step reads "took 2 s, finished 9:00 AM".
- Every timestamp on screen is at least 4.5:1 against what is behind it.

**✔ UI fixes 4: Settings is one structure in two layouts, with a search that knows people's words**
- Phone: a grouped list. A category's page replaces the list and has a way back.
- Desktop: a sidebar beside the detail, with one category open and the first one open by default. The sidebar doesn't scroll on its own.
- The same categories appear, in the same order, at both widths and in both designs. Nothing goes a second level deep.
- Search: "theme" → Appearance › Theme; "dark mode" → Appearance › Light and dark; "colours" → Appearance; "phone" and "pair" → Devices.
- Choosing a result puts the setting on screen, focused and highlighted, and clears the search.
- Deep links still work.

**✔ UI fixes 5: Appearance applies live, Undo for this device, Save for all, the scope, a contrast check, one recommendation**
- There is no preview frame. Every design has its swatch thumbnail.
- One design is recommended, with its reason: Companion Light for a light system, Orb Teal for a dark one. The others are listed below it, smaller.
- The scope reads "synced" at first, then "Paper · this device only" after a change for this device.
- This device: the change applies at once, Undo is on show, and another device is untouched.
- All devices: the design shows here, nothing is saved, and other devices don't change until Save. After Save, the other device follows.
- The starters pass the live check.
- An installed hard-to-read design warns: "4.15:1; it needs 4.5:1" for secondary text, and outlines at 1.33:1 and 1.06:1 against 3:1. Fix it on this device passes it, and the fix can be undone.

**✔ UI fixes 6: one scroll container per view, the OS scrollbar, a stable gutter**
For every destination:
- nothing inside the view has a vertical scroller;
- only the view itself scrolls;
- `scrollbar-gutter` is stable;
- `scrollbar-width` is auto;
- no custom scrollbar rules are loaded.

In chat, the wide code block and the wide table scroll sideways only.

## The rest of the browser gate (all ✔)

- M3: an irreversible command needs the confirm box; an ordinary one asks once.
- M3 gate: a design system swaps live, is tried before saving, applies per device and rolls back. *(Changed: the sandboxed preview frame it checked is gone. See the ledger.)*
- M3: with the server down, the PWA stays honestly offline, and recovers when it returns. *(It failed first on this branch: the two new modules weren't in the service worker's shell. Fixed, and guarded by a unit test.)*
- M3 gate: posture sweep; every destination opens in every layout; blank-profile setup from the PWA alone (phone, tablet, desktop).
- M4, M4a (including WebKit), M4c, M5 browser walls and hub, M5a, M5b, M5c (three), M6a, M6b, M7 checkpoints and Danger zone, M7a, M7b.

## Unit and core tests added

**`tests/ui-fixes.test.js`**
- Chat: no orb or avatar on any message; Nova's turn has no bubble, and yours is a bubble with no tail.
- Chat: a group is one author within five minutes, and its first message shows the time.
- Chat: every message's exact time is there to reveal; dividers mark days and long gaps.
- Chat: a work-trail entry says how long it took and when it finished.
- Settings: one structure, grouped by task, one level deep, every part in exactly one place.
- Settings: search knows people's words, not just labels, and shows the path.
- The page's live check reads colours the way the core does, and agrees with it.
- Nova recommends one design, with a reason: the starter that fits the device and reads well.
- Timestamps use a colour that passes 4.5:1 in every package, never the faint one.
- Scrolling: the OS scrollbar, a stable gutter, and no vertical scroller inside a view.
- The service worker caches every module the app imports.

**`tests/core/design-live.test.ts`**
- The live check: body text at 4.5:1 and outlines at 3:1, on the surfaces they sit on.
- Every built-in design passes the live check in every look it has, starters included.
- A valid package can still fail the live check, and says what failed and by how much.
- The fix nudges only the failing colours, by the smallest step that passes.
- The CSS carries a nudge in every look, light and dark.
- fixContrast applies on one device, for the design it shows, and undoes.
- Nothing to fix says so; removing a design forgets its fixes.
- A device can drop its own choice and follow the person's again, and roll that back.
- The list says how each look reads, with colours for a thumbnail, and which designs are starters.

**`tests/core/design-api.test.ts`**
- The contrast fix over the API: one device, its CSS, the event, and undo.

## Screenshots: `docs/screenshots/ui-fixes/`

| What | Files |
| --- | --- |
| Chat, phone and desktop, both starters | `chat-phone-orb-teal.png`, `chat-phone-companion-light.png`, `chat-desktop-orb-teal.png`, `chat-desktop-companion-light.png` |
| A tapped exact time | `chat-phone-tapped-time.png` |
| Settings, phone | `settings-phone-list.png`, `settings-phone-search.png` |
| Settings, desktop | `settings-desktop.png`, `settings-desktop-search.png` |
| Appearance, this device with Undo | `appearance-phone-undo.png`, `appearance-desktop-undo.png` |
| Appearance, all devices with Save | `appearance-phone-save.png`, `appearance-desktop-save.png` |
| The contrast warning | `appearance-phone-contrast-warning.png`, `appearance-desktop-contrast-warning.png` |
| The same design after the fix | `appearance-phone-contrast-fixed.png`, `appearance-desktop-contrast-fixed.png` |
