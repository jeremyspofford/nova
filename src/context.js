// Context assembly, in the order the build prompt sets:
// system prompt → standing files → memory search → the conversation.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStanding } from './home.js';
import { toolProtocol } from './tools.js';

const MAX_TRANSCRIPT = 120_000; // characters; older turns drop off first

export function formatNow(now, timezone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  return `${f.format(now)} (${timezone})`;
}

export function buildSystem({ root, home, timezone }, now = new Date()) {
  const base = readFileSync(join(root, 'system', 'system_prompt.md'), 'utf8').trim();
  const standing = readStanding(home)
    .map(({ name, text }) => `<file path="~/${name}">\n${text || '(empty)'}\n</file>`)
    .join('\n\n');
  return [
    base,
    `# Standing files\n\nThese are your home's standing files, read fresh for this message.\n\n${standing}`,
    toolProtocol(),
    `# Now\n\nIt is ${formatNow(now, timezone)}.`,
  ].join('\n\n');
}

const esc = (s) => String(s).replace(/<\/(tool_result|user|nova|note)>/g, '<\\/$1>');

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
    ? `<memory_search>\n${recall.map((n) => `<note source="~/${n.source}">${esc(n.text)}</note>`).join('\n')}\n</memory_search>\n\n`
    : '';
  return `${memory}<conversation>\n${omitted ? `<note>${omitted} earlier exchanges omitted for length.</note>\n` : ''}${kept.join('\n\n')}\n</conversation>\n\n` +
    "Continue as Nova: reply to the user's latest message. Write only your reply.";
}
