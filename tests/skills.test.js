import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Skills, parseFrontMatter } from '../src/skills.js';
import { buildSystem, skillsSection } from '../src/context.js';
import { availableTools, parseSearch, parseToolCall, TOOLS } from '../src/tools.js';

const root = new URL('..', import.meta.url).pathname;
const fresh = () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-k-'));
  return { home, skills: new Skills(root, home) };
};

test('front matter: name, about, when, words, needs', () => {
  const { meta, body } = parseFrontMatter('---\nname: Email summary\nwhen: The person asks about mail.\n---\n\n# Body\n');
  assert.equal(meta.name, 'Email summary');
  assert.equal(meta.when, 'The person asks about mail.');
  assert.equal(body, '# Body');
  assert.deepEqual(parseFrontMatter('# No front matter').meta, {});
});

test('the shipped skills are complete; one behind a flag shows only with it on', () => {
  const { skills } = fresh();
  assert.deepEqual(skills.catalog().map((s) => s.id), ['email-summary', 'shopping'], 'interstitial-research ships off');
  const on = new Skills(root, mkdtempSync(join(tmpdir(), 'nova-k-')), { interstitial: true });
  const all = on.catalog();
  assert.deepEqual(all.map((s) => s.id), ['email-summary', 'interstitial-research', 'shopping']);
  for (const s of all) {
    assert.ok(s.name && s.about && s.when && s.words.length && s.body.length > 500, s.id);
  }
  // The always-listed line stays one short line; the description is kept for the standard format.
  const ir = all[1];
  assert.ok(ir.when.length < 200 && !ir.when.includes('\n'), ir.when);
  assert.match(ir.about, /^Nova research mode for the gaps between fields\./);
  assert.equal(skills.catalog().find((s) => s.id === 'email-summary').needs[0], 'gmail');
  assert.deepEqual(all[0].needs, ['gmail']);
  assert.match(skills.connectorDoc('gmail'), /## Capabilities[\s\S]*## Limits[\s\S]*## Auth/);
});

test('install, then remove: nothing left behind; undo puts it back exactly', () => {
  const { home, skills } = fresh();
  assert.deepEqual(skills.available().map((s) => s.id), ['email-summary', 'shopping']);
  skills.install('shopping');
  assert.deepEqual(skills.installed().map((s) => s.id), ['shopping']);
  assert.deepEqual(skills.available().map((s) => s.id), ['email-summary']);
  assert.throws(() => skills.install('shopping'), /already installed/);
  assert.throws(() => skills.install('../etc'), /doesn't have/);

  // The person's own changes to the playbook come back with Undo.
  const path = join(home, 'skills', 'shopping', 'SKILL.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('Nova researches', 'Nova researches carefully'));
  const files = skills.remove('shopping');
  assert.equal(existsSync(join(home, 'skills', 'shopping')), false);
  assert.deepEqual(readdirSync(join(home, 'skills')), []);
  assert.deepEqual(skills.installed(), []);
  assert.equal(skillsSection(skills.installed()), '');

  skills.commit(skills.prepareRestore('shopping', files));
  assert.match(readFileSync(path, 'utf8'), /researches carefully/);
  assert.throws(() => skills.prepareRestore('x', { '../../evil.md': 'x', 'SKILL.md': 'x' }), /can't put back/);
});

test('matching: a skill whose words appear is loaded; others are only listed', () => {
  const { skills } = fresh();
  skills.install('email-summary');
  skills.install('shopping');
  assert.deepEqual(skills.match("What's in my inbox?").map((s) => s.id), ['email-summary']);
  assert.deepEqual(skills.match('Where can I buy good socks?').map((s) => s.id), ['shopping']);
  assert.deepEqual(skills.match('Write me a haiku about autumn'), []);
  assert.deepEqual(skills.match('Anything I need to deal with from overnight?'), []);

  const section = skillsSection(skills.installed(), skills.match('anything new in my email'), (c) => skills.connectorDoc(c));
  assert.match(section, /- email-summary: Email summary\. Use when:/);
  assert.match(section, /- shopping: Shopping research\. Use when:/);
  assert.match(section, /<skill name="email-summary">[\s\S]*<\/skill>\n<connector name="gmail">/);
  assert.doesNotMatch(section, /<skill name="shopping">/);
});

test('interstitial-research: its words and phrases trigger it; the never-trigger cases N1–N5 do not', () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-k-'));
  const skills = new Skills(root, home, { interstitial: true });
  skills.install('interstitial-research');
  const ids = (t) => skills.match(t).map((s) => s.id);
  for (const t of ['Research why our CI pipelines got slower over the last year and what the options are to fix it.',
    'Deep-dive the options for local LLM inference on a 24 GB GPU for a personal agent.',
    'Can you do a deep dive on onboarding?', 'What is everyone missing about home energy storage?', 'Investigate why the build cache misses.']) {
    assert.deepEqual(ids(t), ['interstitial-research'], t);
  }
  for (const t of ['What time does the library open on Saturdays?', 'What did I work on last Tuesday?', 'Turn off the living-room lights.', 'Move my 3pm to 4pm.', 'Summarise this email thread.']) {
    assert.deepEqual(ids(t), [], t);
  }
  // A phrase matches only as those words in a row; single words still match exactly.
  assert.deepEqual(ids('dive deep into the lake'), []);
  assert.deepEqual(ids('researcher'), []);
});

test('flag off: a home with the skill installed builds exactly the context of a home without it', () => {
  const withIt = mkdtempSync(join(tmpdir(), 'nova-k-'));
  const without = mkdtempSync(join(tmpdir(), 'nova-k-'));
  new Skills(root, withIt, { interstitial: true }).install('interstitial-research');
  for (const h of [withIt, without]) new Skills(root, h).install('shopping');
  const context = (home) => {
    const skills = new Skills(root, home, { interstitial: false });
    const q = 'Research the options for quieter bike tyres';
    assert.equal(skills.get('interstitial-research'), null);
    assert.throws(() => skills.install('interstitial-research'), /doesn't have/);
    const tools = availableTools({ skills: skills.installed().length });
    const section = skillsSection(skills.installed(), skills.match(q), (c) => skills.connectorDoc(c));
    return buildSystem({ root, home, timezone: 'UTC' }, new Date('2026-11-06T12:00:00Z'), { tools, skills: section }) + JSON.stringify(skills.available().map((s) => s.id));
  };
  assert.ok(existsSync(join(withIt, 'skills', 'interstitial-research', 'SKILL.md')));
  assert.equal(context(withIt), context(without));
  assert.doesNotMatch(context(withIt), /interstitial/i);
});

test('removing it deletes its workspace data too, and Undo can put that back', () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-k-'));
  const skills = new Skills(root, home, { interstitial: true });
  skills.install('interstitial-research');
  const data = join(home, 'workspace', 'interstitial');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'state.json'), '{"runs":3}');
  writeFileSync(join(data, 'dead-ends.md'), '- ci x astronomy (2026-11-01)\n');
  skills.remove('interstitial-research');
  const kept = skills.removeData('interstitial-research');
  assert.equal(existsSync(data), false);
  assert.deepEqual(Object.keys(kept).sort(), ['dead-ends.md', 'state.json']);
  assert.equal(skills.removeData('shopping'), null, 'a skill with no data keeps none');
  skills.restoreData('interstitial-research', JSON.parse(JSON.stringify(kept)));
  assert.equal(readFileSync(join(data, 'state.json'), 'utf8'), '{"runs":3}');
  assert.throws(() => skills.restoreData('interstitial-research', { '../../USER.md': 'x' }), /outside the skill's folder/);
});

test('tools on offer follow what is installed and connected', () => {
  assert.deepEqual(availableTools(), ['read_file', 'write_file', 'exec', 'web_fetch', 'web_search', 'schedule_set', 'schedule_remove']);
  assert.ok(availableTools({ skills: 1 }).includes('use_skill'));
  assert.ok(availableTools({ gmail: true }).includes('gmail_read'));
  const offered = availableTools();
  assert.match(parseToolCall('<tool_call name="gmail_search">{}</tool_call>', offered).error, /Gmail is not connected/);

  const { home } = fresh();
  const system = buildSystem({ root, home, timezone: 'UTC' }, new Date(), { tools: offered });
  const tools = system.slice(system.indexOf('# Tools'));
  assert.doesNotMatch(tools, /gmail_search|use_skill/);
  assert.match(tools, /web_search/);
  assert.doesNotMatch(system, /# Skills/);
});

test('no tool reads or writes connection secrets', async () => {
  const { home } = fresh();
  await assert.rejects(TOOLS.read_file.run({ path: 'connectors/gmail/token.json' }, { home }), /can't be read/);
  await assert.rejects(TOOLS.write_file.run({ path: '~/connectors/x', content: '' }, { home }), /can't be written/);
});

test('web search results: real links, no ads, no duplicates', () => {
  const html = `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad%3D1&amp;rut=x">Ad</a>
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fshop.example%2Fa%3Fb%3D1&amp;rut=y">A <b>sock</b> &amp; more</a><a class="result__snippet" href="#">Warm, $20.</a>
<a rel="nofollow" class="result__a" href="https://shop.example/a?b=1">Same again</a>
<a class="result__a" href="https://other.example/">Other</a>`;
  assert.deepEqual(parseSearch(html), [
    { title: 'A sock & more', url: 'https://shop.example/a?b=1', snippet: 'Warm, $20.' },
    { title: 'Other', url: 'https://other.example/', snippet: '' },
  ]);
});

test("the model's environment carries none of the host session's memory or identity", async () => {
  const { agentEnv } = await import('../src/agent.js');
  const env = agentEnv({ PATH: '/bin', CLAUDE_CODE_USER_EMAIL: 'someone@example.com', CLAUDE_CODE_MEMORY_DIR: '/m', CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1', HOME: '/h' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});

const CLAUDE_SKILL = `---
name: meeting-notes
description: >
  Turns rough meeting notes into a summary with decisions and action items.
  Use when the person pastes notes from a meeting.
license: MIT
---

# Meeting notes

1. Read the notes.
2. List decisions, then action items with owners. See template.md.
`;

test("Claude's skill format works as-is: description, folded lines, extra files", () => {
  const { home, skills } = fresh();
  const s = skills.commit(skills.prepare({ 'meeting-notes/SKILL.md': CLAUDE_SKILL, 'meeting-notes/template.md': '## Decisions\n', 'meeting-notes/logo.png': { base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]).toString('base64') }, '__MACOSX/meeting-notes/._SKILL.md': 'junk', 'meeting-notes/.DS_Store': 'junk' }));
  assert.equal(s.id, 'meeting-notes');
  assert.equal(s.name, 'Meeting notes');
  assert.equal(s.about, 'Turns rough meeting notes into a summary with decisions and action items. Use when the person pastes notes from a meeting.');
  assert.equal(s.when, s.about);
  assert.deepEqual(s.files, ['logo.png', 'template.md']);
  assert.deepEqual(readdirSync(join(home, 'skills', 'meeting-notes')).sort(), ['SKILL.md', 'logo.png', 'template.md']);
  assert.deepEqual(readFileSync(join(home, 'skills', 'meeting-notes', 'logo.png')), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]));
  assert.equal(skills.installed()[0].own, true);

  // The model is told where the other files are.
  const section = skillsSection(skills.installed(), [s]);
  assert.match(section, /- meeting-notes: Meeting notes\. Use when: Turns rough meeting notes/);
  assert.match(section, /folder is ~\/skills\/meeting-notes\/\. It also has: logo\.png, template\.md\./);

  // Removing and Undo keep binary files exact.
  const files = skills.remove('meeting-notes');
  assert.deepEqual(files['logo.png'], { base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]).toString('base64') });
  skills.commit(skills.prepareRestore('meeting-notes', JSON.parse(JSON.stringify(files))));
  assert.deepEqual(readFileSync(join(home, 'skills', 'meeting-notes', 'logo.png')), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]));
});

test('adding a skill: plain words for everything that can be wrong', () => {
  const { skills } = fresh();
  assert.throws(() => skills.prepare({ 'notes.md': 'x' }), /no SKILL\.md/);
  assert.throws(() => skills.prepare({ 'SKILL.md': '# Steps\nDo it.' }), /needs a description/);
  assert.throws(() => skills.prepare({ 'SKILL.md': '---\ndescription: Does things.\n---\n' }), /no instructions/);
  assert.throws(() => skills.prepare({ 'SKILL.md': '---\ndescription: Does things.\n---\nDo it.' }), /needs a name/);
  assert.throws(() => skills.prepare({ 'SKILL.md': '---\nname: email-summary\ndescription: Mine.\n---\nDo it.' }), /comes with a skill called email-summary/);
  assert.throws(() => skills.prepare({ 'SKILL.md': '---\nname: x\ndescription: d\n---\nDo it.', '../../escape.md': 'x' }), /outside the skill's folder/);
  const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}.md`, 'x']));
  assert.throws(() => skills.prepare({ ...many, 'SKILL.md': '---\nname: x\ndescription: d\n---\nDo it.' }), /more than 200 files/);
  skills.commit(skills.prepare({ 'SKILL.md': '---\nname: Weekly review\ndescription: d\n---\nDo it.' }));
  assert.ok(skills.get('weekly-review'));
  assert.throws(() => skills.prepare({ 'SKILL.md': '---\nname: Weekly Review\ndescription: d\n---\nDo it.' }), /already have a skill called Weekly Review/);
});

test('a .zip of a skill unpacks; a broken or oversized one is refused', async () => {
  const { unzip } = await import('../src/zip.js');
  const { makeZip } = await import('../scripts/make-zip.js');
  const files = unzip(makeZip({ 'meeting-notes/SKILL.md': CLAUDE_SKILL, 'meeting-notes/template.md': 'é'.repeat(5000) }));
  assert.deepEqual(Object.keys(files), ['meeting-notes/SKILL.md', 'meeting-notes/template.md']);
  assert.equal(files['meeting-notes/template.md'].toString(), 'é'.repeat(5000));
  assert.throws(() => unzip(Buffer.from('not a zip at all, no really')), /isn't a \.zip/);
  assert.throws(() => unzip(makeZip({ 'big.txt': 'x'.repeat(2000) }), { maxBytes: 1000 }), /unpacks to more than/);
  const { skills } = fresh();
  assert.equal(skills.commit(skills.prepare(files)).id, 'meeting-notes');
});
