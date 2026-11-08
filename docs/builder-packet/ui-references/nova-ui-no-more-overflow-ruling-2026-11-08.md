# Owner ruling: no "More" overflow navigation (2026-11-08)

Evidence: Jeremy's screenshot of the live preview (Memory surface, wide posture), filed as `nova-ui-more-popover-owner-shot-2026-11-08.jpg`. The rail shows Chat, Tasks, Memory, Automations, then a "More" item; tapping it opens a floating popover (Skills, Activity, Health) anchored over the page content like a modal at the bottom of the screen.

## Jeremy's ruling, verbatim in substance
He does not want a "More" item in the rail that opens a modal/popover at the bottom of the page. He has said "fix the UI" repeatedly; this pattern is part of what he means.

## The rule (add to the design system + slop checklist)
1. **No overflow navigation.** Every primary destination is directly reachable: at wide widths the rail shows ALL destinations (icon + label; the rail may scroll internally if the list is long — the page content may not be covered). At phone widths the full destination list lives in the drawer (the #378/#379 direction), complete, not truncated behind a second menu.
2. **No nav popovers.** Navigation never opens a floating panel over content. Popovers/modals are for actions on the current surface, never for moving between surfaces.
3. **Badges must not hide behind overflow.** The red dot on "More" concealed that Health has a problem — a needs-you signal the owner cannot identify without opening the menu is a failed signal. (The status icon system now in build is the proper carrier for this.)

## Also visible in the same screenshot — fix in the same pass
- **Settings icon is a sun/brightness glyph.** Settings gets a gear or an unambiguous settings glyph; an icon that reads as display brightness is a wrong icon.
- **The orb renders as a flat red disc** (the F3 depth problem from 2026-10-31, still live). The status icon system + Nebula theme match already queued are the fix path; this screenshot is the before-picture.

## Process note
The rail shipped in #377 as code, without an owner-reacted composition for this posture — the composition gate in Part 2 of the 2026-11-06 paste existed to catch exactly this. The fix PR must include screenshots at phone and wide postures showing every destination reachable with no overflow item.
