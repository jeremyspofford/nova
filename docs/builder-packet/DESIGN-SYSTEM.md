# DESIGN SYSTEM — foundation

This is the contract between Nova's product design and every line of UI code. It defines (a) the design language, (b) the token schema all packages must implement, (c) the package/hot-swap mechanism. Approved visual references: concepts E–H (round 2) as one language; A for feature set; B/F for conversational warmth; D/E/H for the ambient home.

## 1. Design language (applies to every package)
- **The Orb is Nova's face.** A luminous sphere of abstract light. **No face, no features, ever.** Identity and state are expressed through light: color temperature, brightness, motion (breathing idle, gentle pulse while working, slow swirl while listening, steady bright when speaking, warm amber when it needs you, red only for real alerts). One orb component, token-driven, reused at every size — hero presence on the home, avatar in chat, status in the rail.
- **Cards are the unit of information.** Briefs, tasks, devices, results: rounded cards with one job each, generous padding, one headline, at most a few lines. If content needs more, it gets a detail view — the card never becomes a table.
- **Density is capped.** Default surfaces show the minimum that matters. Power detail (logs, diffs, full device lists, raw health) lives one layer down, on demand. Dense cockpit layouts are an anti-pattern for Nova.
- **One status vocabulary.** Everywhere: Quiet / Working / Waiting / Verified / Needs you / Failed — with fixed semantic colors from tokens. "Verified" always carries its evidence affordance (tap → evidence).
- **"Nova is handling"** is the standard component for background work: task rows with plain-language titles and status, expandable to the ledger entry.
- **Calm motion.** Slow, small, purposeful. Motion conveys state (orb, status transitions), never decoration for its own sake. Reduced-motion setting honored everywhere.

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
A design system is an extension (EXTENSION-MODEL) with kind `design-system` and the manifest of CONTRACTS §4 plus: `tokens{}` (full schema of §2), `components{}` (per-component token bindings and any package-specific variants), `content_rules` (may tighten, never loosen, the content rules of §6), `extras[]` (declared signature surfaces), `preview` (thumbnail/screenshot set).
- **Apply path**: install → validate completeness → preview (applies to a sandboxed frame or a single device on request) → apply: tokens are CSS variables (web) swapped at runtime — **no rebuild, no restart** → previous package kept for one-click rollback.
- Scope: per user (all devices) or per device override. Sync of the choice follows the profile.
- Native clients later compile the same token set to native themes; a package valid for the PWA is valid for native.
- Nova's foundry may author packages the same way it authors extensions (sandbox, tests = validation + screenshot diffs, approval, removable).

## 5. Layouts and postures (code-level, package-independent)
Layouts are chosen by viewport + posture, never by device name:
- **Phone / foldable cover screen** — Ambient Home: orb hero, greeting, card stack (Brief, Nova is handling, Devices, Smart Home, Memory highlight), bottom tabs (Home, Chat, Tasks, Memory, More).
- **Chat** — single centered conversation column, orb avatar, "looking into it" working cards inline (H-right), composer with voice.
- **Tablet / foldable inner / half-open** — two-pane: conversation or home + one contextual pane; half-open may split conversation (top) and active card/result (bottom).
- **Desktop/laptop** — Calm Control (G): slim rail (orb + ≤6 destinations), center column (conversation/brief), optional right column with at most three quiet cards (Active Tasks, Device Mesh, System Health) — collapsible, off by default on smaller widths.
Every layout exposes the same features; layouts differ in arrangement only.

## 6. Content and formatting rules (binding)
- Implements NOVA-SPEC §5: concise by default, plain language, overview first, depth on demand.
- Per-channel renderings of the same content object: **spoken** (no markup, short sentences, numbers spoken naturally), **chat** (light structure, short paragraphs, lists only when enumerating real items), **card** (headline + ≤3 lines + one action), **brief/report** (structured, evidence attached), **notification** (one line + one action).
- Status and errors in human terms with the technical detail one tap away. An error the user can't act on is phrased as what Nova is doing about it.
- Numbers that drive decisions (cost, time, stakes) are shown with their basis; no naked percentages without denominators where the package renders decision content.

## 7. Component inventory (v1 — each specced with states)
Orb (states: idle/listening/working/speaking/attention/alert/offline) · BriefCard · HandlingCard (task rows) · TaskRow · VerifiedResultCard (with evidence viewer) · LookingIntoItCard · DeviceRow · DeviceMeshCard · HealthCard · MemoryHighlightCard · ApprovalSheet (tiered, plain-language permissions) · TriggerRow (schedule/event with pause/delete) · ChatBubble set · Composer (text/voice) · Toast/ProactiveBanner · SettingsRow · EmptyState ("Nothing needs you" is a valid, designed state).
