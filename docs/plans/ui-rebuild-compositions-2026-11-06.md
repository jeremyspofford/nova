# UI rebuild compositions — diff notes, 2026-11-06

Design-first compositions for the owner's one-line reactions. Styleguide only: no app view, route
or shell changed. Each composition is diffed against the filed references in
[`docs/builder-packet/ui-references/`](../builder-packet/ui-references/README.md) and
[`ORB-ICON-THEME.md`](../builder-packet/ui-references/ORB-ICON-THEME.md), not against the #306
compositions or the current Stage-2 look (and not against the #307 overlay, which the owner ruled
is not a rebuilt surface).

Where to look: `/styleguide?entry=ui-shell-chat`, `ui-settings`, `ui-about`, `ui-orb`. Any frame
full screen: `/styleguide?entry=ui-shell-chat&frame=shell-chat-reply&ds=nebula&mode=dark` (or
`mode=light`). Screenshots: [`docs/screenshots/ui-rebuild-2026-11-06/`](../screenshots/ui-rebuild-2026-11-06/).

Files: `ui/js/sg-compositions.js` (the frames), `ui/styles/compositions.css` (their CSS; only
`ui/styleguide.html` loads it), container breakpoints in `ui/styles/layout.css` scoped to `.uc-*`
(the lint keeps every breakpoint in that one file), `design-systems/nebula.json` (the tokens),
`tests/ui/ui-rebuild-compositions.test.ts` (the matrix).

## 1. Shell + chat

Frames: an empty new chat; mid-reply with a tool step and a citation; the rail collapsed (desktop)
or open as a drawer (phone); the command palette open.

| Reference | Taken | Deliberately not taken, and why |
| --- | --- | --- |
| Linear (`linear-my-issues.avif`) | Workspace switcher at the top of the rail with search and new beside it; flat nav rows with an icon, a label and a quiet count; hairlines, no boxes; one accent; a near-black neutral dark; uppercase group labels. | Linear's ~28–32 px rows: Nova's 44 px target rule wins, so density comes from type and hairlines, not cramped rows. Linear's tabs and filter bar: chat has nothing to filter. The window chrome. |
| Claude.ai (`claude-ai-chat.jpg`) | A content-width column (720 px); almost no chrome (a one-line title bar); the composer as the single focus, with attach, a privacy chip where Claude has its model chip, voice, and send/stop inside it; a centred greeting over the composer on a new chat; quiet suggestion chips under it. Your words in a tinted block, Nova's on the page with no avatar. | The serif greeting (Nova's type scale stays one family). The "Free plan · Upgrade" pill: nothing to sell. Claude's orange asterisk: the orb takes that place and is the one standout. |
| Arc (text reference) | Spaces (Home, Work, Study desktop, Cabin) as a row of icons at the foot of the rail, Arc-style; the current space named at the top of the rail with a switcher. | Per-space colour themes: they would put a second colour in every view. |
| Raycast (text reference) | The palette: search first (the field is the top of the box), grouped results with where each goes, keyboard hints in the footer, Ctrl K from the rail's search button. | Raycast's extension store, icons in colour. |

**Open choices for the owner** (each with the default these frames show):
- Where spaces live — default: **icons at the foot of the rail** (Arc). Alternative: only in the switcher at the top.
- Suggestion chips on an empty chat — default: **three quiet ones**. Alternative: none (pure Claude.ai blank).
- Privacy shown in the composer — default: **yes, "Local only" where Claude shows the model**. Alternative: model name instead.
- The top-bar orb on every view — default: **yes, mini**, and the hero only on an empty chat.

## 2. Settings

Frames: the top level (General); Privacy with a search for "cloud" active.

| Reference | Taken | Not taken, and why |
| --- | --- | --- |
| Raycast (text) | Search first (a field at the head of the category list, `/` to focus); a plain category list and a detail pane; rows of name, one line of what it does, and the control on the right; zero decoration. While searching, only categories with a match are listed, with a count, and matches are marked in the detail. | Raycast's tabbed window and per-extension icons. |
| Linear | The same rail and row grid as the shell, so Settings is not a different app. | — |

On a phone Settings is two screens: the category list, then the detail with a back row.

**Open choices:** search scope — default: **the search filters the category list and marks matches in the detail**; alternative: a flat list of matching settings across categories. Switches vs checkboxes — default: **switches** for on/off, radio rows for a mode.

## 3. About, /changelog and the pipeline dashboard

From the versioning spec (`nova-versioning-changelog-2026-11-03.md`) plus the delta
(`nova-about-deploy-visibility-delta-2026-11-06.md`).

- **About** (Settings › About): Nova `0.1.0-alpha.1`, the short build, the build date, the latest merged build, and the honest state line in three states: running the latest; **"Running 8001cd2, latest merged b66f2c5 — redeploy pending."** (amber, and the orb asks for you); latest unknown because GitHub can't be reached (dashed, never shown as up to date).
- **Footer version stamp**: the rail's foot in every frame shows `0.1.0-alpha.1 b66f2c5`; when a redeploy is pending it turns amber and says so. Collapsed, it is a "v" with the dot.
- **Changelog** (`/changelog`): the running version pinned at the top, then newest first by day, each line in the ledger's plain voice with its area and its evidence link (pull request or ledger entry). Entries are taken from the real `docs/ledger/` and `LEDGER.md` entries, re-said for the owner.
- **Pipeline dashboard** ("Where Nova stands"): tracks (Foundation, Nova's computer, Models, UI rebuild, Versioning), each milestone with merged / in progress / designed / not started and its evidence link. A state is a shape first (filled, half, dashed, empty) and a colour second. **Labelled as sample data**: drawn from `docs/ledger/`, `LEDGER.md` and `docs/plans/`; the real view must be generated from those at view time (the delta forbids a hand-kept list).

| Reference | Taken | Not taken, and why |
| --- | --- | --- |
| Linear | Group header bands with a count ("3 of 3 merged"), status icons by shape, one row per item, hairlines. | Priority bars and issue ids: they mean nothing here. |
| Things 3 | Calm type hierarchy on the changelog: date as a small label, the line as the content. | Things' colour per list. |
| Claude.ai | The content-width column for the changelog. | — |

**Open choices:** where About lives — default: **Settings › About** (Raycast's last category), linked from the footer stamp; alternative: Health › About per the Nov 3 spec. Where the dashboard lives — default: **its own page linked from About and the palette**; alternative: a Home card. Evidence links — default: **"Pull request 335" / "Ledger entry"** words, never a bare number.

## 4. Orb and the Nebula theme

- **Tokens first.** `design-systems/nebula.json`, "Nebula (proposed)" (working label), light by default with a dark mode. Accent tokens derived from the ORB-ICON-THEME palette: orb/core `#1684b9` (teal-cyan), orb/glow violet, orb/listening `#e5998d` (magenta-pink highlight), orb/attention `#f08d1f` (coral-orange, also needs-you), accent/secondary `#7a3f9e` / `#852bac` (violet), accent/primary `#1d5fa6` light / `#5cb3e4` dark (the one accent, from the blue–teal side). Surfaces are neutral: light `#fbfbfc`/`#ffffff`, dark near-black `#0f0e11`/`#151418`, low saturation. It passes `check:themes` (contrast in both modes, the orb's seven states distinct in more than colour) and is on the designed scales; it is not on `AT_THE_BAR` (owner approval first), so the switcher says "not yet at the bar".
- **The orb** is the swirl recreated at any size from those tokens, never the 215 px image: a near-black field; two arms of a logarithmic spiral (SVG paths, generated once in `sg-compositions.js`) curling into a dark eye, each arm cut into 30 short segments whose colour steps smoothly through the palette (arm one: teal and blue at the rim, through blue-violet and violet, into coral at the eye; arm two: violet, magenta, pink, then the coral-orange arc through the lower centre); the rim fades into the field (a radial mask), a soft blur makes it nebula rather than vector, and fine stars sit in the dark. Every colour is a token or a mix of two. The design's state variables still drive the glow's motion, light and mark; each state also turns the spiral at its own speed: idle slow and soft; listening faster; working fastest with a beat; speaking ripples outward; needs-you warms (the teal arm turns amber), beckons and gets a dashed ring; stopped stops, drains to grey, pulls in and gets a solid ring; offline still and dim. Under reduced motion nothing turns, and brightness plus the marks carry the state (working gets the dashed ring too), so stopped stays unmistakable. It still reads as a swirl at 24–32 px. `side-by-side-orb.png` compares the icon drawn at 480 px with the reference; `side-by-side-orb-states.png` shows all states in the page. First pass (a ring with a colour wheel) was rejected by the lead as a donut; this is the second.
- **The app icon**: the same swirl on a near-black rounded square at 128, 64 and 32 px.
- **The line the theme does not cross**: the gradient is only in the orb/icon, the state accents, and at most one identity surface per view (none used in these frames). No background, card fill or text uses it (the token lint enforces gradients only on `.orb`).

**Open choices:** the name — default: **"Nebula" stays a working label**. Dark by default — default: **follow the system**, light and dark both first-class. The accent — default: **teal-cyan in dark, deep blue in light**; alternative: violet. Make Nebula the lead design (replacing Orb Teal) — default: **not yet**, after this reaction.

## 5. Responsive

Every frame across the house matrix (phone 390, tablet portrait 820, fold cover 344, fold half-open
884×540, duo open 720×540, desktop 1440), in Chromium and WebKit, in Nebula light and dark: no
horizontal scroll and nothing clipping sideways in any frame, 44 px targets (via `shortTargets`),
every control labelled, no duplicate ids, no page errors, no requests that change anything; axe
on the stacked entries at phone and desktop. Under 720 px a frame drops the rail to a drawer (menu
button in the title bar) and Settings becomes list-then-detail. Breakpoints are container queries,
so a frame inside the styleguide column and a full-screen frame lay out the same.

## Not built here

Home / morning board (Things 3) and the graph / immersive mode (Obsidian) are other surfaces in
the reference set; no composition here. No app code: the real shell, chat, Settings and About are
unchanged until the owner reacts. The service worker needs no bump: it is network-first and the
styleguide files are not in its shell list.
