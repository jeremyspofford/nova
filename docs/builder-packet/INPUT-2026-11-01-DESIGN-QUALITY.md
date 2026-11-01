# INPUT 2026-11-01 — Design quality system (owner direction, verbatim)

Filed verbatim as received. The referenced diagnosis document
(nova-design-quality-system-2026-11-01.md) was not in the packet
when this direction arrived; it is filed beside this one when the
owner supplies it.

---

Owner direction on design quality: the UI must stop looking
AI-built. The diagnosis (in the packet as
nova-design-quality-system-2026-11-01.md) is that DESIGN-SYSTEM.md
is a token schema without a design: no chosen direction, six
packages as equals, no exemplars, and no design step in the build
loop. Implement the five mechanisms:

1. DESIGN-SYSTEM §0 — Art direction. Add: exemplars per surface
   family (chat = best-in-class conversational restraint; control
   surfaces Home/Tasks/Health/Activity = Linear/Raycast density
   and crispness; Settings = macOS Settings / Raycast settings
   clarity) and anti-references (generic SaaS dashboard, stock
   Tailwind/shadcn look, purple-gradient AI aesthetic, card-grid
   monotony, emoji as icons). Orb Teal is the LEAD package:
   perfect it first; other packages inherit its structure and
   re-express values only. Stop presenting six packages as
   equals in onboarding and Settings until each has passed the
   same bar.
2. LIVING STYLEGUIDE. A /styleguide route rendering every
   component in every state with real Nova content. Rule, recorded
   in OPERATING-RULES: a component that is not in the styleguide
   does not ship.
3. DESIGN-FIRST WORKFLOW. For any new surface or component, the
   first deliverable is the styleguide entry (rendered). The
   owner approves the rendered entry before app code is written.
   App code composes only styleguide components; UI PRs include
   screenshots matched against the styleguide rendering.
4. DESIGNED VALUES PASS on the lead package: 4pt spacing scale
   (named steps, no off-scale values), ratio-based type scale
   with real hierarchy, at most two elevation levels, radius
   steps bound to component size class (never rendered height),
   motion tokens (one duration/easing family), one icon set at
   one stroke weight. Token lint extended to catch off-scale
   spacing/type/radius values, not just raw hex.
5. SLOP CHECK IN THE GATE. Add the AI-slop list to DESIGN-SYSTEM
   (uniform equal-weight card grids; everything centered;
   decorative gradients; more than one standout per view; flat
   type hierarchy; off-scale spacing; mixed icon styles;
   placeholder-looking empty states) and require every UI PR to
   state its self-check against it alongside the posture
   screenshots.

Sequence: §0 + styleguide + values pass first (one design PR the
owner reviews as screenshots), the workflow rules take effect for
the next new surface after that. Existing surfaces get conformed
opportunistically per the UX fix list, not in a big-bang rewrite.
