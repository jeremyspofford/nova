// An agent's skill catalog (FR-045, FR-046; M8): in an agent's thread the catalog and skill.load
// know only the skills of the plugins connected to it, as the gate limits its tools; a skill
// such a plugin would have shadowed takes the name back, and other threads are unchanged.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nova/shared';
import { Logger } from '@nova/telemetry';
import { SkillIndex, UnavailableSandbox, type ToolContext } from '../src/index.ts';
import { ACCOUNT, makeAgentsEnv, type AgentsEnv } from './agents-env.ts';

let h: AgentsEnv;
let dir: string;

beforeEach(async () => {
  h = await makeAgentsEnv();
  dir = mkdtempSync(join(tmpdir(), 'nova-skills-agent-'));
});
afterEach(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

function skill(root: string, name: string, description: string): void {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\ndescription: ${description}\n---\nBody of ${name}.\n`);
}

function plugin(pluginId: string, skills: string[]): void {
  const root = join(dir, 'plugins', pluginId);
  for (const s of skills) skill(join(root, 'skills'), s, `${s} from ${pluginId}.`);
  const now = new Date().toISOString();
  h.env.db.raw
    .prepare(
      `INSERT INTO plugin_install (id, account_id, plugin_id, version, source, origin, manifest_json,
         install_path, registrations_json, installed_at, updated_at)
       VALUES (?, ?, ?, '1.0.0', 'local', ?, '{}', ?, ?, ?, ?)`,
    )
    .run(
      uuidv7(),
      ACCOUNT,
      pluginId,
      root,
      root,
      JSON.stringify({ skills: skills.map((s) => ({ name: s, path: `skills/${s}` })) }),
      now,
      now,
    );
}

function index(): SkillIndex {
  const builtin = join(dir, 'builtin');
  skill(builtin, 'review', 'review, built in.');
  const idx = new SkillIndex({
    db: h.env.db,
    userDir: join(dir, 'user'),
    builtinDir: builtin,
    log: new Logger({ module: 'test', sinks: [] }),
  });
  idx.useLimits(h.agents.toolLimits);
  return idx;
}

const load = (idx: SkillIndex, threadId: string, name: string) =>
  idx.tools.list(ACCOUNT).then(([t]) =>
    (t as unknown as { handler: (a: unknown, c: ToolContext) => Promise<{ ok: boolean }> }).handler(
      { name },
      {
        accountId: ACCOUNT,
        threadId,
        turnId: '',
        callId: 'c',
        projectId: null,
        origin: 'model',
        profile: { id: 'p', hash: 'h' },
        roots: [],
        sandbox: new UnavailableSandbox(),
        signal: new AbortController().signal,
        log: new Logger({ module: 'test', sinks: [] }),
      },
    ),
  );

describe("an agent's skill catalog", () => {
  it('lists only the skills of the plugins connected to the agent', async () => {
    plugin('acme', ['deploy']);
    plugin('other', ['review', 'scan']);
    const idx = index();
    const agent = await h.agents.create(ACCOUNT, { name: 'Scout' });
    const thread = agent.primaryThreadId!;

    // No connected list: every enabled plugin, as before.
    let catalog = await idx.catalogSection(ACCOUNT, null, 100_000, thread);
    expect(catalog).toContain('deploy');
    expect(catalog).toContain('scan');
    expect(catalog).toContain('review from other.');

    await h.agents.setPlugins(ACCOUNT, agent.id, ['acme']);
    catalog = await idx.catalogSection(ACCOUNT, null, 100_000, thread);
    expect(catalog).toContain('- deploy: deploy from acme.');
    expect(catalog).not.toContain('scan');
    // The built-in skill the unconnected plugin shadowed takes its name back.
    expect(catalog).toContain('- review: review, built in.');
    expect((await load(idx, thread, 'scan')).ok).toBe(false);
    expect((await load(idx, thread, 'other:scan')).ok).toBe(false);
    expect((await load(idx, thread, 'deploy')).ok).toBe(true);

    // Other threads, and calls without a thread, are not narrowed.
    const plain = await idx.catalogSection(ACCOUNT, null, 100_000, uuidv7());
    expect(plain).toContain('scan');
    expect(await idx.catalogSection(ACCOUNT, null, 100_000)).toContain('scan');

    // Nothing connected: no plugin skills at all.
    await h.agents.setPlugins(ACCOUNT, agent.id, []);
    catalog = await idx.catalogSection(ACCOUNT, null, 100_000, thread);
    expect(catalog).not.toContain('deploy');
    expect(catalog).toContain('- review: review, built in.');
  });

  it('leaves plugin skills out when a limit source fails (fail closed)', async () => {
    plugin('acme', ['deploy']);
    const idx = index();
    idx.useLimits({ forThread: () => Promise.reject(new Error('down')) });
    const catalog = await idx.catalogSection(ACCOUNT, null, 100_000, uuidv7());
    expect(catalog).not.toContain('deploy');
    expect(catalog).toContain('review');
  });

  it('intersects the plugins of several sources', async () => {
    plugin('acme', ['deploy']);
    plugin('other', ['scan']);
    const idx = index();
    idx.useLimits({
      forThread: () => Promise.resolve({ plugins: ['acme', 'other'], reason: 'x' }),
    });
    idx.useLimits({ forThread: () => Promise.resolve({ plugins: ['other'], reason: 'y' }) });
    const catalog = await idx.catalogSection(ACCOUNT, null, 100_000, uuidv7());
    expect(catalog).toContain('scan');
    expect(catalog).not.toContain('deploy');
  });
});
