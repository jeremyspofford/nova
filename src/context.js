// Context assembly, in the order the build prompt sets:
// system prompt → standing files → memory search → the conversation.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStanding } from './home.js';
import { Memory } from './memory.js';
import { availableTools, memoryProtocol, toolProtocol } from './tools.js';

const MAX_TRANSCRIPT = 120_000; // characters; older turns drop off first

export function formatNow(now, timezone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  return `${f.format(now)} (${timezone})`;
}

// Installed skills are listed every time; the ones this reply follows are
// read in full, with the docs of the connectors they need.
export function skillsSection(installed = [], active = [], connectorDoc = () => '') {
  if (!installed.length) return '';
  const list = installed.map((s) => `- ${s.id}: ${s.name}. Use when: ${s.when || s.about}`).join('\n');
  const loaded = active.map((s) => {
    const docs = s.needs.map((c) => connectorDoc(c)).filter(Boolean).map((d, i) => `<connector name="${s.needs[i]}">\n${d}\n</connector>`);
    const files = s.files?.length ? `\n\nThis skill's folder is ~/skills/${s.id}/. It also has: ${s.files.join(', ')}. Read them with read_file when the playbook points to them.` : '';
    return `<skill name="${s.id}">\n${s.body}${files}\n</skill>${docs.length ? `\n${docs.join('\n')}` : ''}`;
  });
  return `# Skills

Skills are playbooks for particular kinds of work, kept in ~/skills/. When a message calls for one that isn't loaded below, load it with use_skill before you start, then follow it.

${list}${loaded.length ? `\n\nLoaded for this message. Follow ${loaded.length > 1 ? 'these' : 'this'} closely:\n\n${loaded.join('\n\n')}` : ''}`;
}

export function buildSystem({ root, home, timezone }, now = new Date(), { tools = availableTools(), skills = '' } = {}) {
  const base = readFileSync(join(root, 'system', 'system_prompt.md'), 'utf8').trim();
  const memory = new Memory(home, timezone);
  const standing = readStanding(home)
    .map(({ name, text }) => `<file path="~/${name}">\n${(name === 'MEMORY.md' ? memory.forContext(text) : text) || '(empty)'}\n</file>`)
    .join('\n\n');
  // Today's and yesterday's notes, so a day carries across conversations.
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const days = [memory.today(yesterday), memory.today(now)]
    .map((d) => [d, join(home, 'memory', `${d}.md`)])
    .filter(([, p]) => existsSync(p))
    .map(([d, p]) => `<file path="~/memory/${d}.md">\n${memory.forContext(readFileSync(p, 'utf8').trim()).slice(-8000)}\n</file>`);
  return [
    base,
    `# Standing files\n\nThese are your home's standing files, read fresh for this message.\n\n${standing}`,
    days.length ? `# Recent notes\n\n${days.join('\n\n')}` : '',
    skills,
    toolProtocol(tools),
    memoryProtocol(),
    `# Now\n\nIt is ${formatNow(now, timezone)}.`,
  ].filter(Boolean).join('\n\n');
}

const esc = (s) => String(s).replace(/<\/(tool_result|user|nova|note|remember|forget|skill|connector)>/g, '<\\/$1>');

function renderTurn(t, timezone) {
  const when = t.ts ? ` time="${formatNow(new Date(t.ts), timezone)}"` : '';
  const parts = [`<user${when}>\n${esc(t.text)}\n</user>`];
  for (const it of t.items) {
    if (it.kind === 'text') parts.push(`<nova>\n${esc(it.text)}\n</nova>`);
    if (it.kind === 'tool') {
      parts.push(`<tool_call name="${it.name}">${JSON.stringify(it.args)}</tool_call>`);
      if (it.approval?.decision === 'deny') parts.push(`<tool_result name="${it.name}" ok="false">The user declined this.</tool_result>`);
      else if (it.result) parts.push(`<tool_result name="${it.name}" ok="${it.result.ok}">\n${esc(it.result.output)}\n</tool_result>`);
    }
  }
  if (t.state === 'stopped') parts.push('<note>The user stopped this reply here.</note>');
  return parts.join('\n');
}

// session: the reduced view, whose last turn is the one being answered.
export function buildPrompt(session, recall, { timezone }) {
  const turns = session.turns.map((t) => renderTurn(t, timezone));
  let kept = [];
  let size = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    size += turns[i].length;
    if (size > MAX_TRANSCRIPT && kept.length) break;
    kept.unshift(turns[i]);
  }
  const omitted = turns.length - kept.length;
  const memory = recall.length
    ? `<memory_search>\n${recall.map((n) => `<note source="~/${n.source}" id="${n.id ?? ''}">${esc(n.text)}</note>`).join('\n')}\n</memory_search>\n\n`
    : '';
  return `${memory}<conversation>\n${omitted ? `<note>${omitted} earlier exchanges omitted for length.</note>\n` : ''}${kept.join('\n\n')}\n</conversation>\n\n` +
    "Continue as Nova: reply to the user's latest message. Write only your reply.";
}
