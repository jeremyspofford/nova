// Permissions: the steps that ask first, and whether the person lets Nova take
// each one without asking. The list isn't fixed. Every tool that needs an OK
// declares the permission it falls under (`permission` on the tool), so a tool
// added later, by us, by Nova, or from a plugin or MCP server, shows up in
// Settings on its own; one that declares nothing gets a permission named
// after it. Every permission starts as "ask".
//
// "yes": Nova takes the step without asking, in a conversation or not.
// "ask": in a conversation, Nova shows a card. In a scheduled run or a helper,
// the work waits for the person's answer, and Activity shows it waiting.
//
// Kept in ~/permissions.md, one line per permission, so it can be read and
// changed by hand. Lines for permissions no tool declares are kept as they are.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Not a tool of its own: going online once mail has been read in the conversation.
export const ONLINE = { id: 'online', label: 'Go online after reading your mail', note: 'An email could carry instructions telling Nova to send your mail to a website' };

// The permissions the given tools declare, in the order the tools are listed.
export function permissionList(tools) {
  const out = new Map();
  for (const [name, tool] of Object.entries(tools)) {
    if (tool.online && !out.has(ONLINE.id)) out.set(ONLINE.id, ONLINE);
    if (!tool.needsApproval) continue;
    const p = tool.permission ?? { id: name, label: `Use ${name}` };
    if (!out.has(p.id)) out.set(p.id, p);
  }
  return [...out.values()];
}

// Which permission a step needs, if any.
export function permissionFor(name, tool, { tainted = false } = {}) {
  if (tool?.needsApproval) return tool.permission?.id ?? name;
  if (tool?.online && tainted) return ONLINE.id;
  return null;
}

const LINE = /^-\s*([\w.-]+)\s*:\s*(yes|ask)\b/i;

export class Permissions {
  constructor(home, tools) {
    this.file = join(home, 'permissions.md');
    this.tools = tools;
  }

  // { id: true } for each permission set to "yes", from the file.
  saved() {
    const out = {};
    if (!existsSync(this.file)) return out;
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      const m = line.match(LINE);
      if (m) out[m[1]] = m[2].toLowerCase() === 'yes';
    }
    return out;
  }

  allows(id) { return !!id && this.saved()[id] === true; }

  // Every permission the tools declare now, with how it's set.
  list() {
    const saved = this.saved();
    return permissionList(this.tools()).map((p) => ({ ...p, yes: saved[p.id] === true }));
  }

  set(id, yes) {
    const known = this.list();
    if (!known.some((p) => p.id === id)) throw new Error(`There's no permission called ${id}`);
    const saved = { ...this.saved(), [id]: !!yes };
    writeFileSync(this.file, render(known.map((p) => ({ ...p, yes: saved[p.id] === true })), saved));
    return this.list();
  }
}

// The file: what each line means, then the lines. Permissions that no tool
// declares right now (a plugin was removed, say) keep their line at the end.
export function render(list, saved = {}) {
  const known = new Set(list.map((p) => p.id));
  const extra = Object.entries(saved).filter(([id]) => !known.has(id));
  return `# What Nova may do without asking

Each line is one kind of step that normally asks you first. "yes" means Nova
takes it without asking, whether you're in the conversation or not. "ask"
means Nova asks: a card in the conversation, or, when it's working on its own
(a scheduled run or a helper), it waits for your answer and Activity shows it
waiting. You can change these in Settings, or here.

${[...list.map((p) => `- ${p.id}: ${p.yes ? 'yes' : 'ask'} (${p.label}${p.note ? `. ${p.note}` : ''})`), ...extra.map(([id, yes]) => `- ${id}: ${yes ? 'yes' : 'ask'}`)].join('\n')}
`;
}

// For a scheduled run or a helper: what it may do without asking, and what waits.
export function permissionsSection(list) {
  const own = list.filter((p) => p.yes).map((p) => lower(p.label));
  const ask = list.filter((p) => !p.yes).map((p) => lower(p.label));
  return [
    own.length ? `The person lets you do these without asking: ${own.join('; ')}. Do them when the work calls for it, and say in your report what you did.` : '',
    ask.length ? `These need the person's OK: ${ask.join('; ')}. No one is watching, so asking means the work waits until they answer, which may be hours. Ask only when the work can't be done without it; otherwise finish without it and suggest it in your report.` : '',
  ].filter(Boolean).join('\n\n');
}

const lower = (s) => s.replace(/^\w/, (c) => c.toLowerCase());
