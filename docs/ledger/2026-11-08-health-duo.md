**2026-11-08 · UI fixes · Health on the Duo cover screen (owner defects)**
- What changed: the owner's four Health defects (docs/builder-packet/ui-references/nova-ui-health-duo-cover-defects-2026-11-08.md, with the screenshot, filed here) are fixed at their causes. A permanent gate now covers the shape.
  1. Dead column: each problem row reused `.settings-row`, a flex row with the text in one box and "Mark as dealt with" in a `.settings-control` beside it. That pairing never collapses, so the text got 62% of the column at 380 px. Each problem is now one column at every width.
  2. Repeats: `playbookBlock` printed the last three repair records as they were. Identical NEIGHBOURS (same repair `name`, `ok` and `said`) now collapse into one entry with "N times, last <when>". The collapse happens before the last-three cut. Non-adjacent repeats stay separate. `at` and `by` aren't compared, because the line never shows who acted.
  3. Clipped markers: the chat's folded-steps rule from #383 (`.steps`, views.css) matched every `ol.steps`/`ul.steps` and overrode the list rule, cutting the left padding and drawing a left rule. It is scoped to `details.steps`, which fixes Health's "What you can do" and the other `.steps` lists in view.js and components.js. The chat baselines are unchanged.
  4. Floating action: a side effect of item 1. "Try the repair now" and "Mark as dealt with" now share one action row inside the card, under the steps.
  - The service worker cache moves to v63.
- What you can now do: read a Health problem at full width on a cover screen, with repeats folded, numbered steps intact and the actions in the card.
- Still unfinished: one thing.
  - The orb in Health's header is replaced by status icons part B (#389), not by this PR.
- Checked: locally, before CI.
  - Which gate missed the dead column: fold-postures' matrix test already opened /health at duo-cover (380×900) in both engines with an open problem. But its audit checks only overflow, lines under 8 characters, overlaps and card minimums, and a 60%-wide card beside an empty band, or a marker hanging past the card, trips none of them. Its screenshot baselines covered duo-cover only for /, /chat and /settings. posture-sweep checks layout only on /, and m9-fold measures Health only at 840 px and up.
  - The new permanent gate (fold-postures, both engines, 320–1440 px) uses a synthetic problem with repeated events and a numbered list (tests/ui/health-problem-fixture.ts). It checks:
    - the card spans the column
    - no marker starts left of the card, and no `.steps` list has a left rule
    - the actions are in the card
    - repeats are collapsed
    - new chromium and webkit duo-cover Health baselines match
    - Run against the pre-fix code, it fails on all four defects.
  - lint:tokens and typecheck pass.
  - Unit (ui-fixes, health-components): 18/18.
  - UI: fold-postures 5/5 (confirmed without the flag), health-caps-diagnostics 2/2, posture-sweep 2/2, m9-fold 4/4, m9-contrast 1/1, m7b-health 1/1, health-styleguide 2/2, chat-empty 1/1, m9-progress 3/3.
  - The shots walkthrough passed 133/133.
  - Before and after screenshots are in docs/screenshots/health-duo-cover-2026-11-08/.
