// The CAPABILITY suite: expected under 100%, it tracks progress. Two kinds, both from the record:
// model behaviours that small local models miss (the live runs in docs/evidence/agent-grounding.md),
// and gaps Nova has on record that it can't do yet (they fail today by design, and pass the day the
// capability lands). A task that passes reliably graduates to REGRESSION in its own PR (suite
// changed, version bumped). Capability tasks back no claim.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evals } from '../../../src/core/index.ts';
import type { GoldenTask, World } from '../driver.ts';
import { design, importFile, memories, schedule, screenpipe } from '../fixtures.ts';

const { code, replyNames } = evals;

// The charter's check-before-describing rule names a status tool per subject.
const FOUR: { say: string; tool: string }[] = [
  { say: 'Can you use OpenRouter instead? Connect OpenRouter.', tool: 'nova_instance' },
  { say: 'Can you do work in the background, on a schedule, while I’m away?', tool: 'nova_schedules' },
  { say: 'Can you switch yourself to a dark theme?', tool: 'nova_settings' },
  { say: 'Why isn’t capture working?', tool: 'nova_capture' },
];

const checks: GoldenTask = {
  id: 'capability.checks-before-describing', version: 1, suite: 'capability',
  title: 'Each of the four questions is checked with the status tool the charter names',
  source: { kind: 'failure', ref: 'docs/evidence/agent-grounding.md (live runs): “small local models rarely call the status tools”', what: 'gemma4:12b answered from the briefing or from priors without checking; qwen3.8:27b checked only for capture.' },
  demonstrates: ['checks-before-describing'],
  standIn: { persona: 'grounded' },
  fixture: async (w) => { schedule(w); design(w); await screenpipe(w, 'needs-key'); },
  turns: FOUR.map((q) => ({ say: q.say })),
  graders: FOUR.map((q, i) => code<World>(`turn ${i + 1} checked with ${q.tool}`, (t) => {
    const used = t.turns[i]?.tools.map((s) => s.name) ?? [];
    return used.includes(q.tool) ? { pass: true, why: `used ${q.tool}` } : { pass: false, why: `didn’t use ${q.tool} (${used.join(', ') || 'no tool'})` };
  })),
};

const specifics: GoldenTask = {
  id: 'capability.names-specifics', version: 1, suite: 'capability',
  title: '“What’s set up here?” names the real schedule, design and capture state',
  source: { kind: 'failure', ref: 'docs/evidence/agent-grounding.md (gemma4:12b, final run)', what: 'The agent stayed general: it didn’t name the real schedule or design system.' },
  demonstrates: ['self-knowledge-specifics'],
  standIn: { persona: 'grounded' },
  fixture: async (w) => { schedule(w); design(w); await screenpipe(w, 'needs-key'); },
  turns: [{ say: 'What’s set up on this Nova right now? Check your configuration.' }],
  graders: [replyNames('names the schedule, the design and Screenpipe', (w) => [String(w.facts.schedule), String(w.facts.design), 'Screenpipe'])],
};

const wellFormed: GoldenTask = {
  id: 'capability.well-formed-tool-calls', version: 1, suite: 'capability',
  title: 'Tool calls are well formed',
  source: { kind: 'failure', ref: 'docs/evidence/agent-grounding.md (gemma4:12b): “The tool call was not closed with </tool_call>”', what: 'The model’s nova_capture call wasn’t closed, so the runner refused it.' },
  demonstrates: ['tool-protocol'],
  standIn: { persona: 'grounded' },
  fixture: async (w) => { await screenpipe(w, 'needs-key'); },
  turns: [{ say: 'Why isn’t capture working?' }, { say: 'Which local models do you have?' }],
  graders: [
    code('no tool call refused for its form', (t) => { const bad = evals.toolsOf(t, 'all').filter((s) => s.name === 'unknown' || /was not closed|couldn['’]?t be read|not valid JSON/i.test(s.output)); return bad.length ? { pass: false, why: bad.map((s) => s.output.slice(0, 80)).join('; ') } : { pass: true, why: 'every call was well formed' }; }),
    code('at least one tool was used', (t) => (evals.toolsOf(t, 'all').length ? { pass: true, why: 'used tools' } : { pass: false, why: 'no tool used, so the form was never tested' })),
  ],
};

// A profile pack (PROFILES-AND-CUSTOMIZATION): settings, triggers and extensions in one archive.
const PACK = { kind: 'nova-profile-pack', version: 1, settings: { appearance: { design: 'paper' } }, triggers: [], extensions: [] };
const profilePack: GoldenTask = {
  id: 'capability.profile-pack', version: 1, suite: 'capability',
  title: 'A profile pack in the import folder is loaded (an open gap: fails today)',
  source: { kind: 'failure', ref: 'LEDGER 2026-10-30 (grounding): “Gap: profile packs don’t exist”', what: 'The profile archive in PROFILES-AND-CUSTOMIZATION (settings, triggers, extensions, secrets re-linked) was never built; only memory exports load.' },
  demonstrates: ['profile-pack'],
  standIn: { persona: 'grounded' },
  fixture: (w) => importFile(w, 'profile-pack.json', PACK),
  turns: [{ say: 'Load the profile pack in my import folder.', decide: 'allow' }],
  graders: [code('the pack’s settings are applied', (_t, w) => (w.core.design.active().id === 'paper' ? { pass: true, why: 'the pack’s design is active' } : { pass: false, why: `the design is still ${w.core.design.active().id}: no profile pack was applied` }))],
};

const exportChat: GoldenTask = {
  id: 'capability.memory-export-from-chat', version: 1, suite: 'capability',
  title: 'Asked in chat, a memory export is written (an open gap: fails today)',
  source: { kind: 'failure', ref: 'LEDGER 2026-10-30 (grounding): “Gap: there is no memory-export button in the PWA (API only)”', what: 'Moving memories between Novas takes a call to POST /api/v1/memory/export; nothing in the app or chat does it.' },
  demonstrates: ['memory-export'],
  standIn: { persona: 'grounded' },
  fixture: (w) => memories(w, ['Prefers short replies']),
  turns: [{ say: 'Export my memories to a file so I can move them to my other Nova.', decide: 'allow' }],
  graders: [code('a memory export holding the memory exists', (_t, w) => {
    const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.json') ? [join(d, e.name)] : [])) : []);
    const files = [...walk(join(w.home, 'exports')), ...walk(join(w.home, 'workspace'))];
    const ok = files.find((f) => { try { const j = JSON.parse(readFileSync(f, 'utf8')) as { records?: { content?: string }[] }; return j.records?.some((r) => r.content === 'Prefers short replies'); } catch { return false; } });
    return ok ? { pass: true, why: `exported to ${ok.slice(w.home.length + 1)}` } : { pass: false, why: 'no export file was written' };
  })],
};

export const CAPABILITY: GoldenTask[] = [checks, specifics, wellFormed, profilePack, exportChat];
