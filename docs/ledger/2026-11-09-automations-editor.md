**2026-11-09 · UI rebuild (design) · Automations rule editor: compositions for the owner's reaction**
- What changed: the design-first step of the wiring item "Automations rule editor (create/edit/fire/webhook token reveal)" (owner-priority-queue-2026-11-02.md item 4). /styleguide?entry=automations-editor, marked for the owner's reaction, has nine frames built from the real rule model (src/core/triggers.ts):
  - the list
  - empty
  - create, with in-place validation
  - edit, including off
  - run now, and its failure
  - token shown once
  - token afterwards
  - token rotate
  - phone and Duo cover single-column layouts for the list and create frames

  Nothing is wired into the app.
- What you can now do: react to the editor's design before it's built.
- Still unfinished: the app wiring waits for the owner's reaction. Where the backend differs from the queue item:
  - There are no conditions; the repeat window, rest time, quiet hours and settings are the closest.
  - Run now only works for schedule and proactive rules; webhook and connection rules refuse it.
  - A failed run is a dropped run whose reason starts "Nova couldn't start the task…".
  - The token is shown once and only its hash is kept, but there is no hint and no rotate route. Those two frames are proposals that need backend work; today, changing a token means deleting and recreating the rule.
- Checked: locally, before CI.
  - tests/ui/automations-editor-styleguide.test.ts, in Chromium and WebKit: every frame in dark and light, no CSP violations, nothing sent, 44 px targets, labelled controls, unique ids, a status icon in every row, and one full-width column on the phone and the Duo cover.
  - The CSP UI test, styleguide-coverage 4/4, lint:tokens and typecheck.
  - Screenshots are in docs/screenshots/automations-editor-2026-11-09/.
