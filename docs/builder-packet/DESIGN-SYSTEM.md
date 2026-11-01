# DESIGN SYSTEM — foundation

This is the contract between Nova's product design and every line of UI code. It defines (a) the design language, (b) the token schema all packages must implement, (c) the package/hot-swap mechanism. Approved visual references: concepts E–H (round 2) as one language; A for feature set; B/F for conversational warmth; D/E/H for the ambient home.

## 0. Art direction — one system, one lead

**Exemplar set: proposed 2026-11-01, owner may amend.** These are references for specific qualities, not templates to copy or external dependencies:

| Surface family | Exemplars | What to carry into Nova |
|---|---|---|
| Chat | Best-in-class conversational restraint (ChatGPT and Claude conversation views) | A readable conversation column, quiet chrome, full-width Nova turns, one clear composer. No dashboard around an answer. |
| Home, Tasks, Health, Activity | Linear / Raycast | Crisp left-aligned lists, clear title → summary → detail hierarchy, compact controls, detail on demand. Density means useful information, never a cockpit. |
| Settings | macOS Settings / Raycast settings | Named categories, a clear selected location, labelled rows, a quiet explanation beside each consequential control. |

**Anti-references:** generic SaaS dashboards, stock Tailwind/shadcn arrangements, purple-gradient AI branding, equal-weight card-grid monotony, and emoji used as icons. A component library is an implementation tool, never Nova's art direction.

**Orb Teal is the lead package.** Perfect its rendered components first. Other packages inherit the same structure, spacing and states and re-express token values only; no package-specific layouts. Only packages that meet §2.1 and pass owner review of their rendered styleguide can become peers. Stage 1 proposes Orb Teal for that review; it does not claim approval has happened. Settings recommends Orb Teal in either system colour scheme while the other packages remain secondary choices. Onboarding uses the lead without asking a new user to choose among six themes.

The visual point of view: a luminous sphere is Nova's identity; the rest stays precise and quiet. Deep teal is the base, mint is the actionable accent, amber means needs-you and red means stopped. Type and grouping do the organising; repeated boxes do not. A centred conversational column is useful; centred task rows and settings labels are not.

### Living styleguide and design-first contract

`/styleguide` is the rendered contract, using the same render functions, token endpoint and CSS as the application, with real Nova tasks, approvals, evidence, failure and empty states. Every entry has a stable `#sg-…` anchor and a direct link in its index. The entry's state labels say what is rendered. Previewing a package or mode changes only that page, never the profile.

A component absent from the styleguide does not ship. For the **next new surface or component after this stage merges**, the first deliverable is its rendered styleguide entry. The owner approves that rendering before app code is written. App code then composes styleguide components; the UI PR compares its posture screenshots with those entries. Existing surfaces conform opportunistically through the UX fix list, not a big-bang rewrite. The owner reviews this initial design PR as screenshots before merge.

### Measurable AI-slop check (every UI PR)

Score each row **pass / fail / N/A** with a screenshot or lint result and a one-line reason; N/A must explain why the surface cannot exercise it. A failure is visible review debt, never silently scored as a pass. The owner-side UX review scores the same rows independently.

| Check | Pass condition |
|---|---|
| Equal-weight card grids | No three or more sibling information cards repeat identical visual weight when their priority differs. Each group has a named primary item or uses quiet rows; the styleguide's comparison catalogue is exempt and labelled. |
| Everything centred | Reading text, tasks and settings rows are left aligned. Centring is confined to the orb, an empty state or the conversation column itself. |
| Decorative gradients | Zero gradients on cards, buttons or headings. Gradients only express the page's ambient light or the orb's light (`lint:tokens`). |
| Competing standouts | At most one primary-action treatment per view in its ordinary state. A necessary approval or destructive confirmation becomes the primary action for that state. |
| Flat type hierarchy | A surface title, item title and supporting detail use distinct roles from the six-step type scale; headings use strong weight and metadata uses a quieter role. Inspect the screenshot, not just token availability. |
| Off-scale spacing | Zero lint findings: spacing uses one named 4pt step or its negative. Safe-area and measured layout geometry are explicit exceptions; no half steps or sums to invent new spacing. |
| Mixed icon styles | Zero emoji icons or mixed stroke weights. The single 24-unit SVG set uses stroke 1.5 throughout (`lint:tokens`). |
| Placeholder empty states | Each empty state names what is absent and gives a useful next action or explicitly says nothing needs doing; zero lorem ipsum, dummy metrics or simulated work. |

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

### 2.1 Designed values and enforcement

Orb Teal's values are intentional, not browser defaults:

| Family | Values and use |
|---|---|
| Spacing | `space/1…8` = **4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 px**: hair / tight / snug / base / roomy / group / section / page. Fixed across every package because spacing is structure. |
| Type | Body **16 px**, ratio approximately **1.2**, rounded to whole pixels: caption **11**, small **13**, body **16**, h3 **19**, h2 **23**, h1 **28**. Regular **400**, strong **600**; tight line height **1.25**, body **1.5**. Body copy stays readable; hierarchy comes from size, weight and space. |
| Radius | Control **8 px** (`radius/input`, including a growing composer); container **12 px** (`radius/card`, cards, sheets, bubbles); fixed-height pill **999 px** (`radius/pill`, badges and round icon buttons). Never bind radius to rendered height. |
| Elevation | Exactly two tokens: card **0 1px 2px** and raised **0 12px 32px**, with teal-black alpha shadows. Raised is for sheets/overlays; do not put it on every card. |
| Motion | Fast **150 ms**, standard **225 ms**, slow **300 ms**, one `cubic-bezier(0.25, 0.1, 0.25, 1)` curve. Pulse **1800 ms**, breathe **6000 ms** are whole multiples of slow. Reduced motion stops loops and uses **1 ms** transitions. |
| Icons | `ICONS` in `ui/js/components.js`: a single **24-unit**, **1.5-stroke** SVG vocabulary; no emoji or second set. |

`lint:tokens` checks raw values and off-scale spacing/type/radius in CSS and static inline styles, growing pills, gradients, emoji and icon stroke. Safe areas, measured geometry, hairline compensation and fixed layout dimensions are not invented spacing. `check:themes` checks the lead against the spacing, ratio, radius, elevation and motion rules in every mode. Secondary packages' remaining scale findings are reported, not hidden; they are not promoted until the same checks and rendered review pass. Runtime package validity and contrast remain required for all packages.

## 3. Starter packages (ship in core)
- **Orb Teal** (default, dark): deep teal living gradient background, luminous orb, frosted glass cards, soft green-teal accent. Source: concepts D/E/H.
- **Companion Light** (secondary, not yet at the rendered-review bar): warm cream surfaces, soft coral-warm accent with teal orb retained, serif display + clean sans body. Source: concepts B/F.
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
Orb (states, fixed: idle/listening/working/speaking/needs-you/stopped/offline — §1) · BriefCard · HandlingCard (task rows) · TaskRow · VerifiedResultCard (with evidence viewer) · LookingIntoItCard · DeviceRow · DeviceMeshCard · HealthCard · MemoryHighlightCard · ApprovalSheet (tiered, plain-language permissions) · TriggerRow (schedule/event with pause/delete) · ChatBubble set · Composer (text/voice) · Toast/ProactiveBanner · SettingsRow · EmptyState ("Nothing needs you" is a valid, designed state).
