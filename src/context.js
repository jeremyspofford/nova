// Context assembly, in the order the build prompt sets:
// system prompt → standing files → memory search → the conversation.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStanding } from './home.js';
import { Memory } from './memory.js';
import { formatWhen } from './schedules.js';
import { availableTools, memoryProtocol, toolProtocol } from './tools.js';
import { escapeProtocol, renderIdentity } from './core/index.ts';

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
    return `<skill name="${s.id}">\n${fenceIn(s.body, ['skill', 'connector'])}${files}\n</skill>${docs.length ? `\n${docs.join('\n')}` : ''}`;
  });
  return `# Skills

Skills are playbooks for particular kinds of work, kept in ~/skills/. When a message calls for one that isn't loaded below, load it with use_skill before you start, then follow it.

${list}${loaded.length ? `\n\nLoaded for this message. Follow ${loaded.length > 1 ? 'these' : 'this'} closely:\n\n${loaded.join('\n\n')}` : ''}`;
}

// The schedules that are set, so Nova changes one rather than adding a twin.
export function schedulesSection(list = [], timezone = 'UTC') {
  const where = (s) => (s.deliver === 'main' ? 'the main conversation' : `conversation ${s.deliver}`);
  const lines = list.map((s) => `- ${s.id}: ${s.name}. ${s.error ? s.error : `${s.when}${s.paused ? ' (paused)' : ''}`}; reports go to ${where(s)}.`);
  return `# Schedules

Schedules are work you do on your own at set times, kept in ~/schedules/ as files. Each run happens unattended, and its final message arrives as a <handoff> report in the main conversation, or in the conversation where the schedule was asked for. Set one up or change it with schedule_set, and remove one with schedule_remove; the person approves both. Before setting one up, check this list: change an existing schedule instead of adding a second that does the same thing. A one-time reminder is a schedule with "once": true. Times are in ${timezone}.

${lines.length ? lines.join('\n') : 'None are set yet.'}`;
}

// For a scheduled run: who asked, and that no one is watching.
export function runSection({ id, name, due, late }, timezone = 'UTC', allowed = '') {
  return `# This is a scheduled run

This turn runs on its own: the schedule “${name}” (${id}), which the person set up. Its instructions are the message below; treat them as the person's own request. No one is watching. Your final message is handed to the person as a report, so write it for them: finished, self-contained, and leading with what matters. Don't narrate your steps or mention that this is a scheduled run.

${allowed}${late ? `\n\nThis run was due at ${formatWhen(due, timezone)}, and is running late because Nova wasn't running then. Keep that in mind for anything time-sensitive.` : ''}`;
}

// For a helper: its scoped context. It knows who the person is, and gets the
// files Nova passed along; the conversation and memory stay behind.
export function helperSection({ title, files = [] }, allowed = '') {
  // The runner has escaped or screened each file's text (runner.screenFiles).
  const passed = files.map((f) => `<file path="~/${f.path}">\n${f.text || '(empty)'}\n</file>`).join('\n\n');
  return `# You are a helper

Nova handed you one piece of work, “${title}”: the message below is your brief, and it's all you know of the conversation it came from. You don't see that conversation or the person's memory; only who they are (above)${files.length ? ' and the files Nova passed along (below)' : ''}. No one is watching. Your final message goes back to that conversation as a report, so write it for the person: finished, self-contained, and leading with what matters. Don't narrate your steps or mention that you're a helper.

${allowed}${passed ? `\n\n${passed}` : ''}`;
}

// helper: a helper's section; its context is scoped, so it gets no memory,
// no recent notes and no schedules, and keeps no memory.
// identity: "who you are", from the core's identity layer (charter + profile); the default
// identity when there is no core, as in some tests.
export function buildSystem({ root, home, timezone }, now = new Date(), { tools = availableTools(), skills = '', schedules = '', scheduled = '', helper = '', identity = renderIdentity() } = {}) {
  const base = readFileSync(join(root, 'system', 'system_prompt.md'), 'utf8').trim();
  const memory = new Memory(home, timezone);
  const standing = readStanding(home)
    .filter(({ name }) => !(helper && name === 'MEMORY.md'))
    .map(({ name, text }) => `<file path="~/${name}">\n${(name === 'MEMORY.md' ? memory.forContext(text) : text) || '(empty)'}\n</file>`)
    .join('\n\n');
  // Today's and yesterday's notes, so a day carries across conversations.
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const days = helper ? [] : [memory.today(yesterday), memory.today(now)]
    .map((d) => [d, join(home, 'memory', `${d}.md`)])
    .filter(([, p]) => existsSync(p))
    .map(([d, p]) => `<file path="~/memory/${d}.md">\n${memory.forContext(readFileSync(p, 'utf8').trim()).slice(-8000)}\n</file>`);
  return [
    identity,
    base,
    `# Standing files\n\nThese are your home's standing files, read fresh for this message.\n\n${standing}`,
    days.length ? `# Recent notes\n\n${days.join('\n\n')}` : '',
    skills,
    schedules,
    scheduled,
    helper,
    toolProtocol(tools),
    helper ? '' : memoryProtocol(),
    `# Now\n\nIt is ${formatNow(now, timezone)}.`,
  ].filter(Boolean).join('\n\n');
}

// Text inside the transcript: every one of Nova's protocol tags escaped, opening and closing, so
// nothing written there can open or close a block (the ingest gate, plan §4).
const esc = (s) => escapeProtocol(String(s));
// A playbook keeps its own markup; only the tags that would close its block are escaped.
const fenceIn = (s, tags) => String(s).replace(new RegExp(`<(\\s*\\/\\s*(?:${tags.join('|')})\\b)`, 'gi'), '&lt;$1');

function renderTurn(t, timezone) {
  const when = t.ts ? ` time="${formatNow(new Date(t.ts), timezone)}"` : '';
  // A report from a run that read outside content arrives screened.
  if (t.kind === 'handoff') return `<handoff from="${esc(t.name).replace(/"/g, "'")}" ${t.helper ? `helper="${t.helper}"` : `schedule="${t.schedule}"`}${when}>\n${t.screened ?? esc(t.text)}\n</handoff>`;
  const parts = [t.followup
    ? `<followup${when}>The helper's report above just arrived. Say what it means for the person, briefly: your take, and what you'd do next or what they need to decide. Don't repeat the report.</followup>`
    : `<user${when}>\n${esc(t.text)}\n</user>`];
  for (const it of t.items) {
    if (it.kind === 'text') parts.push(`<nova>\n${esc(it.text)}\n</nova>`);
    if (it.kind === 'tool') {
      parts.push(`<tool_call name="${it.name}">${esc(JSON.stringify(it.args))}</tool_call>`);
      if (it.approval?.auto && it.approval.decision === 'deny') parts.push(`<tool_result name="${it.name}" ok="false">Not done: this runs on its own, and no one was there to approve it. Suggest it in your report instead.</tool_result>`);
      else if (it.approval?.decision === 'deny') parts.push(`<tool_result name="${it.name}" ok="false">The user declined this.</tool_result>`);
      // Outside content only ever in its screened form (data, an extract, or the block line).
      else if (it.result) parts.push(`<tool_result name="${it.name}" ok="${it.result.ok}">\n${it.result.screened ?? esc(it.result.output)}\n</tool_result>`);
    }
  }
  if (t.state === 'stopped') parts.push('<note>The user stopped this reply here.</note>');
  return parts.join('\n');
}

// session: the reduced view, whose last turn is the one being answered.
export function buildPrompt(session, recall, { timezone }, name = 'Nova') {
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
    (session.turns.at(-1)?.followup ? `Continue as ${name}: comment on the report, as the last <followup> asks. Write only your comment.` : `Continue as ${name}: reply to the user's latest message. Write only your reply.`);
}
