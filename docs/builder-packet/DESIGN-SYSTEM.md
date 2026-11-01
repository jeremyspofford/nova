# DESIGN SYSTEM — foundation

This is the contract between Nova's product design and every line of UI code. It defines (0) the art direction, (a) the design language, (b) the token schema all packages must implement, (c) the package/hot-swap mechanism. Approved visual references: concepts E–H (round 2) as one language; A for feature set; B/F for conversational warmth; D/E/H for the ambient home.

## 0. Art direction (owner direction, 2026-11-01)
Source: `INPUT-2026-11-01-DESIGN-QUALITY.md` and its diagnosis, `nova-design-quality-system-2026-11-01.md`. The rest of this document is a schema; this section is the design it serves. Where a later section leaves a choice open, this section decides it.

### 0.1 One lead package: Orb Teal
- **Orb Teal is the lead.** It is perfected first, and it is the design Nova shows unless the person picks another.
- **Other packages inherit its structure and re-express values only.** The structure is the designed scales of §2.1; a package chooses colours, fonts and values inside them.
- **Packages are not equals until each has passed the same bar.** The bar is:
  - on the designed scales in every look (`check:themes` reports it per package);
  - and the owner has approved its rendered styleguide (the owner names it in `AT_THE_BAR`, `src/core/design.ts`).

  Today only Orb Teal is at the bar.
- **How that is presented:**
  - *Settings › Appearance* shows Orb Teal as "Nova's design", with its reason. When the device asks for light, the reason says plainly that it is dark because no light design has reached the bar yet.
  - The other five sit behind *More designs*, marked "not yet at Nova's design bar". They stay installed and usable; none is deleted.
  - *Onboarding* offers no design choice at all. It applies the default, Orb Teal.
  - *The styleguide's* design switch marks each package not yet at the bar.

### 0.2 Exemplars by surface family (proposed 2026-11-01, owner may amend)
We take qualities from these, never their branding, assets, names or copy. Each quality is written so a screenshot can be checked against it.

**Chat — best-in-class conversational restraint.**
- One reading column. Nova's prose runs at most about 72 characters to a line.
- Nova's turns sit on the page, unboxed, with no avatar. The person's turns are tinted bubbles without tails (Amendment C).
- Per-message actions (copy, regenerate) stay quiet: secondary text, no fill.
- Live status inside a turn is one line naming the real phase (§1, Progress and waiting).
- The composer is the only persistent control. Send is the only filled button in the view.

**Control surfaces (Home, Tasks, Health, Activity) — Linear/Raycast density and crispness.**
- A list of like things is a list: one row each, separated by hairline dividers. It is not a grid of cards.
  - Each row has its title on the left, its status at the right end, and its meta under the title in `type/small`, secondary.
- Edges are crisp. Separation comes from tone and 1px `border/subtle` lines; shadow is level 1 and barely there.
  - Orb Teal radii: 12px for containers, 8px for controls.
- Three type tiers per view: the view title (`type/h1`), group labels (`type/caption`, uppercase, secondary), and row titles. Nothing else on the view rivals the title.
- Colour carries status, and nothing else. A row has at most one coloured element.
- Everything is left-aligned. Numbers are tabular.

**Settings — the clarity of macOS Settings and Raycast's settings.**
- Categories in a sidebar on wide screens, a list on narrow ones; one category open at a time.
- One setting per row: its label on the left, its control on the right, and at most two lines of note under the label.
- A caption heading over each group. Destructive settings come last in their group, set apart.
- Search filters down to the rows themselves.
- Nova's recommended choice is marked once. Deeper detail sits behind a disclosure, not in paragraphs above the controls.

### 0.3 Anti-references (what Nova must never look like)
- **The generic SaaS dashboard:** a row of KPI tiles, charts for their own sake, a sidebar of a dozen equal items.
- **The stock Tailwind/shadcn look:**
  - slate greys;
  - the same large radius on everything;
  - default 14px type everywhere;
  - card › header › title sameness.
- **The purple-gradient AI aesthetic:** violet-to-blue gradients, sparkle icons, glowing text.
- **Card-grid monotony:** everything in same-size cards in a grid, whatever its weight.
- **Emoji as icons.**

### 0.4 The slop list (scored on every UI PR)
Each item is scored per surface as **pass**, **fail** or **n/a**, with one line of evidence. The owner-side UX review scores the same list independently, so the wording is the test.

1. **Uniform equal-weight card grids.**
   - *Pass when:* like items are a list with one row each. Cards are used only for different jobs, and the most important one is visibly heavier, by position, size or the view's one standout.
2. **Everything centered.**
   - *Pass when:* text and controls align to a left edge. Only the orb hero and a first-run greeting are centered.
3. **Decorative gradients.**
   - *Pass when:* gradients appear only as the orb's light and the page's background light. `lint:tokens` enforces this.
4. **More than one standout per view.**
   - *Pass when:* at most one filled (primary) control is visible in the view. A sheet is its own view.
5. **Flat type hierarchy.**
   - *Pass when:* the view shows at least three distinct tiers from the type scale (title, group label, row), and nothing else competes with the title in size or weight.
6. **Off-scale spacing.**
   - *Pass when:* `lint:tokens` passes: no half steps, no sums of steps, no raw lengths.
7. **Mixed icon styles.**
   - *Pass when:* every icon comes from the one set (`ICONS`) at its one stroke, and there are no emoji. `lint:tokens` enforces this.
8. **Placeholder-looking empty states.**
   - *Pass when:* the empty state says what is true now and what will appear here, in Nova's words, with at most one next step. Never "No data", lorem, a grey box or an illustration placeholder.

**Every UI PR** states its self-check against this list, per surface it touches, beside its posture screenshots and its screenshots matched to the styleguide (OPERATING-RULES, Design quality).

### 0.5 The living styleguide
- **Where it is:** `/styleguide` (`ui/styleguide.html`, `ui/js/styleguide.js`). It renders every component of §7 in every state, drawn by the app's own code.
- **Its content:** realistic Nova content, never lorem, with neutral placeholders only.
- **One entry at a time:** each entry has its own anchor (`#sg-<entry>`) and its own address (`/styleguide?entry=<entry>`). The owner approves one rendered entry at a time.
- **Rendering the review shots:** `tests/ui/design-shots.ts` renders each entry on its own, plus the main surfaces at desktop and phone width.
- **The rule:** a component that isn't in the styleguide doesn't ship. `tests/styleguide-coverage.test.js` fails when an exported component has no entry, and names the known gaps.

## 1. Design language (applies to every package)
- **The Orb is Nova's face.** A luminous sphere of abstract light. **No face, no features, ever.** Identity and state are expressed through light: color temperature, brightness, motion (breathing idle, gentle pulse while working, slow swirl while listening, steady bright when speaking, warm amber when it needs you, red only for what stops Nova). Its states are a fixed, semantic set (below, owner decision 2026-10-31). One orb component, token-driven, reused at every size — hero presence on the home, status in the rail. **It appears once per view** (Amendment 2026-10-30-C): never as a per-message avatar in chat.
- **Cards are the unit of information.** Briefs, tasks, devices, results: rounded cards with one job each, generous padding, one headline, at most a few lines. If content needs more, it gets a detail view — the card never becomes a table.
- **Density is capped.** Default surfaces show the minimum that matters. Power detail (logs, diffs, full device lists, raw health) lives one layer down, on demand. Dense cockpit layouts are an anti-pattern for Nova.
- **One status vocabulary.** Everywhere: Quiet / Working / Waiting / Verified / Needs you / Failed — with fixed semantic colors from tokens. "Verified" always carries its evidence affordance (tap → evidence).
- **"Nova is handling"** is the standard component for background work: task rows with plain-language titles and status, expandable to the ledger entry.
- **Calm motion.** Slow, small, purposeful. Motion conveys state (orb, status transitions), never decoration for its own sake. Reduced-motion setting honored everywhere.

### The orb's semantic states (binding — owner decision, 2026-10-31)
The owner's words: **"RED is reserved for problems that STOP Nova (the Failed class — work cannot proceed, a dead-man switch fired, a security refusal). AMBER is needs-you-but-running: approvals waiting, problems like the Health items, degraded capture. This maps 1:1 onto the status vocabulary and it is a SEMANTIC rule, not a colour choice, so it survives theming."**
- **The state set is fixed:** idle / listening / working / speaking / needs-you (amber) / stopped (red) / offline. "Themes may not add, remove, or re-meaning states."
  | State | Means | Status vocabulary |
  |---|---|---|
  | idle | Nothing is happening; Nova is there. | Quiet |
  | listening | The person is talking to Nova. | — |
  | working | Nova is doing something. | Working |
  | speaking | A reply is arriving. | — |
  | needs-you | Something needs the person while Nova keeps running: an approval waiting, a problem worth a look (a Health item), capture running degraded. Amber. | Needs you |
  | stopped | Something stopped Nova: work can't proceed (a task failed, a rollback or revert that couldn't be made, Nova unable to restart), a dead-man's switch fired, a security refusal. Red, and nothing else is. | Failed |
  | offline | Nova isn't reachable. | — |
- **Which problems stop Nova** is said where each is raised, not guessed from its words: a problem carries `stops` (set by `Log.problem(…, { stops: true })` or by a playbook marked `stops`). Every other problem is amber. The list of stopping sources is in `docs/plans/orb-states.md`.
- **Each theme package expresses the states in its own visual language** ("a future space theme renders the same states as stellar phenomena, not teal light — values and motion are the theme's, the meanings are the system's"). Today a package does this with `orb_states{}` (§4): for each state a colour token, a motion, a light and a mark, from what the renderer draws, plus its reduced-motion equivalent.
- **In every theme** ("colour alone is not a safe channel"):
  - **States differ by motion and brightness pattern as well as hue.** No two states may share motion, light and mark; under reduced motion, no two may share light and mark.
  - **The stopped state is unmistakable.** No other state shares its motion, its light or its mark, with motion or without; it takes `status/error`, and no other state may.
  - **Reduced-motion equivalents are required** for every state: under reduced motion nothing on the orb moves, and the state's reduced light and mark carry it.
- **Enforced:** `npm run check:themes` (validatePackage) fails a package that adds, removes or omits a state, or breaks a rule above; `tests/ui/orb-states.test.ts` renders all seven states in every installed design system, light and dark, with and without reduced motion, with colour taken away, and checks every pair still looks different and stopped stands apart.
- **UX review 1 (F3).** The flat salmon disc the review captured was the old alert state, shown because Health had open problems (files too large for the standby's copy). Under this rule those problems need the person while Nova keeps running, so the orb reads as amber needs-you. The rendering depth (the lit sphere of #254) is still the F3 fix, and stays.

### Perception principles (binding, non-negotiable — owner amendment, 2026-10-29)
1. **Show real progress.** Task state comes from the Work Ledger, never simulated activity.
2. **One standout element per view:** the primary action. Approvals and destructive actions always stand out.
3. **Fewer choices.** Nova recommends; it does not dump option lists.

**Prohibited:** artificial delays or simulated work of any kind; streaks or engagement/guilt mechanics.

**Endings matter:** close every task with a clear, verified outcome — clarity, not celebration.

### Progress and waiting (binding — Amendment 2026-10-30-C; evidence: UX-RESEARCH-2026-10-30 §1)
1. **Acknowledge at once.** Every action shows a visible change within 0.1 s.
2. **Timing bands for indicators:**
   - **Under 1 s:** no indicator.
   - **2–10 s:** a spinner for a single module, or a skeleton for a full page.
     - A skeleton is never just a frame, never stands in for a process, and its shape matches the final layout exactly.
   - **Over 10 s:** determinate progress plus a general estimate ("about a minute").
3. **Progress in real units only.** Determinate progress is computed from real units of work: steps, files, tokens.
   - No false precision.
   - No bar that stalls at 99%.
   - If a step is long, it is shown in smaller real parts.
   - Where the units aren't known, there is no percentage.
4. **No simulated streaming.** Streaming shows real tokens and real steps as they happen. A finished answer is never replayed as if it were being generated.
5. **No artificial delay,** ever: no fake "checking…" and no padding to look thorough.
6. **Optimistic UI uses the honest split.** "Saved on this device" shows at once. Syncing is reported as its own separate status.
   - A rollback is visible and explains itself (a toast with Undo). The person's input never silently disappears.
7. **Name the real phase:** Thinking, Searching your notes, Running ⟨tool⟩, Writing. Nova never shows a human "typing…" indicator.

## 2. Semantic token schema (required in full by every package)
Components may reference ONLY these tokens. Raw hex, px, or font names in component code are lint errors (`lint:tokens`), and CI enforces it.

- **Color**: `bg/base`, `bg/raised`, `bg/overlay`, `surface/card`, `surface/card-hover`, `text/primary`, `text/secondary`, `text/faint`, `border/subtle`, `border/strong`, `accent/primary`, `accent/secondary`, `status/ok`, `status/working`, `status/waiting`, `status/attention`, `status/error`, `orb/core`, `orb/glow`, `orb/listening`, `orb/attention`.
- **Type**: `font/display`, `font/body`, `font/mono`, scale `type/h1…h3`, `type/body`, `type/small`, `type/caption`, weights, line-heights.
- **Space/shape**: `space/1…8`, `radius/card`, `radius/pill`, `radius/input`, `shadow/card`, `shadow/raised`, `blur/glass` (for frosted surfaces).
- **Motion**: `motion/breathe`, `motion/pulse`, `motion/transition`, durations + easings.
- **Layout**: `layout/rail-width`, `layout/content-max`, `layout/card-gap`, breakpoints are code (posture rules, §5), not tokens.

A package that omits a required token fails validation and cannot be applied (`check:themes`-style completeness gate, extended from the Era 2 scripts).

### 2.1 The designed scales (owner direction 2026-11-01)
**Where the scales live.** Their *structure* belongs to the system (`src/core/design.ts`: `SPACE_SCALE`, `TYPE_STEPS`, `TYPE_RATIO`, `RADIUS_CLASSES`, `ICON_STROKE`, `scaleFindings`). Their *values* belong to the package.

Why:
- The direction says the other packages inherit Orb Teal's structure and re-express values only. Putting the structure in the core makes that true by construction rather than by care.
- Spacing is layout, and §3 forbids a package from changing layout. So the spacing scale's values are structure too, the same in every package. Companion Light and Paper were re-expressed onto it in this pass.

How it is enforced:
- **At runtime,** leaving the scales is a warning, never a refusal, so any package, including one made before them, still applies.
- **`check:themes`** fails a package that is at the bar and leaves the scales. It lists every other package as not yet at the bar; `NOVA_BAR_DETAIL=1` prints why.
- **`lint:tokens`** holds `ui/` to the scales.

| Scale | Structure (system, same in every package) | Orb Teal's values |
|---|---|---|
| **Spacing** | 4pt steps with names: `space/1` hair 4 · `/2` tight 8 · `/3` snug 12 · `/4` base 16 · `/5` roomy 24 · `/6` group 32 · `/7` section 48 · `/8` page 64. `layout/card-gap` is a step. UI spacing takes one step, its negative, or derived geometry (safe-area insets, a hit area); never a half step or a sum. | as the structure |
| **Type** | Six steps, caption → h1, each body × ratio^n (n = −2…3), whole pixels within 0.75px. Ratio 1.125–1.333; nothing under 11px; strong at least 200 heavier than regular; tight line height under body. UI type takes the scale's own tokens. | body 16, ratio 1.2: 11 · 13 · 16 · 19 · 23 · 28; weights 400/600; lines 1.25/1.5 |
| **Elevation** | Two levels: `shadow/card` (a card on the page) and `shadow/raised` (sheets, popovers, toasts), each at most two layers, raised visibly above card. | card `0 1px 2px` at 32%, raised `0 12px 32px` at 48% |
| **Radius** | By component size class, never by rendered height. A *container* (card, sheet, panel, bubble, banner, toast) takes `radius/card`; a *control* (button, field, choice, the composer at any height, a row) takes `radius/input`; only a *token* of fixed height (status pill, chip, dot, round icon button) takes `radius/pill`. Card and input radii are on the 4pt grid, input under card; the pill is 999px. | card 12 · input 8 · pill 999 |
| **Motion** | One family: `duration-fast` < `transition` < `duration-slow`, within 150–300 ms (M9); the loops `pulse` and `breathe` are whole multiples of slow; one curve, `motion/ease`, that never overshoots. | 150 · 225 · 300; pulse 1800, breathe 6000; `cubic-bezier(0.25, 0.1, 0.25, 1)` |
| **Icons** | One set (`ICONS`, `ui/js/components.js`), drawn for Nova on a 24-unit grid at one stroke weight, `ICON_STROKE` = 1.5, round caps and joins, no fills, in `currentColor`. No emoji. No third-party set, so nothing to license. | as the structure |

**What `lint:tokens` catches** (`scripts/lint-tokens.js`, tests in `tests/lint-scales.test.js`), in CSS and in the styles scripts write, each as `file:line` with the reason:
- off-scale spacing;
- type outside the scale's tokens;
- a radius that isn't a single radius token, or a pill on something that grows;
- a gradient outside the orb and the page;
- an icon at another stroke weight;
- emoji.

## 3. Starter packages (ship in core)
- **Orb Teal** (default, dark): deep teal living gradient background, luminous orb, frosted glass cards, soft green-teal accent. Source: concepts D/E/H.
- **Companion Light**: warm cream surfaces, soft coral-warm accent with teal orb retained, serif display + clean sans body. Source: concepts B/F.
Both packages must render EVERY layout and component identically in structure — a package changes values, never layout or features. (Historical exception carried from Era 2: a theme may add one signature extra surface — the Stellar Map in the Nova theme — declared in its manifest as an extra, never as a removal.)

## 4. Package format and hot swap
A design system is an extension (EXTENSION-MODEL) with kind `design-system` and the manifest of CONTRACTS §4 plus: `tokens{}` (full schema of §2), `orb_states{}` (the orb's seven states, each `{color, motion, light, mark, reduced: {light, mark}}`; motions `breathe`, `swirl`, `pulse`, `ripple`, `beckon`, `alarm`, `still`; lights `soft`, `full`, `bright`, `stark`, `dim`; marks `none`, `ring`, `dashed`; rules in §1), `components{}` (per-component token bindings and any package-specific variants), `content_rules` (may tighten, never loosen, the content rules of §6), `extras[]` (declared signature surfaces), `preview` (thumbnail/screenshot set).
- **Apply path**: install → validate completeness → apply live to the real UI (no embedded preview mock; swatches are picker thumbnails only — Amendment 2026-10-30-C) → tokens are CSS variables (web) swapped at runtime — **no rebuild, no restart** → previous package kept for one-click rollback. This device: applies instantly with a visible Undo. All devices: an explicit Save.
- Scope: per user (all devices) or per device override. Sync of the choice follows the profile.
- Native clients later compile the same token set to native themes; a package valid for the PWA is valid for native.
- Nova's foundry may author packages the same way it authors extensions (sandbox, tests = validation + screenshot diffs, approval, removable).

## 5. Layouts and postures (code-level, package-independent)
Layouts are chosen by viewport + posture, never by device name:
- **Phone / foldable cover screen** — Ambient Home: orb hero, greeting, card stack (Brief, Nova is handling, Devices, Smart Home, Memory highlight), bottom tabs (Home, Chat, Tasks, Memory, More).
- **Chat** — single centered conversation column; Nova's turns full-width and un-bubbled, the person's turns tinted bubbles without tails, grouped timestamps (Amendment 2026-10-30-C Part 1); "looking into it" working cards inline (H-right), composer with voice. The orb appears once in the view, not per message.
- **Tablet / foldable inner / half-open** — two-pane: conversation or home + one contextual pane; half-open may split conversation (top) and active card/result (bottom).
- **Desktop/laptop** — Calm Control (G): slim rail (orb + ≤6 destinations), center column (conversation/brief), optional right column with at most three quiet cards (Active Tasks, Device Mesh, System Health) — collapsible, off by default on smaller widths.
Every layout exposes the same features; layouts differ in arrangement only.

**The iOS status bar in the installed app** (owner decision, 2026-10-31, option C):
- **Dark designs:** each design package declares whether it draws behind the status bar. Dark designs do (`black-translucent`), so Nova's background fills to the top edge.
- **Light designs:** they keep iOS's own strip, because iOS forces the status text to white when an app draws behind it.
- **Re-opening the app:** iOS reads this setting at launch, so changing to or from a dark design may need the installed app re-opened before it shows. The setting says so.
- **The safe-area rule still holds:** no control sits under the cutout or the home indicator.
- **Not yet checked:** on a real iPhone; no test browser runs as an installed iOS app.

## 6. Content and formatting rules (binding)
- Implements NOVA-SPEC §5: concise by default, plain language, overview first, depth on demand.
- Per-channel renderings of the same content object: **spoken** (no markup, short sentences, numbers spoken naturally), **chat** (light structure, short paragraphs, lists only when enumerating real items), **card** (headline + ≤3 lines + one action), **brief/report** (structured, evidence attached), **notification** (one line + one action).
- Status and errors in human terms with the technical detail one tap away. An error the user can't act on is phrased as what Nova is doing about it.
- Numbers that drive decisions (cost, time, stakes) are shown with their basis; no naked percentages without denominators where the package renders decision content.

## 7. Component inventory (v1 — each specced with states)
Each is rendered, in every state, in the living styleguide (§0.5). A component that isn't there doesn't ship.

Orb (states, fixed: idle/listening/working/speaking/needs-you/stopped/offline — §1) · BriefCard · HandlingCard (task rows) · TaskRow · VerifiedResultCard (with evidence viewer) · LookingIntoItCard · DeviceRow · DeviceMeshCard · HealthCard · MemoryHighlightCard · ApprovalSheet (tiered, plain-language permissions) · TriggerRow (schedule/event with pause/delete) · ChatBubble set · Composer (text/voice) · Toast/ProactiveBanner · SettingsRow · EmptyState ("Nothing needs you" is a valid, designed state).
