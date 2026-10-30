// Changes for the pipeline's tests (M7a): a daily wind-down reminder pack, a skill pack with a probe
// that holds or fails on live data, a design-system variant. Neutral placeholders only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

// A trigger-rule pack: one heartbeat rule at 21:00 with a message, tested to fire then and not at noon.
export function windDown(version = '1.0.0', o: { text?: string; cron?: string; tests?: unknown[]; probe?: unknown } = {}) {
  return {
    pack: { id: 'wind-down', name: 'Daily wind-down', version },
    rules: [{ name: 'Wind down', class: 'heartbeat', cron: o.cron ?? '0 21 * * *', action: { kind: 'message', text: o.text ?? 'Time to wind down for the evening.' } }],
    tests: o.tests ?? [
      { name: 'fires at nine in the evening', at: '21:00', expect: { rule: 'Wind down', fires: true, message: true } },
      { name: 'quiet at noon', at: '12:00', expect: { rule: 'Wind down', fires: false } },
    ],
    probe: o.probe ?? { name: 'the reminder is listed', path: '/triggers/rules', expect: [{ at: 'length', op: 'gte', value: 1 }] },
  };
}

// What the foundry's stand-in model writes for "remind me to wind down at nine": the JSON files
// contract, three files.
export function windDownFiles() {
  const p = windDown();
  return [
    { path: 'manifest.json', content: JSON.stringify({ pack: p.pack, rules: p.rules }, null, 2) },
    { path: 'tests.json', content: JSON.stringify(p.tests, null, 2) },
    { path: 'probe.json', content: JSON.stringify(p.probe, null, 2) },
  ];
}

// A skill pack. `maxMemories`: its health probe says there are at most that many memories, which
// holds on a quiet copy and fails once live data grows past it.
export function notesSkill(version = '1.0.0', o: { maxMemories?: number; text?: string; tests?: unknown[]; manifest?: Record<string, unknown> } = {}) {
  return {
    manifest: {
      id: 'example-notes', version, kind: 'skill-pack', name: 'Example notes', capabilities: ['skill'], permissions: [], secrets: [],
      config_schema: {}, setup_flow: null,
      health_check: o.maxMemories === undefined ? {} : { probe: { name: 'memories stay few', path: '/memory', expect: [{ at: 'length', op: 'lte', value: o.maxMemories }] } },
      nova_compat: '>=0.1.0', on_remove: { delete: ['SKILL.md'], keep: [], export: [] },
      ...(o.manifest ?? {}),
    },
    files: { 'SKILL.md': `---\nname: example-notes\ndescription: Keeps short notes (v${version}).\n---\n\n${o.text ?? 'Write each note as one line.'}\n` },
    tests: o.tests ?? [{ name: 'the skill has its front matter', file: 'SKILL.md', frontmatter: ['name', 'description'] }],
  };
}

// A design-system variant of Orb Teal under its own id.
export function variant(id = 'example-dusk', o: { tokens?: Record<string, string>; drop?: string[] } = {}) {
  const base = JSON.parse(readFileSync(join(ROOT, 'design-systems', 'orb-teal.json'), 'utf8'));
  const tokens = { ...base.tokens, ...(o.tokens ?? {}) };
  for (const t of o.drop ?? []) delete tokens[t];
  return { manifest: { ...base, id, name: 'Example dusk', description: 'A variant for tests.', tokens }, probe: { name: 'design systems answer', path: '/design-systems', expect: [{ at: 'length', op: 'gte', value: 1 }] } };
}
