# DESIGN SYSTEM — foundation

This is the contract between Nova's product design and every line of UI code. It defines (a) the design language, (b) the token schema all packages must implement, (c) the package/hot-swap mechanism. Approved visual references: concepts E–H (round 2) as one language; A for feature set; B/F for conversational warmth; D/E/H for the ambient home.

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

## 6. Content and formatting rules (binding)
- Implements NOVA-SPEC §5: concise by default, plain language, overview first, depth on demand.
- Per-channel renderings of the same content object: **spoken** (no markup, short sentences, numbers spoken naturally), **chat** (light structure, short paragraphs, lists only when enumerating real items), **card** (headline + ≤3 lines + one action), **brief/report** (structured, evidence attached), **notification** (one line + one action).
- Status and errors in human terms with the technical detail one tap away. An error the user can't act on is phrased as what Nova is doing about it.
- Numbers that drive decisions (cost, time, stakes) are shown with their basis; no naked percentages without denominators where the package renders decision content.

## 7. Component inventory (v1 — each specced with states)
Orb (states, fixed: idle/listening/working/speaking/needs-you/stopped/offline — §1) · BriefCard · HandlingCard (task rows) · TaskRow · VerifiedResultCard (with evidence viewer) · LookingIntoItCard · DeviceRow · DeviceMeshCard · HealthCard · MemoryHighlightCard · ApprovalSheet (tiered, plain-language permissions) · TriggerRow (schedule/event with pause/delete) · ChatBubble set · Composer (text/voice) · Toast/ProactiveBanner · SettingsRow · EmptyState ("Nothing needs you" is a valid, designed state).
