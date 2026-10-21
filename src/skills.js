// Skills are markdown playbooks: front matter says what the skill is and when
// to use it, the body says how. Nova ships a few in skills/; installing one
// copies its folder into the home's skills/, where the person can read and
// change it. Removing one deletes that folder. Nothing else refers to it, and
// skills/ is kept out of the home's history, so nothing is left behind.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const list = (v) => String(v ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);

export function parseFrontMatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([\w-]+):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
  }
  return { meta, body: (m ? text.slice(m[0].length) : String(text)).trim() };
}

function readSkill(dir, id) {
  const path = join(dir, id, 'SKILL.md');
  if (!ID.test(id) || !existsSync(path)) return null;
  const { meta, body } = parseFrontMatter(readFileSync(path, 'utf8'));
  return {
    id,
    name: meta.name || id,
    about: meta.about || '',
    when: meta.when || '',
    words: list(meta.words),
    needs: list(meta.needs),
    body,
  };
}

function readAll(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((id) => readSkill(dir, id)).filter(Boolean);
}

function filesIn(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

export class Skills {
  constructor(root, home) {
    this.catalogDir = join(root, 'skills');
    this.connectorsDir = join(root, 'connectors');
    this.dir = join(home, 'skills');
  }

  installed() { return readAll(this.dir).map((s) => ({ ...s, own: !existsSync(join(this.catalogDir, s.id, 'SKILL.md')) })); }
  catalog() { return readAll(this.catalogDir); }
  get(id) { return readSkill(this.dir, String(id)); }

  available() {
    const have = new Set(existsSync(this.dir) ? readdirSync(this.dir) : []);
    return this.catalog().filter((s) => !have.has(s.id));
  }

  install(id) {
    const from = join(this.catalogDir, String(id));
    if (!readSkill(this.catalogDir, String(id))) throw new SkillError(404, "Nova doesn't have a skill by that name.");
    const to = join(this.dir, id);
    if (existsSync(to)) throw new SkillError(409, 'That skill is already installed.');
    mkdirSync(this.dir, { recursive: true });
    cpSync(from, to, { recursive: true });
    return this.get(id);
  }

  // Deletes the skill's folder and hands back what was in it, for Undo.
  remove(id) {
    const dir = join(this.dir, String(id));
    if (!ID.test(String(id)) || !existsSync(dir)) throw new SkillError(404, 'That skill is already gone.');
    const files = filesIn(dir);
    rmSync(dir, { recursive: true, force: true });
    return files;
  }

  restore(id, files) {
    if (!ID.test(String(id))) throw new SkillError(400, 'Not a skill name.');
    const dir = resolve(this.dir, id);
    if (existsSync(dir)) throw new SkillError(409, 'That skill is already installed.');
    const entries = Object.entries(files ?? {});
    if (!entries.some(([p]) => p === 'SKILL.md')) throw new SkillError(400, 'A skill needs its SKILL.md.');
    for (const [p, text] of entries) {
      const abs = resolve(dir, p);
      if (!abs.startsWith(dir + sep) || typeof text !== 'string') throw new SkillError(400, 'That skill has a file Nova can\'t put back.');
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
    return this.get(id);
  }

  // Skills whose words appear in the message. The rest are listed for the
  // model, which can load one with use_skill.
  match(text) {
    const said = new Set(String(text).toLowerCase().match(/[a-z]+/g) ?? []);
    return this.installed().filter((s) => s.words.some((w) => said.has(w)));
  }

  connectorDoc(name) {
    const path = join(this.connectorsDir, String(name), 'CONNECTOR.md');
    return existsSync(path) ? parseFrontMatter(readFileSync(path, 'utf8')).body : '';
  }
}

export class SkillError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
