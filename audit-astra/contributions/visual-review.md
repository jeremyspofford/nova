# Visual and interaction review contribution

Baseline: merged `d948aa0a442a9f930b86f4516eeea21981b76714`. New screenshots come from this audit's disposable instance, not the owner-deployed preview. Screenshot observations establish appearance only. The separate status-icon probe described below is a functional rendering diagnostic. No product source was changed.

## Preserved strengths

- **Empty Chat is the strongest composition reviewed so far.** At 1440×900 it keeps one reading/composing column, a clear composer, three restrained examples, a visible Local only label and an explicit explanation that voice is unavailable because browser speech recognition may use cloud processing. The owner artwork is recognizably the same asset family at hero and rail sizes. The screen reflects the restraint in the filed Claude.ai reference without copying its branding. Evidence: `evidence/screens/desktop-chat.png`, `desktop-new.png`; reference `docs/builder-packet/ui-references/claude-ai-chat.jpg` inspected.
- **Home and Tasks use differentiated hierarchy.** Home's brief, verified result, memory, devices and health have different weights and jobs rather than equal KPI tiles. Tasks uses a task row, clear Done and checked grouping, and a separate Verified evidence affordance. The spacing is calm rather than a dense cockpit. Evidence: `desktop-home.png`, `desktop-tasks.png`. This is a useful foundation for the Things-like daily-use loop; the filed Things 3 reference was inspected.
- **The mark is integrated as artwork.** `ui/js/status-icon.js:1–9` and `:154–175` use the supplied texture, with an explicit Canvas2D fallback; `:139–149` preserves the dark core. This audit recommends treatments and readable state text only, never a new mark or geometry.
- **State is not solely exposed through pixels.** `statusIcon()` sets role/name/title (`ui/js/status-icon.js:367–398`); task icons are decorative beside status words (`ui/js/components.js:112–117`). This is valuable even where visual distinctions need repair.
- **Ordinary empty-state wording mostly explains the future content.** Memory says what it retains and offers one concrete action; Tasks explains verification; Automations distinguishes existing schedules from a digest ready to configure. These are substantially better than generic “No data” screens. Evidence: `desktop-memory.png`, `desktop-automations.png`.

## Daily-use issue folded into NOVA-084

The visually dominant Home Brief says “A daily brief arrives here once you set one up” but gives no setup action. More fundamentally, `ui/js/surfaces.js:145` always calls `briefCard()` with no brief, and `ui/js/components.js:99–104` says no workflow exists. A morning digest setup does exist on Automations, but reports go to the main conversation, not this Home card (visible text in `desktop-automations.png`). This is a broken connection between existing product concepts, not a request to add another AI feature.

For NOVA-084's smallest coherent repair: show truthful scope, link directly to the existing digest setup where useful, and stop promising that configured digest content will appear in this unconnected card. Connecting the actual last completed digest should be a separate acceptance step: one canonical run/report source, time and freshness, evidence/source link, and explicit empty/failed/disabled states. Do not manufacture a brief from fixtures or insert a decorative dashboard.

## NOVA-120 — idle and thinking are visually identical in the Canvas2D fallback

- Category: defect. Gap class C (exposed state treatment incomplete).
- Severity: medium. Implementation priority: P2, after privacy/deletion repairs and before broad device-readiness claims.
- Confidence: high. Evidence classification: observed isolated browser-rendering diagnostic plus established code cause.
- Affected user/consequence: users on clients without working WebGL, including GPU-disabled browser environments, cannot distinguish “nothing is happening” from “thinking” by the status artwork. ARIA labels still differ; this is not a claim that all progress feedback or assistive access is absent.
- Baseline: frozen merged source and disposable audit server at that source; owner-deployed version unverified.
- Reproduction: run `node audit-astra/diagnostics/visual-mark-fallback.mjs` with the pinned Node26 and Chromium. The script launches a separate browser process, blocks service workers, forces reduced motion, deliberately refuses only WebGL contexts, opens the read-only styleguide, then renders eight existing `statusIcon()` states at 96px using the production component. It compares the canvases' PNG data and saves their appearance. No Nova data or product files are modified.
- Observed: renderer reports `canvas2d`; idle and thinking PNG pixels are byte-identical. Their accessible labels are respectively idle and thinking. Other sampled pairs differ. The diagnostic does not establish a perceptual threshold for the other differences.
- Expected: the fallback should preserve a perceptible distinction between these semantic states, including reduced motion, while using the owner's artwork unchanged. The state still needs a readable name. This follows DESIGN-SYSTEM §1's requirement that states remain distinct without relying solely on hue/motion; thinking is the app's finer-grained working state.
- Evidence: `evidence/visual-mark-fallback.json`, `evidence/visual-mark-fallback.png`, `evidence/visual-mark-fallback.log`; reproducible audit script `diagnostics/visual-mark-fallback.mjs`.
- Root cause: thinking differs from idle only in hue/twirl (`ui/js/status-icon.js:83–89`); the Canvas2D compositor applies saturation/tint/brightness but none of hue/twirl/pulse (`:290–303`). Thus those states collapse to the same pixels in fallback. Existing fallback tests assert that every state is drawn, not pairwise distinguishability (`tests/ui/status-icon.test.ts:340–361`).
- Smallest coherent change: give thinking a fallback-compatible treatment with a meaningful brightness/tint distinction and retain/readably expose the state name; do not redraw the mark. Avoid attempting to recreate a shader with new geometry.
- Components: status-icon renderer, status treatment contract, status-icon styleguide/test coverage; possibly text placement in shell if adding always-visible status words.
- Dependencies/decisions: no owner-artwork redesign approval needed; exact treatment should follow the existing rendered styleguide recognition process through the builder.
- Acceptance: deliberately refuse WebGL; at 16/24/48/96px, confirm idle and thinking differ in both normal and reduced-motion modes; confirm stopped remains reserved for stopping failures and needs-you remains amber; verify accessible names still match source state. Have a reviewer identify the two states without relying on color in a labeled comparison. Do not equate nonidentical hashes alone with a perceptual pass.
- Regression: extend the existing fallback test to compare relevant pairs and capture the actual artwork at small sizes; retain shader-path tests. No additional model calls.
- Effort: 0.5–2 engineering days plus rendered review, assuming treatment-only change and existing test harness.
- Status: confirmed; not implemented.

## Jarvis assessment and future acceptance constraints

Jarvis is **a styleguide composition, not a second implemented theme**. `ui/js/sg-jarvis.js:1–4,12–17` and `docs/ledger/2026-11-08-jarvis-compositions.md` explicitly say there is no design-system manifest, Appearance choice or runtime status integration. The committed composition screenshots `docs/screenshots/jarvis-compositions-2026-11-08/jarvis-desktop-1440x900-nebula-dark.png` and `jarvis-phone-390x844-nebula-dark.png` were visually inspected as baseline design artifacts, not credited as this audit's runtime tests.

Useful ideas: one restrained cyan family, structural state variation, explicit amber/red meanings, small-size simplification, real speech-amplitude option and a reduced-motion comparison. The near-black presentation supports an optional instrument view without requiring every everyday surface to become a HUD. Its large state catalog is a review surface, so the catalog's many controls should not be scored as app clutter.

Limitations: the mobile styleguide spends almost a full 844px first screen on introduction before showing the specimen; better anchor placement would make owner review more direct. The existing ledger already records faint 16px listening/offline states and weak greyscale distinctions, so those remain qualification work rather than a newly discovered shipped defect. `ui/styles/jarvis-rings.css:69–77` fills an eight-segment arc on a clock; before any runtime integration, it must be unambiguously indeterminate or bound to measured work. A filling meter must never imply completed work if it is only an animation. The proposal must also be reconciled with the owner's artwork requirement: use approved status treatment/optional instrument framing, never quietly replace the identity mark.

## User-understanding recommendations tied to observed surfaces

1. After setup, offer one genuine useful next action on Home based on readiness: start a local conversation when a configured chat provider is ready; configure that provider when it is not; configure the existing digest only when its prerequisites are clear. The successful welcome-file proof can remain as evidence, but it should not become the lasting reason to return.
2. Give each technical concept an outcome label at first use: hub = “the computer keeping Nova running”; spoke = “a paired device”; chat model = “writes the conversation”; screening/decision model = “checks or chooses before action.” Preserve precise terms in details.
3. Explain privacy with the actual per-operation destination and data classes, not just a broad mode badge. The Chat Local only chip and voice warning already establish a good pattern. Distinguish “Nova is running” from “this capability is ready” without turning missing optional integrations into red system-stop states.
4. Keep the main work loop connected: Chat request → task → verified result/evidence → retained memory or digest. Canonical source links and contextual actions matter more than adding tours, celebrations, gamification or ambient motion.

## NOVA-121 — Home's first short-height viewport contains no useful action or work state

- Category: improvement. Severity: medium usability impact; implementation priority P2. Confidence: high for appearance, moderate for the proposed benefit until user observation.
- Affected user/consequence: people opening Nova on a short foldable cover screen must scroll past a full viewport of identity/greeting before finding work, a result or a next action. This is not a claim of inaccessible scrolling or data loss.
- Baseline/evidence: this audit's merged-source instance, Chromium-emulated 360×360, Nebula dark/reduced-motion. `evidence/screens/cover-home.png`, contrasted with `phone-home.png`; `evidence/ui-sweep.json` records viewport/document widths of360 with no horizontal document overflow. Owner-deployed and physical-device behavior unverified.
- Reproduction/observed: open Home at360×360 on the fresh setup profile. First viewport contains menu,112px artwork, greeting and date/status sentence; the first Brief/work/action row is below it. At390×844 the same hero consumes roughly the first350px. Expected design outcome: immediate access to the most relevant work or action on a short viewport while retaining Nova's identity.
- Root cause: Home's fixed hero size plus spacing is driven by width layout, with no short-height composition (`ui/styles/components.css:489–494`, `ui/styles/layout.css:137–154`; hero source `ui/js/surfaces.js:138–145`). Chat's captured short composition prioritizes the composer via flex allocation (`components.css:464–466`), providing a useful outcome to emulate without claiming an explicit height breakpoint exists there.
- Smallest coherent change: a short-height Home composition with the same artwork at the small status size and a compact greeting, then the highest-priority work or next-action row. Keep the normal phone hero when space permits. Do not redraw the artwork or add animation.
- Affected components: Home composition, shell/status placement, responsive styleguide specimen and posture tests.
- Dependencies: coordinate with NOVA-084 so the newly exposed row is truthful/useful; rendered-entry owner recognition follows the project's builder workflow.
- Acceptance: at340–390px viewport heights and340–390px widths, the first viewport shows one meaningful action or current work/result row in addition to navigation; no duplicate status artwork; no hidden controls under safe areas; text zoom200% still allows all content/actions via normal scroll. Compare390×844 and desktop to ensure normal layouts keep their hierarchy. Have a reviewer complete “find what needs me / start the next useful action” from Home in each posture.
- Verification: browser screenshots plus actual taps/keyboard navigation; physical foldable remains a separate qualification check. Automated bounding-box assertions alone do not establish usability.
- Effort:1–3 engineering days including styleguide/review and posture regressions; assumes no new backend.
- Status: proposed improvement, not implemented.

## Additional visual findings and scope discipline

Phone Home, empty Chat, Tasks, Memory, Health, Settings list, Capture and Topology remain readable as a single column at390×844. I saw no visible horizontal clipping in those captures. The sweep's three overflow entries per phone route are closed-drawer buttons wholly offscreen at negative x, not evidence of broken page width. Body/document width remained390px. Small text-link boxes alone are not sufficient to claim WCAG2.5.8 failure because spacing/inline exceptions must be assessed.

Automations on phone spends more than700px on two empty groups and their explanations before the useful Morning digest setup. Simplify the empty grouping and put the existing next action nearer the top; this belongs with the daily-loop/wiring work, not a new automation system. Health's empty Problems region says “Nothing needs you” above absent supervisor/backup/drill setup. Preserve the distinction between a running system and a ready capability: offer quiet setup guidance, not indiscriminate red alarms for optional features. Evidence: `phone-automations.png`, `phone-health.png`, `desktop-health.png`.

The initial sweep's `/settings?cat=...` URLs did **not** visit the named categories: all rendered You and Nova, because Settings uses hash routes (`ui/js/app.js:1555–1558,1794–1796`). Those files must not be counted as13category tests. This was reported to the root for corrected hash/click traversal.

## Coverage limits

Visually inspected this audit's desktop Home, empty Chat/new conversation, Tasks, Memory, Automations, Health and Settings default; phone Home, Chat, Tasks, Memory, Automations, Health, Settings list, Capture, Topology and Pipeline;360×360 cover Home, Chat, Tasks, Memory, Health and Settings. The root's complete route sweep is broader than this focused visual read. Settings subsection screenshots await corrected hash traversal. Linear's filed AVIF could not be decoded by the image-viewing tool; its stated design qualities were read, but the image is not counted as visually inspected. Screenshots do not prove keyboard behavior, focus, dynamic validation, response times or task completion. The root's measured DOM/axe/workflow evidence is the authority for those claims.
