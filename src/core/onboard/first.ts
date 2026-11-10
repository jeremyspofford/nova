// The first view at the end of setup (Amendment 2026-10-31-B Part 2; docs/plans/M10f.md §3): what was
// found, what was imported, this device's roles and backend, and ONE suggested first action, never a
// blank chat alone.
//
// The action comes from a short list of intents, each with the eval tags that back it (the closing
// rule: nothing is claimed in onboarding that the eval suite can't demonstrate). Only an intent whose
// every tag a REGRESSION task demonstrates may be offered; tests/core/onboard.test.ts checks the list
// against the suite, so an intent can't be added here without the evidence.
import type { Discovery } from './discover.ts';
import type { Imported } from './sources.ts';

// The import folder in words: the full path, and that it is on the hub (a phone has its own files).
export const importWords = (dir: string) => `${dir} on the hub, the computer Nova runs on,`;

export interface FirstAction { id: string; label: string; why: string; go: 'memory'; needs: readonly string[] }

export const FIRST_ACTIONS: readonly (FirstAction & { when: (s: { waiting: number }) => boolean })[] = Object.freeze([
  {
    id: 'review-imports', label: 'Review what Nova brought in', go: 'memory', needs: ['import', 'memory-review'],
    why: 'It waits in Memory for your OK. Keep what is right; nothing is remembered until you do.',
    when: (s: { waiting: number }) => s.waiting > 0,
  },
  {
    id: 'bring-notes', label: 'Bring in your notes', go: 'memory', needs: ['first-run', 'import'],
    why: 'Put notes, a profile you wrote or an export from another assistant in {import}, then tell Nova. They wait in Memory for your OK.',
    when: () => true,
  },
]);

export interface FirstView {
  found: Discovery['found'];
  looked: boolean;
  imported: Imported[];
  waiting: number;
  // gpu: Nova found a GPU here; with the compute role, it brings the Models step into setup (model-fit step 3).
  device: { words: string; roles: string[]; roles_words: string; backend: string; backend_words: string; gpu: boolean };
  action: FirstAction;
}

// `importDir`: where this Nova reads imports, said in full (F-045): `{import}` in a why is that
// folder, on the hub, never "~", which a person reads as their own home folder.
export function firstAction(waiting: number, importDir = 'the import folder in Nova’s home folder'): FirstAction {
  const a = FIRST_ACTIONS.find((x) => x.when({ waiting }))!;
  const { when: _w, ...action } = a;
  return { ...action, why: action.why.replace('{import}', importWords(importDir)) };
}
