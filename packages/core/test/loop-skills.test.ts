// Skills in the agent loop (FR-046, FR-196, docs/08 §4, docs/09 §11): the catalog joins the
// system context; `/name` loads a skill's body and the rest is the request; an unknown `/name`
// is ordinary text; an `@`-mention of a skill loads it too; its allowed tools are never deferred
// while it is active, also after the model loads it with skill.load; edits and steering resolve
// their own text; a plugin's skill taints the turn.
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedSkill } from '../src/index.ts';
import { DEFAULT_CONTEXT_TOKENS } from '../src/index.ts';
import { ACCOUNT, waitFor } from './helpers.ts';
import {
  fixedSkills,
  makeLoopEnv,
  mcpTool,
  recordingGate,
  systemText,
  userText,
  type LoopEnv,
} from './loop-env.ts';

let env: LoopEnv;
afterEach(() => env.close());

const review: ResolvedSkill = {
  skillId: 'skill:user:code-review',
  name: 'code-review',
  body: '## Instructions\n1. Read the diff.\n2. Report findings.',
  allowedTools: ['mcp:git.diff'],
  files: ['scripts/collect-diff.sh'],
};
const greet: ResolvedSkill = {
  skillId: 'skill:com.example.sample:greet',
  name: 'greet',
  body: 'Greet the user warmly.',
  allowedTools: [],
  files: [],
};

const ok = (text: string) => () =>
  Promise.resolve({ ok: true as const, content: [{ type: 'text' as const, text }] });
/** Two MCP tools; with a budget of one tool, both are deferred unless pinned. */
const gitTools = {
  source: 'mcp' as const,
  list: () =>
    Promise.resolve([
      mcpTool('mcp:git.diff', ok('diff output'), { serverId: 'git' }),
      mcpTool('mcp:git.log', ok('log output'), { serverId: 'git' }),
    ]),
};
const tiny = { tools: 1, schemaTokens: 10 };
const offered = (i: number) => env.mock.requests[i]?.tools?.map((t) => t.name) ?? [];

describe('the skills catalog (FR-046, docs/09 §11)', () => {
  it('joins the system context after the base prompt, sized for the context window', async () => {
    const skills = fixedSkills([review], '## Skills\n- code-review: Review a diff.');
    env = await makeLoopEnv({ skills, noTools: true });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'hi' });
    await env.chat.idle();
    const system = systemText(env.mock.requests[0]);
    expect(system).toMatch(/^You are Nova[\s\S]*\n\n## Skills\n- code-review: Review a diff\.$/);
    expect(skills.catalogCalls).toEqual([DEFAULT_CONTEXT_TOKENS]);
  });

  it('adds nothing when there are no skills or the catalog fails', async () => {
    const skills = fixedSkills([]);
    skills.catalogSection = () => Promise.reject(new Error('index broken'));
    env = await makeLoopEnv({ skills, noTools: true });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'hi' });
    await env.chat.idle();
    expect(systemText(env.mock.requests[0])).not.toContain('Skills');
    const detail = await env.threads.detail(ACCOUNT, t.id);
    expect(detail.messages[1]!.status).toBe('complete');
  });
});

describe('slash commands (FR-046)', () => {
  it('/name loads the body; the rest of the message is the request; its tools are never deferred', async () => {
    const skills = fixedSkills([review]);
    env = await makeLoopEnv({ skills, sources: [gitTools], budget: tiny });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: '/code-review check the auth module' });
    await env.chat.idle();

    expect(skills.resolved).toContain('code-review');
    const text = userText(env.mock.requests[0]);
    expect(text.startsWith('check the auth module\n\n## Skill: code-review\n')).toBe(true);
    expect(text).toContain('The user loaded this skill with /code-review.');
    expect(text).toContain(
      'Files in the skill (read them with skill.load): scripts/collect-diff.sh',
    );
    expect(text).toContain('1. Read the diff.');
    expect(text).not.toContain('<untrusted_data');
    // mcp:git.diff is pinned by the skill; mcp:git.log stays deferred behind tool.search.
    expect(offered(0)).toContain('mcp:git.diff');
    expect(offered(0)).not.toContain('mcp:git.log');
    expect(offered(0)).toContain('tool.search');

    // The message shows what the user typed; the slash skill is not a mention chip.
    const detail = await env.threads.detail(ACCOUNT, t.id);
    expect(detail.messages[0]!.parts).toEqual([
      { type: 'text', text: '/code-review check the auth module' },
    ]);
    expect(detail.messages[0]!.mentions ?? []).toEqual([]);
    expect(detail.messages[1]!.parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('You said: check the auth module'),
    });

    // A later turn without the skill defers its tools again.
    await env.chat.send(ACCOUNT, t.id, { text: 'thanks' });
    await env.chat.idle();
    expect(offered(1)).not.toContain('mcp:git.diff');
  });

  it('a bare /name is the whole request', async () => {
    env = await makeLoopEnv({ skills: fixedSkills([greet]), noTools: true });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: '/greet' });
    await env.chat.idle();
    const text = userText(env.mock.requests[0]);
    expect(text.startsWith('## Skill: greet\nThe user loaded this skill with /greet.')).toBe(true);
    expect(text).toContain('Greet the user warmly.');
  });

  it('an unknown /name, or no skills at all, is ordinary text', async () => {
    const skills = fixedSkills([review]);
    env = await makeLoopEnv({ skills, noTools: true });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: '/nope do it' });
    await env.chat.idle();
    await env.chat.send(ACCOUNT, t.id, { text: '/usr/bin is a folder' });
    await env.chat.idle();
    expect(skills.resolved).toEqual(['nope']);
    expect(userText(env.mock.requests[0])).toBe('/nope do it');
    const detail = await env.threads.detail(ACCOUNT, t.id);
    expect(detail.messages[1]!.parts).toEqual([{ type: 'text', text: 'You said: /nope do it' }]);
    await env.close();

    env = await makeLoopEnv({ noTools: true });
    const t2 = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t2.id, { text: '/code-review now' });
    await env.chat.idle();
    expect(userText(env.mock.requests[0])).toBe('/code-review now');
  });

  it('a plugin skill taints the turn: its content cannot authorize actions (FR-189)', async () => {
    const gate = recordingGate();
    env = await makeLoopEnv({ skills: fixedSkills([greet]), gate });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: '/greet\n/tool fs.list {}' });
    await env.chat.idle();
    expect(gate.requests[0]!.provenance.taint).toEqual(['plugin']);
  });

  it('an edit resolves its own text; the old slash skill does not carry over', async () => {
    const skills = fixedSkills([review, greet]);
    env = await makeLoopEnv({ skills, noTools: true });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: '/code-review look' });
    await env.chat.idle();
    const first = (await env.threads.detail(ACCOUNT, t.id)).messages[0]!;
    await env.chat.edit(ACCOUNT, t.id, first.id, { text: '/greet please' });
    await env.chat.idle();
    const text = userText(env.mock.requests.at(-1));
    expect(text).toContain('## Skill: greet');
    expect(text).not.toContain('code-review');
    expect(text.startsWith('please\n\n')).toBe(true);
  });

  it('steering input that starts with /name loads the skill into the running turn', async () => {
    const skills = fixedSkills([review]);
    env = await makeLoopEnv({
      skills,
      sources: [gitTools],
      budget: tiny,
      mock: { timing: { chunkDelayMs: 20 } },
    });
    env.settings.followUp = 'steer';
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'a long first answer with many words in it' });
    await waitFor(() => env.mock.requests.length > 0);
    const steered = await env.chat.send(ACCOUNT, t.id, { text: '/code-review and review it' });
    expect(steered.disposition).toBe('steered');
    await env.chat.idle();
    expect(env.mock.requests).toHaveLength(2);
    expect(userText(env.mock.requests[1])).toContain('## Skill: code-review');
    expect(offered(1)).toContain('mcp:git.diff');
  });
});

describe('skill mentions and skill.load (FR-046, FR-196)', () => {
  it('an @-mention of a skill loads its body and pins its tools; the chip stays', async () => {
    const skills = fixedSkills([review]);
    env = await makeLoopEnv({ skills, sources: [gitTools], budget: tiny });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, {
      text: 'please look at this',
      mentions: [{ kind: 'skill', ref: 'skill:user:code-review' }],
    });
    await env.chat.idle();
    const text = userText(env.mock.requests[0]);
    expect(text).toContain('please look at this\n\n## Skill: code-review');
    expect(text).toContain('The user loaded this skill by mentioning it.');
    expect(offered(0)).toContain('mcp:git.diff');
    const detail = await env.threads.detail(ACCOUNT, t.id);
    expect(detail.messages[0]!.mentions).toEqual([
      { kind: 'skill', ref: 'skill:user:code-review', label: 'code-review' },
    ]);
  });

  it('an unknown skill mention is kept and loads nothing', async () => {
    env = await makeLoopEnv({ skills: fixedSkills([]), noTools: true });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, {
      text: 'hello',
      mentions: [{ kind: 'skill', ref: 'skill:ghost' }],
    });
    await env.chat.idle();
    expect(userText(env.mock.requests[0])).toBe('hello');
    const detail = await env.threads.detail(ACCOUNT, t.id);
    expect(detail.messages[0]!.mentions).toEqual([
      { kind: 'skill', ref: 'skill:ghost', label: 'skill:ghost' },
    ]);
  });

  it('a skill the model loads with skill.load keeps its tools loaded for the next step', async () => {
    const load = mcpTool(
      'skill.load',
      () => Promise.resolve({ ok: true, content: [{ type: 'text', text: review.body }] }),
      {
        source: 'builtin',
        loading: 'always',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
    );
    const skills = fixedSkills([review], null, [load]);
    env = await makeLoopEnv({ skills, sources: [gitTools], budget: tiny });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: '/tool skill.load {"name":"code-review"}' });
    await env.chat.idle();
    expect(offered(0)).toContain('skill.load');
    expect(offered(0)).not.toContain('mcp:git.diff');
    expect(offered(1)).toContain('mcp:git.diff');
    expect(offered(1)).not.toContain('mcp:git.log');
  });
});
