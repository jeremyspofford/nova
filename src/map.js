// The Stellar Map's data: a view over the files, never a store of its own.
// Everything here is rebuilt from the home folder on every request, so
// deleting a file removes its body and editing a file changes it.
//
//   the Nova (core)  Nova itself; its standing files IDENTITY.md, SOUL.md and
//                    AGENTS.md are its innermost moons
//   planet           a person (USER.md is the owner; memory/people/*.md) or an
//                    enduring topic (memory/topics/*.md)
//   star             a goal (workspace/goals/<slug>/GOAL.md)
//   constellation    a group (memory/groups/*.md); its members are the people
//                    and topics its file names
//   moon             a memory entry, attached to the first planet, star or
//                    topic it names. MEMORY.md entries that name no one are
//                    about the owner, so they orbit the owner's planet.
//   comet            a day of notes from the last 30 days (memory/YYYY-MM-DD.md)
//   asteroid         an older day note that names no one: unconnected
//
// A name counts when it appears as a whole word with its capital letters, or
// as a [[slug]] / link to the file. Every body carries the reason it is where
// it is, so the inspector can say why.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Memory } from './memory.js';

const COMET_DAYS = 30;
const MAX_VISIBLE = 300;     // past this, moons and asteroids aggregate
const MAX_MOONS = 12;        // per body, once aggregating
const MAX_ASTEROIDS = 60;
const DAY_MS = 86_400_000;

const seedOf = (id) => createHash('sha1').update(id).digest().readUInt32BE(0);
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const mtime = (p) => { try { return statSync(p).mtime.toISOString(); } catch { return null; } };
const titleCase = (slug) => slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const excerpt = (text, n = 280) => {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^#{1,6}\s.*$/gm, '')
    .replace(/^_.*_$/gm, '').replace(/\*\*|__|`/g, '').replace(/^\s*[-*]\s+/gm, '').replace(/^[^:\n]+:\s*$/gm, '').replace(/\n{2,}/g, '\n').trim();
  return body.length > n ? `${body.slice(0, n).trimEnd()}…` : body;
};

// A small front matter (key: value lines between --- fences), the first
// heading, and an "Also called:" line. That's all a body file needs.
export function readEntityFile(text, slug) {
  const front = {};
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) for (const line of fm[1].split('\n')) { const m = line.match(/^(\w[\w-]*):\s*(.*)$/); if (m) front[m[1].toLowerCase()] = m[2].trim(); }
  const name = (front.name || text.match(/^#\s+(.+?)\s*$/m)?.[1] || titleCase(slug)).trim();
  const aka = [front.aka, front['also-called'], text.match(/(?:^|[.;]\s+)\**(?:also called|aka|nicknames?)\**:\**[ \t]*([^\n]+)$/im)?.[1]]
    .filter(Boolean).flatMap((s) => s.split(/[,;]/)).map((s) => s.replace(/[*_]|\.$/g, '').trim()).filter((s) => s.length >= 2);
  return { name, aka: [...new Set(aka)], pinned: /^(true|yes)$/i.test(front.pinned ?? ''), front };
}

function listEntities(dir, kind) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md') && !/^(INDEX|README)\.md$/i.test(f)).sort().map((f) => {
    const slug = f.slice(0, -3);
    const path = join(dir, f);
    const text = read(path);
    return { slug, kind, text, ...readEntityFile(text, slug), file: path, touched: mtime(path) };
  });
}

function listGoals(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().filter((d) => existsSync(join(dir, d, 'GOAL.md'))).map((slug) => {
    const path = join(dir, slug, 'GOAL.md');
    const text = read(path);
    const files = existsSync(join(dir, slug, 'files')) ? readdirSync(join(dir, slug, 'files')).length : 0;
    return { slug, kind: 'goal', text, files, ...readEntityFile(text, slug), file: path, touched: mtime(path) };
  });
}

// The owner, from USER.md: "**Name:** Sam Rivera", "**What to call them:** Sam".
function readOwner(home) {
  const text = read(join(home, 'USER.md'));
  const field = (label) => text.match(new RegExp(`^[-*]?\\s*\\*\\*${label}:?\\*\\*:?[ \\t]*(.*)$`, 'im'))?.[1]?.trim() ?? '';
  const name = field('Name');
  const call = field('What to call them');
  return { name: name || call || 'You', aka: [call].filter((s) => s && s !== name), text, touched: mtime(join(home, 'USER.md')) };
}

export function buildMap(home, { now = new Date(), timezone = 'UTC' } = {}) {
  const memory = new Memory(home, timezone);
  const rel = (p) => p.slice(home.length + 1);
  const nodes = [];
  const byId = new Map();
  const add = (n) => { const node = { seed: seedOf(n.id), mentions: 0, ...n }; nodes.push(node); byId.set(node.id, node); return node; };

  // ---- the Nova and its own files ------------------------------------------
  add({ id: 'core', type: 'core', kind: 'agent', name: 'Nova', sub: 'The agent · home', source: 'IDENTITY.md',
    text: excerpt(read(join(home, 'IDENTITY.md'))), reason: 'Nova itself, at the centre of the system it tends.' });
  for (const f of ['IDENTITY.md', 'SOUL.md', 'AGENTS.md']) {
    if (!existsSync(join(home, f))) continue;
    add({ id: `file:${f}`, type: 'moon', kind: 'file', parent: 'core', name: f.replace('.md', '').replace(/^\w+/, (w) => w[0] + w.slice(1).toLowerCase()),
      sub: 'Moon · Nova’s own file', source: f, text: excerpt(read(join(home, f))), touched: mtime(join(home, f)),
      reason: 'One of Nova’s standing files, read before every reply.' });
  }

  // ---- bodies with files of their own ----------------------------------------
  const owner = readOwner(home);
  const people = listEntities(join(home, 'memory', 'people'), 'person');
  const topics = listEntities(join(home, 'memory', 'topics'), 'topic');
  const goals = listGoals(join(home, 'workspace', 'goals'));
  const groups = listEntities(join(home, 'memory', 'groups'), 'group');

  const ownerFile = people.find((p) => p.name === owner.name || p.aka.includes(owner.name));
  const you = add({ id: 'you', type: 'planet', kind: 'person', owner: true, pinned: true, name: owner.name,
    sub: 'Planet · Person — you', source: ownerFile ? rel(ownerFile.file) : 'USER.md', text: excerpt(ownerFile?.text || owner.text),
    touched: ownerFile?.touched ?? owner.touched, names: [owner.name, ...owner.aka, ...(ownerFile?.aka ?? [])], slug: ownerFile?.slug,
    reason: 'You, from USER.md. Pinned, so it carries a ring.' });
  const entities = [you];
  for (const p of people) {
    if (p === ownerFile) continue;
    entities.push(add({ id: `person:${p.slug}`, type: 'planet', kind: 'person', pinned: p.pinned, name: p.name, sub: 'Planet · Person',
      source: rel(p.file), text: excerpt(p.text), touched: p.touched, names: [p.name, ...p.aka], slug: p.slug }));
  }
  for (const t of topics) {
    entities.push(add({ id: `topic:${t.slug}`, type: 'planet', kind: 'topic', pinned: t.pinned, name: t.name, sub: 'Gas giant · Topic',
      source: rel(t.file), text: excerpt(t.text), touched: t.touched, names: [t.name, ...t.aka], slug: t.slug }));
  }
  for (const g of goals) {
    entities.push(add({ id: `goal:${g.slug}`, type: 'star', kind: 'goal', name: g.name, sub: 'Star · Goal', source: rel(g.file),
      text: excerpt(g.text), touched: g.touched, names: [g.name, ...g.aka], slug: g.slug, files: g.files }));
  }

  // First names stand for a person only when no other body shares them.
  const firsts = new Map();
  for (const e of entities) if (e.kind === 'person') { const f = e.name.split(/\s+/)[0]; firsts.set(f, (firsts.get(f) ?? 0) + 1); }
  for (const e of entities) {
    const f = e.name.split(/\s+/)[0];
    if (e.kind === 'person' && f !== e.name && f.length >= 3 && firsts.get(f) === 1) e.names.push(f);
    const words = [...new Set(e.names)].filter((n) => n && n !== 'You').sort((a, b) => b.length - a.length).map(escapeRe);
    const refs = e.slug ? [`\\[\\[${escapeRe(e.slug)}\\]\\]`, `\\(\\.{0,2}/?(?:[\\w./-]*/)?${escapeRe(e.slug)}(?:/GOAL)?\\.md\\)`] : [];
    e.match = words.length || refs.length ? new RegExp([...(words.length ? [`(?<![\\w-])(?:${words.join('|')})(?![\\w-])`] : []), ...refs].join('|'), 'g') : null;
  }
  // Where in a text each body is named, in order of first appearance.
  const named = (text, except) => entities
    .filter((e) => e.id !== except && e.match)
    .map((e) => { e.match.lastIndex = 0; const m = e.match.exec(text); return m ? { e, at: m.index } : null; })
    .filter(Boolean).sort((a, b) => a.at - b.at).map((x) => x.e);

  // ---- links: a body's file naming another body ------------------------------
  const links = new Map();
  const link = (a, b, kind, why) => {
    if (a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const l = links.get(key) ?? { a: a < b ? a : b, b: a < b ? b : a, stated: 0, together: 0, why: [] };
    l[kind]++;
    if (why && l.why.length < 3 && !l.why.includes(why)) l.why.push(why);
    links.set(key, l);
  };
  const files = new Map([[you.id, ownerFile?.text ?? ''], ...people.filter((p) => p !== ownerFile).map((p) => [`person:${p.slug}`, p.text]),
    ...topics.map((t) => [`topic:${t.slug}`, t.text]), ...goals.map((g) => [`goal:${g.slug}`, g.text])]);
  for (const [id, text] of files) for (const other of named(text, id)) link(id, other.id, 'stated', byId.get(id).source);

  // ---- constellations ----------------------------------------------------------
  const clusters = [];
  for (const g of groups) {
    const members = named(g.text).map((e) => e.id);
    if (!members.length) continue;
    clusters.push({ id: `group:${g.slug}`, name: g.name, source: rel(g.file), members, seed: seedOf(`group:${g.slug}`) });
  }
  // A body sits in the first constellation that names it.
  for (const c of clusters) for (const id of c.members) { const n = byId.get(id); n.cluster ??= c.id; (n.groups ??= []).push(c.name); }

  // ---- memories: moons, comets, asteroids ---------------------------------------
  const today = new Date(`${memory.today(now)}T00:00:00Z`).getTime();
  const entryNode = (e, file, extra) => ({ id: `m:${e.id}`, entryId: e.id, type: 'moon', kind: 'memory', name: shortName(e.text),
    text: e.text, source: file, at: e.meta.at ?? null, touched: e.meta.updated ?? e.meta.at ?? null, section: e.section ?? null,
    time: e.time ?? null, by: e.meta.by ?? (e.meta.id ? 'nova' : 'hand'), ...extra });
  const mention = (list, at) => { for (const e of list) { e.mentions++; if (at && (!e.lastMention || at > e.lastMention)) e.lastMention = at; } };

  for (const e of memory.load(memory.file).entries) {
    const who = named(e.text);
    const parent = who[0] ?? you;
    mention(who.length ? who : [you], e.meta.updated ?? e.meta.at);
    for (const other of who.slice(1)) link(parent.id, other.id, 'together', 'MEMORY.md');
    add(entryNode(e, 'MEMORY.md', { parent: parent.id, sub: `Moon · ${(e.section ?? 'memory').replace(/s$/, '').toLowerCase()} — ${possessive(parent)}`,
      reason: who.length ? `Names ${parent.name}.` : 'In MEMORY.md and names no one else, so it’s about you.' }));
  }
  for (const f of memory.dayFiles()) {
    const day = f.slice(0, 10);
    const age = Math.round((today - new Date(`${day}T00:00:00Z`).getTime()) / DAY_MS);
    const entries = memory.load(join(memory.dir, f)).entries;
    if (!entries.length) continue;
    const at = `${day}T12:00:00Z`;
    if (age < COMET_DAYS) {
      const who = [...new Set(entries.flatMap((e) => named(e.text)))];
      mention(who, at);
      for (const e of entries) { const w = named(e.text); for (let i = 1; i < w.length; i++) link(w[0].id, w[i].id, 'together', `memory/${f}`); }
      add({ id: `day:${day}`, type: 'comet', kind: 'event', day, age, name: longDay(day), sub: 'Comet · Recent day',
        source: `memory/${f}`, text: entries.map((e) => e.text).join(' '), touched: entries.map((e) => e.meta.at).filter(Boolean).sort().at(-1) ?? at,
        entries: entries.map((e) => ({ id: e.id, text: e.text, time: e.time ?? null })), near: who.map((w) => w.id),
        reason: `A day from the last ${COMET_DAYS} days. Its tail fades as it ages; after that its notes settle as moons.` });
      continue;
    }
    for (const e of entries) {
      const who = named(e.text);
      if (who.length) {
        mention(who, e.meta.at ?? at);
        for (const other of who.slice(1)) link(who[0].id, other.id, 'together', `memory/${f}`);
        add(entryNode(e, `memory/${f}`, { parent: who[0].id, day, sub: `Moon · note — ${possessive(who[0])}`, reason: `A day note that names ${who[0].name}.` }));
      } else {
        add(entryNode(e, `memory/${f}`, { type: 'asteroid', kind: 'orphan', day, sub: 'Asteroid · Unconnected note',
          reason: 'A day note that names no one, so it drifts in the belt at the edge.' }));
      }
    }
  }

  // ---- salience: mentions + links + recency, the same signals search uses ---------
  const linkCount = new Map();
  for (const l of links.values()) for (const id of [l.a, l.b]) linkCount.set(id, (linkCount.get(id) ?? 0) + l.stated + l.together);
  const weights = new Map(entities.map((e) => [e.id, e.mentions + 2 * (linkCount.get(e.id) ?? 0) + nodes.filter((n) => n.parent === e.id).length + (e.files ?? 0)]));
  const most = Math.max(1, ...weights.values());
  for (const e of entities) {
    const moons = nodes.filter((n) => n.parent === e.id).length;
    const last = [e.lastMention, e.touched].filter(Boolean).sort().at(-1);
    const days = last ? Math.max(0, (now - new Date(last)) / DAY_MS) : 365;
    const recency = Math.exp(-days / 30);
    // Relative to the busiest body, so sizes spread across the sky.
    e.salience = round(Math.min(1, 0.75 * Math.log1p(weights.get(e.id)) / Math.log1p(most) + 0.25 * recency));
    e.recency = round(recency);
    e.why = { mentions: e.mentions, links: linkCount.get(e.id) ?? 0, moons, lastTouched: last ?? null };
    delete e.match; delete e.names; delete e.lastMention;
  }

  // ---- density: past ~300 bodies, moons and asteroids gather into stacks ------------
  if (nodes.length > MAX_VISIBLE) {
    const byParent = new Map();
    for (const n of nodes) if (n.type === 'moon' && n.kind === 'memory') { if (!byParent.has(n.parent)) byParent.set(n.parent, []); byParent.get(n.parent).push(n); }
    for (const [parent, moons] of byParent) if (moons.length > MAX_MOONS) stack(nodes, byId, moons.slice(MAX_MOONS - 1), { parent, type: 'moon', name: `${moons.length - MAX_MOONS + 1} notes` });
    const rocks = nodes.filter((n) => n.type === 'asteroid');
    if (rocks.length > MAX_ASTEROIDS) stack(nodes, byId, rocks.slice(MAX_ASTEROIDS - 1), { type: 'asteroid', name: `${rocks.length - MAX_ASTEROIDS + 1} unconnected notes` });
  }

  const threads = [...links.values()].map((l) => ({ a: l.a, b: l.b, stated: l.stated, together: l.together, strength: round(1 - Math.exp(-(2 * l.stated + l.together) / 4)), why: l.why }));
  return { nodes, links: threads, clusters, owner: you.id, generated: now.toISOString() };
}

function stack(nodes, byId, members, { parent, type, name }) {
  const keep = new Set(members.map((m) => m.id));
  for (let i = nodes.length - 1; i >= 0; i--) if (keep.has(nodes[i].id)) { byId.delete(nodes[i].id); nodes.splice(i, 1); }
  const id = `stack:${parent ?? 'belt'}`;
  const node = { id, seed: seedOf(id), type, kind: 'stack', parent, name, sub: type === 'moon' ? 'Moons · gathered' : 'Asteroids · gathered',
    count: members.length, entries: members.map((m) => ({ id: m.entryId, text: m.text, source: m.source })), mentions: 0,
    reason: 'Gathered so the map stays readable. Every note is still in its file and in the list.' };
  nodes.push(node);
  byId.set(id, node);
}

const round = (x) => Math.round(x * 1000) / 1000;
const possessive = (e) => (e.owner ? 'yours' : `${e.name.split(/\s+/)[0]}’s`);
function shortName(text) {
  const words = String(text).replace(/[.!?].*$/, '').split(/\s+/);
  return words.length > 5 ? `${words.slice(0, 5).join(' ')}…` : words.join(' ');
}
function longDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}
