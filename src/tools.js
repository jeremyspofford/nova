// Nova's tools, and the plain-text protocol the model uses to call them.
//
// The protocol is text so any agent_cmd can drive it: the model ends its
// message with one <tool_call name="...">{json}</tool_call> block and stops.
// Nova runs the tool (asking the user first where required) and calls the model
// again with the result in the transcript.
import { spawn } from 'node:child_process';
import { trackChild } from './core/index.ts';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { inHome, inSecretDir } from './home.js';

const MAX_READ = 200_000;
const MAX_OUTPUT = 16_000;
const MAX_FETCH = 20_000;
const UA = 'Nova/0.1 (personal agent)';
export const SEARCH_URL = 'https://html.duckduckgo.com/html/';

// Secrets live in ~/vault/ and ~/mesh/ (Era 2 kept connection secrets in ~/connectors/). No tool
// reads or writes them.
function guard(home, path, verb) {
  const abs = inHome(home, path);
  const rel = relative(home, abs);
  const dir = inSecretDir(rel.split(sep).join('/'));
  if (dir) throw new Error(`${dir === 'mesh' ? 'Device keys' : 'Connection secrets'} in ${dir}/ can't be ${verb}`);
  return { abs, rel };
}

export const TOOLS = {
  read_file: {
    signature: '{"path": "USER.md"}',
    doc: 'Read a text file in your home (standing files, memory/, workspace/).',
    needsApproval: false,
    async run({ path }, { home }) {
      const { abs } = guard(home, path, 'read');
      if (statSync(abs).isDirectory()) throw new Error(`${path} is a folder`);
      const text = readFileSync(abs, 'utf8');
      return text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n[truncated: file is ${text.length} characters]` : text;
    },
  },
  write_file: {
    signature: '{"path": "workspace/trip/plan.md", "content": "..."}',
    doc: 'Create or replace a text file in your home: your workspace and the standing files. MEMORY.md and memory/ are kept with memory blocks instead (below).',
    needsApproval: false,
    async run({ path, content }, { home }) {
      const { abs, rel } = guard(home, path, 'written');
      if (rel === 'sessions' || rel.startsWith(`sessions${sep}`)) throw new Error('Session logs are an audit trail and cannot be edited');
      if (rel === 'MEMORY.md' || rel === 'memory' || rel.startsWith(`memory${sep}`)) throw new Error('Memory is kept with <remember> and <note> blocks, not write_file');
      if (rel === 'schedules' || rel.startsWith(`schedules${sep}`)) throw new Error('Schedules are set with schedule_set, which the person approves, not write_file');
      if (rel === 'permissions.md') throw new Error('Only the person changes what Nova may do on its own');
      if (typeof content !== 'string') throw new Error('content must be a string');
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return `Wrote ${Buffer.byteLength(content)} bytes to ${rel}`;
    },
  },
  exec: {
    signature: '{"command": "git status"}',
    doc: 'Run a shell command in ~/workspace. The user approves every command before it runs.',
    needsApproval: true,
    permission: { id: 'commands', label: 'Run commands on this computer', note: 'A command can change anything your account can' },
    run({ command }, { home, signal, timeoutMs }) {
      if (typeof command !== 'string' || !command.trim()) throw new Error('command is required');
      return runCommand(command, { cwd: join(home, 'workspace'), signal, timeoutMs });
    },
  },
  web_fetch: {
    signature: '{"url": "https://example.com"}',
    doc: 'Fetch a web page (http or https) and read it as text.',
    needsApproval: false,
    online: true,
    async run({ url }, { signal }) {
      if (!/^https?:\/\//i.test(String(url))) throw new Error('Only http and https URLs can be fetched');
      const res = await fetch(url, {
        signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]),
        headers: { 'user-agent': UA },
      });
      // A page that didn't come back is a failed step, not a page to read.
      if (!res.ok) { res.body?.cancel(); throw new Error(`The page answered HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`); }
      const type = res.headers.get('content-type') ?? '';
      let text = await res.text();
      if (/html/i.test(type)) text = htmlToText(text);
      const head = `HTTP ${res.status} ${res.statusText} · ${type || 'unknown type'}\n\n`;
      return head + (text.length > MAX_FETCH ? `${text.slice(0, MAX_FETCH)}\n[truncated]` : text);
    },
  },
  web_search: {
    signature: '{"query": "merino wool hiking socks"}',
    doc: 'Search the web. You get the top results: a title, a link and a line about each.',
    needsApproval: false,
    online: true,
    async run({ query }, { signal, searchUrl = SEARCH_URL }) {
      const q = String(query ?? '').trim();
      if (!q) throw new Error('query is required');
      let res;
      try {
        res = await fetch(`${searchUrl}?q=${encodeURIComponent(q)}`, {
          signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]),
          headers: { 'user-agent': UA },
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        throw new Error("Couldn't reach the search engine. Check the connection and try again.");
      }
      if (!res.ok) throw new Error(`The search engine didn't answer (HTTP ${res.status}).`);
      const results = parseSearch(await res.text());
      if (!results.length) return { output: `No results for “${q}”.`, summary: 'no results' };
      return {
        output: results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}${r.snippet ? `\n${r.snippet}` : ''}`).join('\n\n'),
        summary: `${results.length} results`,
      };
    },
  },
  use_skill: {
    signature: '{"name": "email-summary"}',
    doc: "Load a skill's playbook (see Skills) before doing that kind of work.",
    needsApproval: false,
    available: (ctx) => ctx.skills > 0,
    run({ name }, ctx) { return ctx.useSkill(String(name ?? '')); },
  },
  gmail_search: {
    signature: '{"query": "in:inbox newer_than:1d", "max": 20}',
    doc: "Search the person's Gmail with Gmail search syntax.",
    needsApproval: false,
    available: (ctx) => ctx.gmail,
    mail: true,
    run(args, { gmail, signal }) { return gmail.search(args, { signal }); },
  },
  gmail_read: {
    signature: '{"id": "<id from gmail_search>"}',
    doc: 'Read one email in full.',
    needsApproval: false,
    available: (ctx) => ctx.gmail,
    mail: true,
    run(args, { gmail, signal }) { return gmail.readMessage(args, { signal }); },
  },
  gmail_draft: {
    signature: '{"reply_to": "<id from gmail_search>", "body": "..."} or {"to": "sam@example.com", "subject": "...", "body": "..."}',
    doc: 'Save a draft in Gmail, as a reply in the same conversation or a new email. It is never sent: the person reviews it and sends it from Gmail. The person approves every draft.',
    needsApproval: true,
    permission: { id: 'gmail-drafts', label: 'Save Gmail drafts', note: 'Nova has no way to send email' },
    available: (ctx) => ctx.gmail,
    async preview(args, { gmail, signal }) {
      const p = await gmail.planDraft(args, { signal });
      return { to: p.to, cc: p.cc, subject: p.subject, body: p.body, reply: !!p.threadId };
    },
    run(args, { gmail, signal }) { return gmail.draft(args, { signal }); },
  },
  gmail_organize: {
    signature: '{"ids": ["<id>", "<id>"], "archive": true, "read": true, "add_labels": ["Bills"], "remove_labels": []}',
    doc: 'Archive emails (archive false puts them back in the inbox), mark them read or unread, and add or remove labels. Give only what should change. The person approves every change. Nothing is deleted.',
    needsApproval: true,
    permission: { id: 'gmail-tidy', label: 'Tidy Gmail: archive, mark read or unread, labels', note: 'Nova has no way to delete email' },
    available: (ctx) => ctx.gmail,
    async preview(args, { gmail, signal }) {
      const p = await gmail.planChange(args, { signal });
      return { verb: p.verb, create: p.create, messages: p.messages.map(({ from, subject }) => ({ from, subject })) };
    },
    run(args, { gmail, signal }) { return gmail.change(args, { signal }); },
  },
  delegate: {
    signature: '{"title": "Compare e-bikes", "task": "Everything the helper needs to know, and what to report back", "files": ["workspace/bikes/notes.md"]}',
    doc: "Hand a self-contained piece of work to a helper that does it in the background while you carry on: research, comparing options, going through files. The helper starts fresh: it sees only the task, who the person is, and the files you list (up to five in your home), so put everything it needs in the task. It can't ask the person anything. Its report arrives in this conversation later as a <handoff>; tell the person what you've started, then don't wait for it or guess what it will say. Up to three helpers work at once.",
    needsApproval: false,
    available: (ctx) => ctx.delegate,
    run(args, ctx) {
      const h = ctx.delegate(args);
      return { output: `A helper started on “${h.title}”${h.queued ? ' (it starts as soon as one of the others finishes)' : ''}. Its report will arrive in this conversation as a <handoff> when it's done.`, summary: h.title, link: `/activity#a-${h.run}` };
    },
  },
  schedule_set: {
    signature: '{"name": "Morning digest", "cron": "0 7 * * 1-5", "prompt": "What to do each time, as instructions to yourself"}',
    doc: 'Set up work that runs on its own at set times: a five-field cron in the person\'s timezone, and instructions you will follow unattended each time. To change a schedule, give its "id". Reports come to this conversation; add "deliver": "main" to send them to the main conversation. Add "once": true for a one-time reminder. The person approves every schedule.',
    needsApproval: true,
    permission: { id: 'schedules', label: 'Set up, change and remove schedules' },
    preview(args, { schedules, sessionId }) {
      const p = schedules.plan(args, { from: sessionId });
      return { name: p.name, when: p.when, next: p.next, deliver: p.deliver === sessionId ? 'here' : p.deliver, prompt: p.prompt, replaces: p.replaces, once: p.once };
    },
    run(args, { schedules, sessionId }) {
      const s = schedules.set(args, { from: sessionId });
      return { output: `${s.name} is set: ${s.when}. The next run is ${s.next}. Reports go to ${s.deliver === 'main' ? 'the main conversation' : 'this conversation'}.`, summary: s.name };
    },
  },
  schedule_remove: {
    signature: '{"id": "morning-digest"}',
    doc: 'Remove a schedule so it never runs again. The person approves it.',
    needsApproval: true,
    permission: { id: 'schedules', label: 'Set up, change and remove schedules' },
    preview({ id }, { schedules }) {
      const s = schedules.get(String(id ?? ''));
      if (!s) throw new Error(`There's no schedule with the id ${id}.`);
      return { name: s.name, when: s.when };
    },
    run({ id }, { schedules }) {
      const s = schedules.remove(String(id ?? ''));
      return { output: `Removed ${s.name}. It won't run again.`, summary: s.name };
    },
  },
};

// The tools on offer right now: Gmail's only while it's connected, use_skill
// only when a skill is installed, delegate only in a conversation with the person.
export function availableTools({ gmail = false, skills = 0, delegate = false } = {}) {
  return Object.keys(TOOLS).filter((n) => !TOOLS[n].available || TOOLS[n].available({ gmail, skills, delegate }));
}

// Local-only means nothing leaves the person's devices, so tools that reach the internet (the
// web, Gmail) aren't offered at all. exec is not filtered: it always asks first.
export function withinPrivacy(names, mode) {
  return mode === 'local-only' ? names.filter((n) => !(TOOLS[n]?.online || TOOLS[n]?.mail || n.startsWith('gmail_'))) : names;
}

// DuckDuckGo's HTML results page, without ads.
export function parseSearch(html, limit = 8) {
  const out = [];
  const seen = new Set();
  for (const chunk of String(html).split(/(?=<a\b[^>]*class="result__a")/).slice(1)) {
    const tag = chunk.match(/^<a\b[^>]*>/)?.[0] ?? '';
    let url = (tag.match(/href="([^"]+)"/)?.[1] ?? '').replace(/&amp;/g, '&');
    if (url.startsWith('//')) url = `https:${url}`;
    try {
      const u = new URL(url);
      if (u.hostname.endsWith('duckduckgo.com') && u.searchParams.get('uddg')) url = u.searchParams.get('uddg');
      const real = new URL(url);
      if (!/^https?:$/.test(real.protocol) || real.hostname.endsWith('duckduckgo.com')) continue;
    } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    const title = htmlToText(chunk.match(/^<a\b[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '');
    const snippet = htmlToText(chunk.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '');
    out.push({ title: title || url, url, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

export function toolProtocol(names = availableTools()) {
  const list = names
    .map((name) => `- ${name} ${TOOLS[name].signature}\n  ${TOOLS[name].doc}`)
    .join('\n');
  return `# Tools

You can use these tools:

${list}

To use one, end your message with exactly one block in this form, and stop writing:

<tool_call name="read_file">{"path": "USER.md"}</tool_call>

The body is a JSON object with the arguments. Write anything the user should read before the block; never write after it. You will get the result in a <tool_result> block and can continue. Use one tool per message. If a tool is declined or fails, say so plainly and carry on without it.`;
}

export function memoryProtocol() {
  return `# Memory blocks

Keep memory with blocks at the end of your reply, after your text and before any tool call. The person never sees them; Nova saves them before your reply finishes.

<remember kind="preference">Takes coffee black, no sugar.</remember>
<remember replaces="m1a2b3c4">Lives in Porto; moved from Lisbon in October 2026.</remember>
<forget id="m1a2b3c4"></forget>
<note>Planning a March trip to Lisbon; comparing flights.</note>

- remember: a durable fact, preference, decision or commitment for MEMORY.md. kind is fact, preference, decision or commitment.
- remember with replaces: a correction. It replaces the entry with that id (the [id:…] after each entry in MEMORY.md) instead of adding a second, conflicting one.
- forget: when the person asks you to forget something, by id. It also forgets matching day notes.
- note: day-level detail for today's dated note, found later by search.

One idea per block, on one line, written to make sense weeks from now without this conversation. Leave memory alone when nothing worth keeping changed, and never store secrets.`;
}

const OPEN = '<tool_call';
const CALL_RE = /<tool_call\s+name="([\w-]+)"\s*>([\s\S]*?)<\/tool_call>/;
const MEMORY_TAGS = ['remember', 'note', 'forget'];
const OPENERS = [OPEN, ...MEMORY_TAGS.map((t) => `<${t}`)];

// Streams the model's text through, holding back markup so it never flashes
// on screen: memory blocks are skipped, and a tool call ends what is shown.
export class ToolTagFilter {
  constructor() { this.raw = ''; this.sent = 0; this.closed = false; }
  push(chunk) {
    this.raw += chunk;
    let out = '';
    while (!this.closed) {
      const rest = this.raw.slice(this.sent);
      const at = rest.search(/<(tool_call|remember|note|forget)[\s>]/);
      if (at < 0) {
        // Hold back a trailing partial opener such as "<rem".
        let end = rest.length;
        const lt = rest.lastIndexOf('<');
        if (lt >= 0 && OPENERS.some((o) => (o + ' ').startsWith(rest.slice(lt)))) end = lt;
        out += rest.slice(0, end);
        this.sent += end;
        break;
      }
      out += rest.slice(0, at);
      this.sent += at;
      const tag = rest.slice(at + 1).match(/^\w+/)[0];
      if (tag === 'tool_call') { this.closed = true; break; }
      const close = rest.indexOf(`</${tag}>`, at);
      if (close < 0) break; // wait for the rest of the block
      this.sent += close + tag.length + 3 - at;
    }
    return out;
  }
}

// Takes the memory blocks out of a finished message.
//   <remember kind="preference">…</remember>
//   <remember replaces="m1a2b3c4">…</remember>
//   <note>…</note>
//   <forget id="m1a2b3c4"></forget>
export function extractMemory(raw) {
  const ops = [];
  const text = raw.replace(/<(remember|note|forget)((?:\s+[\w-]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/\1>)\n?/g, (_, tag, attrs, body = '') => {
    const a = Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (tag === 'remember') ops.push({ op: 'remember', kind: a.kind, replaces: a.replaces, text: body.trim() });
    if (tag === 'note') ops.push({ op: 'note', text: body.trim() });
    if (tag === 'forget') ops.push({ op: 'forget', id: a.id ?? body.trim() });
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n'), ops };
}

// Splits a finished model message into the prose the user sees and the tool call.
export function parseToolCall(raw, names = Object.keys(TOOLS)) {
  const at = raw.indexOf(OPEN);
  if (at < 0) return { visible: raw.trim(), call: null, error: null };
  const visible = raw.slice(0, at).replace(/```\w*\s*$/, '').trim();
  const m = raw.slice(at).match(CALL_RE);
  if (!m) return { visible, call: null, error: 'The tool call was not closed with </tool_call>.' };
  const [, name, body] = m;
  if (!names.includes(name)) {
    const why = name.startsWith('gmail_') && TOOLS[name] ? 'Gmail is not connected, so there is no tool named' : 'There is no tool named';
    return { visible, call: { name, args: {} }, error: `${why} ${name}.` };
  }
  let args;
  try {
    args = JSON.parse(body.trim() || '{}');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('not an object');
  } catch {
    return { visible, call: { name, args: {} }, error: 'The tool arguments were not a JSON object.' };
  }
  return { visible, call: { name, args }, error: null };
}

export function runCommand(command, { cwd, signal, timeoutMs = 120_000 }) {
  return new Promise((resolvePromise) => {
    mkdirSync(cwd, { recursive: true });
    const shell = process.env.SHELL || '/bin/sh';
    const child = trackChild(spawn(shell, ['-lc', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }), { group: true });
    let out = '';
    const take = (d) => { out += d; if (out.length > MAX_OUTPUT * 4) out = out.slice(-MAX_OUTPUT * 2); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
    const timer = setTimeout(() => { out += `\n[stopped after ${Math.round(timeoutMs / 1000)}s]`; kill(); }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => { clearTimeout(timer); resolvePromise(`Could not start the command: ${e.message}`); });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      const body = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT / 2)}\n[…]\n${out.slice(-MAX_OUTPUT / 2)}` : out;
      resolvePromise(`${body.trimEnd()}\n[exit ${code ?? sig}]`.trimStart());
    });
  });
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', times: '×', deg: '°', euro: '€', pound: '£', cent: '¢', yen: '¥',
};

export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article|header|footer)>|<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? (e.startsWith('#') ? String.fromCodePoint(parseInt(e.slice(1).replace(/^x/, '0x'))) : m))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}
