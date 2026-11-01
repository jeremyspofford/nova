# Design quality — stage-2 follow-up queue

Source: [owner approval of stage 1](../builder-packet/INPUT-2026-11-01-DESIGN-STAGE1-APPROVAL.md), 2026-11-01.

Stage 1 approves the machinery: §0, the living styleguide, token values and the slop gate.
It does not establish that the following visual problems are solved. This queue records
priorities, not a new milestone or permission to displace the orchestration roadmap.

1. **Desktop card hierarchy.** Existing desktop cards currently carry one visual weight.
   Make the information hierarchy visible; show matching before/after desktop screenshots.
2. **Small rail-orb depth.** The desktop rail orb reads flat, while the phone hero orb works.
   Judge the orb at its actual rail size, with the phone hero as a separate comparison.
3. **Background-gradient discipline.** Review where gradients are used and how strongly they
   compete with content. Show the visible result on the affected surfaces.

**Stage-2 acceptance:** visible differences in matched screenshots. Tightened token values
or a stronger lint result alone do not satisfy the owner. Keep the same viewport, seeded
data, theme and state on both sides so the comparison is meaningful. New surfaces still
follow the approved design-first styleguide workflow; no stage-2 design is pre-approved.

**Stage-1 evidence correction:** `tests/ui/composer-f0.test.ts` covers the actual F0 window
(1280×820) with a 20-line draft, in Chromium and WebKit. Its full-window screenshots and
measured geometry are linked in the stage-1 review packet. This protects the existing
composer fix and does not substitute for any stage-2 visual improvement.
