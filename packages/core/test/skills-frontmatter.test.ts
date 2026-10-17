// SKILL.md and command files (FR-046, docs/08 §3.1, §4): the YAML front-matter subset, validation
// against contracts/schemas/skill-frontmatter.json, the `allowed-tools` alias, name defaults and
// command conversion.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SkillFrontmatterError,
  parseFrontmatterMarkdown,
  readCommandFile,
  readSkillFolder,
} from '../src/index.ts';
import { parseYamlSubset, renderFrontmatter } from '../src/plugins/frontmatter.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-skillfile-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function skill(name: string, text: string): string {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), text);
  return d;
}

describe('front-matter subset', () => {
  it('reads scalars, quoted strings, flow lists and maps, block lists and nested maps', () => {
    const md = parseFrontmatterMarkdown(
      [
        '---',
        'name: code-review',
        'description: Review a diff: correctness, security and style.',
        'when_to_use: "When asked to \\"review\\""',
        "quoted: 'it''s fine'",
        'allowed_tools: [fs.read, "fs.search", exec.run]',
        'model_hint: { reasoning: high, model: x }',
        'count: 3',
        'ratio: 0.5',
        'flag: true',
        'off: false',
        'none: ~',
        '# a comment',
        'list:',
        '  - one',
        '  - two # trailing comment',
        'same-indent:',
        '- a',
        '- b',
        'metadata:',
        '  author: someone',
        '  nested:',
        '    deep: yes-really',
        'items:',
        '  - name: first',
        '    size: 1',
        '  - name: second',
        '---',
        '',
        '## Body',
        'Text.',
      ].join('\n'),
    );
    expect(md.hasFrontmatter).toBe(true);
    expect(md.data).toEqual({
      name: 'code-review',
      description: 'Review a diff: correctness, security and style.',
      when_to_use: 'When asked to "review"',
      quoted: "it's fine",
      allowed_tools: ['fs.read', 'fs.search', 'exec.run'],
      model_hint: { reasoning: 'high', model: 'x' },
      count: 3,
      ratio: 0.5,
      flag: true,
      off: false,
      none: null,
      list: ['one', 'two'],
      'same-indent': ['a', 'b'],
      metadata: { author: 'someone', nested: { deep: 'yes-really' } },
      items: [{ name: 'first', size: 1 }, { name: 'second' }],
    });
    expect(md.body).toBe('## Body\nText.');
  });

  it('reads block scalars, folded and literal, and plain continuations', () => {
    const md = parseFrontmatterMarkdown(
      [
        '---',
        'literal: |',
        '  line one',
        '  line two',
        'folded: >-',
        '  folded one',
        '  folded two',
        '',
        '  new paragraph',
        'plain: starts here',
        '  and continues',
        'flow: [a,',
        '  b]',
        '---',
        'x',
      ].join('\r\n'),
    );
    expect(md.data.literal).toBe('line one\nline two\n');
    expect(md.data.folded).toBe('folded one folded two\nnew paragraph');
    expect(md.data.plain).toBe('starts here and continues');
    expect(md.data.flow).toEqual(['a', 'b']);
  });

  it('treats a file without front-matter as all body, and an empty block as no keys', () => {
    expect(parseFrontmatterMarkdown('# Title\ntext')).toEqual({
      data: {},
      body: '# Title\ntext',
      hasFrontmatter: false,
    });
    expect(parseFrontmatterMarkdown('---\n---\nbody').data).toEqual({});
    expect(parseYamlSubset('')).toBeNull();
  });

  it('refuses what it cannot read', () => {
    const bad = [
      '---\nname: x\n',
      '---\nname: [a, b\n---\n',
      '---\nname: "unclosed\n---\n',
      '---\njust text\n---\n',
      '---\na: 1\na: 2\n---\n',
      '---\n\tname: x\n---\n',
      '---\nname: "x" trailing\n---\n',
      '---\nm: {a 1}\n---\n',
      '---\n- a\n---\n',
      '---\nname: "bad \\q"\n---\n',
    ];
    for (const text of bad)
      expect(() => parseFrontmatterMarkdown(text), text).toThrow(SkillFrontmatterError);
  });

  it('renders generated front-matter as JSON scalars that parse back', () => {
    const text = renderFrontmatter({
      name: 'greet',
      description: 'Say: "hi"',
      tools: ['a', 'b'],
      skip: undefined,
    });
    expect(parseFrontmatterMarkdown(`${text}body`).data).toEqual({
      name: 'greet',
      description: 'Say: "hi"',
      tools: ['a', 'b'],
    });
  });
});

describe('skill folders', () => {
  it('reads a valid skill with defaults and the allowed-tools alias', () => {
    const d = skill(
      'code-review',
      '---\ndescription: Review code for bugs and style, with a fix per finding.\nallowed-tools: fs.read, fs.search exec.run\nmodel_hint: { reasoning: high }\nlicense: MIT\n---\nDo it.\n',
    );
    const r = readSkillFolder(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill).toMatchObject({
      name: 'code-review',
      allowedTools: ['fs.read', 'fs.search', 'exec.run'],
      modelHint: 'reasoning: high',
      whenToUse: null,
      body: 'Do it.\n',
      warnings: [],
    });
    expect(r.skill.frontmatter.license).toBe('MIT');
  });

  it('warns about a short description and keeps a string model hint', () => {
    const r = readSkillFolder(
      skill('short', '---\ndescription: Too short\nmodel_hint: fast\n---\nx'),
    );
    expect(r.ok && r.skill.warnings[0]).toMatch(/short/);
    expect(r.ok && r.skill.modelHint).toBe('fast');
  });

  it('refuses invalid skills with a reason', () => {
    const cases: [string, string, RegExp][] = [
      ['no-desc', '---\nname: no-desc\n---\nx', /description/],
      ['empty', '---\ndescription: ""\n---\nx', /description/],
      ['Bad_Folder', '---\ndescription: A long enough description here.\n---\nx', /name/],
      [
        'both',
        '---\ndescription: A long enough description here.\nallowed_tools: [a]\nallowed-tools: [b]\n---\nx',
        /front-matter|must NOT/,
      ],
      [
        'bad-name',
        '---\nname: Bad Name\ndescription: A long enough description here.\n---\nx',
        /name/,
      ],
      ['none', 'no front-matter', /front-matter/],
      ['broken', '---\nname: [\n---\nx', /unclosed/],
    ];
    for (const [name, text, re] of cases) {
      const r = readSkillFolder(skill(name, text));
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r.error, name).toMatch(re);
    }
    expect(readSkillFolder(join(dir, 'missing')).ok).toBe(false);
  });

  it('refuses a SKILL.md over 1 MB', () => {
    const r = readSkillFolder(
      skill(
        'big',
        `---\ndescription: A long enough description here.\n---\n${'x'.repeat(1024 * 1024)}`,
      ),
    );
    expect(r.ok).toBe(false);
  });
});

describe('command files', () => {
  it('names a command by its heading and describes it by its first paragraph', () => {
    const file = join(dir, 'release.md');
    writeFileSync(
      file,
      '# Cut a release\n\nTag the version, write the changelog and publish.\n\nMore.',
    );
    const r = readCommandFile(file);
    expect(r.ok && r.skill).toMatchObject({
      name: 'cut-a-release',
      description: 'Tag the version, write the changelog and publish.',
    });
  });

  it('prefers the front-matter and falls back to the file name', () => {
    const a = join(dir, 'greet.md');
    writeFileSync(a, '---\ndescription: Greet someone warmly by name.\n---\n# Greet\n\nSay hello.');
    expect(readCommandFile(a)).toMatchObject({
      ok: true,
      skill: { name: 'greet', description: 'Greet someone warmly by name.' },
    });
    const b = join(dir, 'Do Thing.md');
    writeFileSync(b, '```\ncode only\n```');
    const r = readCommandFile(b);
    expect(r.ok && r.skill.name).toBe('do-thing');
    expect(r.ok && r.skill.description).toBe('Run the do-thing command');
    expect(readCommandFile(join(dir, 'missing.md')).ok).toBe(false);
    const c = join(dir, 'broken.md');
    writeFileSync(c, '---\nname: [\n---\n');
    expect(readCommandFile(c).ok).toBe(false);
  });
});
