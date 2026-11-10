**2026-11-09 · UI rebuild (design) · Messages inbox and quiet hours: compositions for the owner's reaction**
- What changed: the design-first step of the wiring item "messages inbox / quiet hours". /styleguide?entry=inbox, marked for the owner's reaction, has eight frames built from the real model (src/core/triggers.ts): the list, open, held, released, quiet hours, editing them, and phone and Duo cover layouts. Nothing is wired into the app.
- What you can now do: react to the inbox and quiet-hours design before it's built.
- Still unfinished: the wiring waits for the owner. Mismatches found:
  - Messages from Nova's own parts are always withdrawn when quiet hours end, never sent. The fix is a separate PR.
  - The Home banner can never show a message waiting for your OK.
  - The list endpoints don't include a message's source.
- Checked: tests/ui/inbox-styleguide.test.ts 2/2 in Chromium and WebKit, styleguide-coverage and evals claims 16/16, lint:tokens, typecheck. Screenshots are in docs/screenshots/inbox-compositions-2026-11-09/.
