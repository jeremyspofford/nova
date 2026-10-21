// Nova's tools, and the plain-text protocol the model uses to call them.
//
// The protocol is text so any agent_cmd can drive it: the model ends its
// message with one <tool_call name="...">{json}</tool_call> block and stops.
// Nova runs the tool (asking the user first where required) and calls the model
// again with the result in the transcript.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { inHome } from './home.js';

const MAX_READ = 200_000;
const MAX_OUTPUT = 16_000;
const MAX_FETCH = 20_000;

export const TOOLS = {
  read_file: {
    signature: '{"path": "USER.md"}',
    doc: 'Read a text file in your home (standing files, memory/, workspace/).',
    needsApproval: false,
    async run({ path }, { home }) {
      const abs = inHome(home, path);
      if (statSync(abs).isDirectory()) throw new Error(`${path} is a folder`);
      const text = readFileSync(abs, 'utf8');
      return text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n[truncated: file is ${text.length} characters]` : text;
    },
  },
  write_file: {
    signature: '{"path": "memory/2026-10-21.md", "content": "..."}',
    doc: 'Create or replace a text file in your home. Use it to keep MEMORY.md, dated notes and your workspace current.',
    needsApproval: false,
    async run({ path, content }, { home }) {
      const abs = inHome(home, path);
      const rel = relative(home, abs);
      if (rel === 'sessions' || rel.startsWith(`sessions${sep}`)) throw new Error('Session logs are an audit trail and cannot be edited');
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
    run({ command }, { home, signal, timeoutMs }) {
      if (typeof command !== 'string' || !command.trim()) throw new Error('command is required');
      return runCommand(command, { cwd: join(home, 'workspace'), signal, timeoutMs });
    },
  },
  web_fetch: {
    signature: '{"url": "https://example.com"}',
    doc: 'Fetch a web page (http or https) and read it as text.',
    needsApproval: false,
    async run({ url }, { signal }) {
      if (!/^https?:\/\//i.test(String(url))) throw new Error('Only http and https URLs can be fetched');
      const res = await fetch(url, {
        signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]),
        headers: { 'user-agent': 'Nova/0.1 (personal agent)' },
      });
      const type = res.headers.get('content-type') ?? '';
      let text = await res.text();
      if (/html/i.test(type)) text = htmlToText(text);
      const head = `HTTP ${res.status} ${res.statusText} · ${type || 'unknown type'}\n\n`;
      return head + (text.length > MAX_FETCH ? `${text.slice(0, MAX_FETCH)}\n[truncated]` : text);
    },
  },
};

export function toolProtocol() {
  const list = Object.entries(TOOLS)
    .map(([name, t]) => `- ${name} ${t.signature}\n  ${t.doc}`)
    .join('\n');
  return `# Tools

You can use these tools:

${list}

To use one, end your message with exactly one block in this form, and stop writing:

<tool_call name="read_file">{"path": "USER.md"}</tool_call>

The body is a JSON object with the arguments. Write anything the user should read before the block; never write after it. You will get the result in a <tool_result> block and can continue. Use one tool per message. If a tool is declined or fails, say so plainly and carry on without it.`;
}

const OPEN = '<tool_call';
const CALL_RE = /<tool_call\s+name="([\w-]+)"\s*>([\s\S]*?)<\/tool_call>/;

// Streams the model's text through, holding back anything that might be the
// start of a tool call so markup never flashes on screen.
export class ToolTagFilter {
  constructor() { this.raw = ''; this.sent = 0; this.closed = false; }
  push(chunk) {
    this.raw += chunk;
    if (this.closed) return '';
    const at = this.raw.indexOf(OPEN);
    let end = at >= 0 ? at : this.raw.length;
    if (at >= 0) this.closed = true;
    else {
      // hold back a trailing partial "<tool_c…"
      for (let k = Math.min(OPEN.length - 1, this.raw.length); k > 0; k--) {
        if (OPEN.startsWith(this.raw.slice(-k))) { end = this.raw.length - k; break; }
      }
    }
    const out = this.raw.slice(this.sent, end);
    this.sent = Math.max(this.sent, end);
    return out;
  }
}

// Splits a finished model message into the prose the user sees and the tool call.
export function parseToolCall(raw) {
  const at = raw.indexOf(OPEN);
  if (at < 0) return { visible: raw.trim(), call: null, error: null };
  const visible = raw.slice(0, at).replace(/```\w*\s*$/, '').trim();
  const m = raw.slice(at).match(CALL_RE);
  if (!m) return { visible, call: null, error: 'The tool call was not closed with </tool_call>.' };
  const [, name, body] = m;
  if (!TOOLS[name]) return { visible, call: { name, args: {} }, error: `There is no tool named ${name}.` };
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
    const child = spawn(shell, ['-lc', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article|header|footer)>|<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? (e.startsWith('#') ? String.fromCodePoint(parseInt(e.slice(1).replace(/^x/, '0x'))) : m))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}
