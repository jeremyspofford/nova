// Skills are markdown playbooks: front matter says what the skill is and when
// to use it, the body says how. Nova ships a few in skills/; installing one
// copies its folder into the home's skills/, where the person can read and
// change it. The person can also add their own folder or .zip, in Nova's
// format or Claude's (name + description). Removing one deletes that folder.
// Nothing else refers to it, and skills/ is kept out of the home's history,
// so nothing is left behind.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_FILES = 200;
const MAX_BYTES = 5_000_000;
const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|\.git)(\/|$)/;
export const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
// "pdf-processing" → "Pdf processing"; a written-out name stays as it is.
const displayName = (name, id) => {
  const n = String(name || id);
  return ID.test(n) ? n.charAt(0).toUpperCase() + n.slice(1).replace(/-/g, ' ') : n;
};
const list = (v) => String(v ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);

export function parseFrontMatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const meta = {};
  if (m) {
    // Plain "key: value" lines, quoted values, and the folded (>) or literal
    // (|) blocks Claude's skills often use for a long description. Nested
    // keys are skipped.
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
      if (!kv) continue;
      let value = kv[2].trim();
      if (/^[>|][+-]?$/.test(value)) {
        const block = [];
        while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
        value = value.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ') : block.join('\n');
      } else if (/^(["']).*\1$/.test(value)) {
        value = value.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
      }
      meta[kv[1]] = value.trim();
    }
  }
  return { meta, body: (m ? text.slice(m[0].length) : String(text)).trim() };
}

function readSkill(dir, id) {
  const path = join(dir, id, 'SKILL.md');
  if (!ID.test(id) || !existsSync(path)) return null;
  const { meta, body } = parseFrontMatter(readFileSync(path, 'utf8'));
  const files = Object.keys(filesIn(join(dir, id), { names: true })).filter((f) => f !== 'SKILL.md');
  return {
    id,
    name: displayName(meta.name, id),
    // Claude's format has one description for both.
    about: meta.about || meta.description || '',
    when: meta.when || meta.description || '',
    files,
    try: meta.try || '',
    words: list(meta.words),
    needs: list(meta.needs),
    body,
  };
}

function readAll(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((id) => readSkill(dir, id)).filter(Boolean);
}

// path → text, or { base64 } for a file that isn't UTF-8 text.
function filesIn(dir, { names = false } = {}) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split(sep).join('/')] = names ? true : encodeFile(readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

function encodeFile(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return { base64: buf.toString('base64') }; }
}

const decodeFile = (v) => (typeof v === 'string' ? Buffer.from(v) : typeof v?.base64 === 'string' ? Buffer.from(v.base64, 'base64') : null);

function writeFiles(dir, files) {
  for (const [p, data] of files) {
    const abs = resolve(dir, p);
    if (!abs.startsWith(dir + sep)) throw new SkillError(400, `“${p}” would land outside the skill's folder.`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
  }
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

  restore(id, files) { return this.commit(this.prepareRestore(id, files)); }

  // What restoring would write, checked, without writing it (the ingest gate screens it first).
  prepareRestore(id, files) {
    if (!ID.test(String(id))) throw new SkillError(400, 'Not a skill name.');
    const dir = resolve(this.dir, id);
    if (existsSync(dir)) throw new SkillError(409, 'That skill is already installed.');
    const entries = Object.entries(files ?? {}).map(([p, v]) => [p, decodeFile(v)]);
    if (!entries.some(([p]) => p === 'SKILL.md')) throw new SkillError(400, 'A skill needs its SKILL.md.');
    for (const [p, data] of entries) {
      if (!data || !resolve(dir, p).startsWith(dir + sep)) throw new SkillError(400, 'That skill has a file Nova can\'t put back.');
    }
    return { id: String(id), entries };
  }

  // Whether a prepared skill is exactly one Nova ships (an Undo of a catalog skill): every file as
  // the catalog has it, and nothing else.
  isCatalogCopy({ id, entries }) {
    const dir = join(this.catalogDir, String(id));
    if (!readSkill(this.catalogDir, String(id))) return false;
    const have = filesIn(dir, { names: true });
    if (Object.keys(have).length !== entries.length) return false;
    return entries.every(([p, data]) => {
      const file = resolve(dir, p);
      if (!file.startsWith(dir + sep) || !existsSync(file)) return false;
      return Buffer.compare(readFileSync(file), Buffer.isBuffer(data) ? data : Buffer.from(data)) === 0;
    });
  }

  // Writes a prepared skill into a staging folder (not a skill name, so never listed or used), then
  // moves it into place in one step.
  commit({ id, entries }) {
    const dir = resolve(this.dir, id);
    if (existsSync(dir)) throw new SkillError(409, 'That skill is already installed.');
    mkdirSync(this.dir, { recursive: true });
    const staging = resolve(this.dir, `.staging-${randomBytes(6).toString('hex')}`);
    try {
      writeFiles(staging, entries);
      renameSync(staging, dir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return this.get(id);
  }

  // A skill the person brings: a folder's files or a .zip's, as
  // { path: Buffer | string | { base64 } }. SKILL.md may sit at the top or in
  // one folder; its name (or that folder's) becomes the skill's id.
  add(given) { return this.commit(this.prepare(given)); }

  // What adding would write, checked, without writing anything.
  prepare(given) {
    let entries = Object.entries(given ?? {})
      .map(([p, v]) => [String(p).replace(/\\/g, '/').replace(/^\/+/, ''), Buffer.isBuffer(v) ? v : decodeFile(v)])
      .filter(([p]) => p && !JUNK.test(p));
    if (entries.some(([, d]) => !d)) throw new SkillError(400, "Some of those files couldn't be read.");
    const top = entries.find(([p]) => p === 'SKILL.md') ? '' : entries.map(([p]) => p).find((p) => /^[^/]+\/SKILL\.md$/.test(p))?.split('/')[0];
    if (top === undefined) throw new SkillError(400, 'There\'s no SKILL.md in that. A skill is a folder with a SKILL.md at the top.');
    if (top) entries = entries.filter(([p]) => p.startsWith(`${top}/`)).map(([p, d]) => [p.slice(top.length + 1), d]);
    if (entries.length > MAX_FILES) throw new SkillError(400, `That skill has more than ${MAX_FILES} files.`);
    if (entries.reduce((n, [, d]) => n + d.length, 0) > MAX_BYTES) throw new SkillError(400, `That skill is bigger than ${MAX_BYTES / 1e6} MB.`);
    const text = entries.find(([p]) => p === 'SKILL.md')[1].toString('utf8');
    const { meta, body } = parseFrontMatter(text);
    if (!(meta.description || meta.about || meta.when)) {
      throw new SkillError(400, 'Its SKILL.md needs a description at the top: what the skill does and when to use it.');
    }
    if (!body) throw new SkillError(400, 'Its SKILL.md has no instructions below the description.');
    const id = slug(meta.name) || slug(top);
    if (!ID.test(id)) throw new SkillError(400, 'Its SKILL.md needs a name.');
    if (existsSync(join(this.dir, id))) throw new SkillError(409, `You already have a skill called ${displayName(meta.name, id)}. Remove it first to replace it.`);
    if (existsSync(join(this.catalogDir, id, 'SKILL.md'))) throw new SkillError(409, `Nova comes with a skill called ${id}. Give yours another name.`);
    const dir = resolve(this.dir, id);
    for (const [p] of entries) if (!resolve(dir, p).startsWith(dir + sep)) throw new SkillError(400, `“${p}” would land outside the skill's folder.`);
    return { id, entries };
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
