// What Nova may do on its own: the kinds of step that ask first in a
// conversation, and whether a scheduled run or a helper (no one watching)
// takes them without asking. Kept in ~/permissions.md, one line per kind, so
// the person can read and change it by hand. Every kind starts as "yes"
// (full autonomy); one set to "ask" isn't done while no one is watching, and
// is suggested in the report instead.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const KINDS = [
  { id: 'drafts', label: 'Write Gmail drafts', note: 'Nova has no way to send email.', yes: true },
  { id: 'tidy', label: 'Tidy Gmail: archive, mark read or unread, labels', note: 'Nova has no way to delete email.', yes: true },
  { id: 'schedules', label: 'Set up, change and remove schedules', yes: true },
  { id: 'online', label: 'Go online after reading your mail', note: 'An email could tell Nova to send your mail to a website.', yes: true },
  { id: 'commands', label: 'Run commands on this computer', note: 'A command can change anything your account can, this file included.', yes: true },
];

// Which kind a step is. Going online only asks once mail has been read.
export function kindOf(name, { tainted = false } = {}) {
  if (name === 'gmail_draft') return 'drafts';
  if (name === 'gmail_organize') return 'tidy';
  if (name === 'schedule_set' || name === 'schedule_remove') return 'schedules';
  if (name === 'exec') return 'commands';
  if ((name === 'web_fetch' || name === 'web_search') && tainted) return 'online';
  return null;
}

const LINE = /^-\s*([a-z]+)\s*:\s*(yes|ask)\b/i;

export class Permissions {
  constructor(home) { this.file = join(home, 'permissions.md'); }

  // { drafts: true, ... }: true means "on its own", false means "ask".
  read() {
    const out = Object.fromEntries(KINDS.map((k) => [k.id, k.yes]));
    if (!existsSync(this.file)) return out;
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      const m = line.match(LINE);
      if (m && m[1].toLowerCase() in out) out[m[1].toLowerCase()] = m[2].toLowerCase() === 'yes';
    }
    return out;
  }

  allows(kind) { return !!kind && this.read()[kind] === true; }

  set(kind, yes) {
    if (!KINDS.some((k) => k.id === kind)) throw new Error(`There's no permission called ${kind}`);
    const now = { ...this.read(), [kind]: !!yes };
    writeFileSync(this.file, render(now));
    return now;
  }

  list() {
    const now = this.read();
    return KINDS.map(({ id, label, note }) => ({ id, label, ...(note ? { note } : {}), yes: now[id] }));
  }
}

export function render(now) {
  return `# What Nova may do on its own

When no one is watching (a scheduled run, or a helper working in the
background), Nova takes the steps marked "yes" without asking, and Activity
shows each one. A step marked "ask" isn't taken then; Nova suggests it in its
report, and you can say yes there. When you're in the conversation, Nova asks
either way.

${KINDS.map((k) => `- ${k.id}: ${now[k.id] ? 'yes' : 'ask'} (${k.label}${k.note ? `. ${k.note}` : ''})`).join('\n')}
`;
}

// The same rules, told to the model at the start of a run or a helper.
export function permissionsSection(now) {
  const own = KINDS.filter((k) => now[k.id]).map((k) => lower(k.label));
  const ask = KINDS.filter((k) => !now[k.id]).map((k) => lower(k.label));
  return [
    own.length ? `The person has said you may do these on your own, without asking: ${own.join('; ')}. Do them when the work calls for it, and say in your report what you did.` : '',
    ask.length ? `The person wants to be asked before you ${ask.join('; ')}, and no one is here to ask, so those won't happen now. Don't try them; suggest them in your report instead.` : '',
  ].filter(Boolean).join('\n\n');
}

const lower = (s) => s.replace(/^\w/, (c) => c.toLowerCase());
