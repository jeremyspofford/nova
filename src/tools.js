// Nova's tools, and the plain-text protocol the model uses to call them.
//
// The protocol is text so any agent_cmd can drive it: the model ends its
// message with one <tool_call name="...">{json}</tool_call> block and stops.
// Nova runs the tool (asking the user first where required) and calls the model
// again with the result in the transcript.
import { spawn } from 'node:child_process';
import { trackChild } from './core/index.ts';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { inHome, inSecretDir } from './home.js';
import { safeFetch } from './safe-fetch.js';

const MAX_READ = 200_000;
const MAX_OUTPUT = 16_000;
const MAX_FETCH = 20_000;
const UA = 'Nova/0.1 (personal agent)';
export const SEARCH_URL = 'https://html.duckduckgo.com/html/';

// Secrets live in ~/vault/ and ~/mesh/ (Era 2 kept connection secrets in ~/connectors/). No tool
// reads or writes them.
//
// Nova's own state is not the agent's to touch (a hole older than the M7 amendment, closed with
// its review): write_file writes only inside workspace/ and to the standing files the agent is
// meant to edit (WRITABLE); read_file never reads Nova's database, checkpoints (identity and vault
// keys are in them), pre-upgrade backups, the home's git history, a factory reset's marker or the
// home's sentinel (UNREADABLE).
//  - Names are compared as a case-insensitive disk (macOS, Windows) sees them: NFC, lower case.
//  - A read follows links, and is checked where it really lands.
//  - A write never goes through a link at all, not even one that leads nowhere yet: every part of
//    the path is looked at (lstat), and the file is opened with O_NOFOLLOW.
export const WRITABLE = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md'];
const fold = (name) => String(name).normalize('NFC').toLowerCase();
const WRITABLE_FOLDED = new Set(WRITABLE.map(fold));
const UNREADABLE = new Set(['checkpoints', 'backups', '.git', 'factory-reset.json', '.nova-home']);
const DB = /^nova\.db/;

// The path as it really is: the deepest part that exists, with its links followed, then the rest.
function real(abs) {
  let at = abs;
  const rest = [];
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) break;
    rest.unshift(basename(at));
    at = up;
  }
  return join(realpathSync(at), ...rest);
}

// Whether any part of `rel` under `root` is a link (a dangling one included).
function throughLink(root, rel) {
  let at = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    at = join(at, part);
    let st;
    try { st = lstatSync(at); } catch { return false; } // not there yet: nothing below it is either
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

function guard(home, path, verb) {
  const lexical = inHome(home, path);
  const root = realpathSync(home);
  const writing = verb !== 'read';
  if (writing && throughLink(root, relative(resolve(home), lexical))) throw new Error(`${path} goes through a link, so it can't be ${verb}`);
  const abs = writing ? join(root, relative(resolve(home), lexical)) : real(lexical);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`${path} leads outside Nova's home, so it can't be ${verb}`);
  const rel = relative(root, abs);
  const posix = fold(rel.split(sep).join('/'));
  const dir = inSecretDir(posix);
  if (dir) throw new Error(`${dir === 'mesh' ? 'Device keys' : 'Connection secrets'} in ${dir}/ can't be ${verb}`);
  const top = posix.split('/')[0];
  if (verb === 'read' && (UNREADABLE.has(top) || DB.test(top))) throw new Error(`${path} is Nova's own state (its database, checkpoints, backups or history), so it can't be read`);
  return { abs, rel, posix, top };
}

// Where a path in the home really is, as read_file would read it: { abs, rel } (rel with /).
export function homeTarget(home, path) {
  const { abs, rel } = guard(home, path, 'read');
  return { abs, rel: rel.split(sep).join('/') };
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
      const { abs, rel, posix, top } = guard(home, path, 'written');
      if (top === 'sessions') throw new Error('Session logs are an audit trail and cannot be edited');
      if (posix === 'memory.md' || top === 'memory') throw new Error('Memory is kept with <remember> and <note> blocks, not write_file');
      if (top === 'schedules') throw new Error('Schedules are set with schedule_set, which the person approves, not write_file');
      if (posix === 'permissions.md') throw new Error('Only the person changes what Nova may do on its own');
      // Allowed only as spelled exactly and after folding: folding makes refusals stricter, never wider.
      const exact = rel.split(sep).join('/');
      const allowed = (name, first) => WRITABLE_FOLDED.has(name) || (first === 'workspace' && name !== 'workspace');
      if (!allowed(posix, top) || !(WRITABLE.includes(exact) || (exact.split('/')[0] === 'workspace' && exact !== 'workspace'))) throw new Error(`${path} can't be written: Nova writes only in workspace/ and its standing files (${WRITABLE.join(', ')}). The rest of its home is Nova's own state.`);
      if (typeof content !== 'string') throw new Error('content must be a string');
      mkdirSync(dirname(abs), { recursive: true });
      // Never through a link, even if one appeared since the check.
      const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
      try { writeSync(fd, content); } finally { closeSync(fd); }
      return `Wrote ${Buffer.byteLength(content)} bytes to ${rel}`;
    },
  },
  exec: {
    signature: '{"command": "git status"}',
    doc: 'Run a shell command in ~/workspace. The user approves each command before it runs, unless permissions.md lets commands run without asking.',
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
    // Only the public web: never Nova itself or the person's own network (safe-fetch.js).
    // `fetchAllow` is for tests alone; the runner passes it only when a test built it with one.
    // `seen` hands the raw page to the ingest screen, which reads what the page hides.
    async run({ url }, { signal, fetchAllow, seen }) {
      if (!/^https?:\/\//i.test(String(url))) throw new Error('Only http and https URLs can be fetched');
      const res = await safeFetch(String(url), { signal, headers: { 'user-agent': UA }, ...(fetchAllow ? { allow: fetchAllow } : {}) });
      // A page that didn't come back is a failed step, not a page to read.
      // Only the number: the reason phrase is the server's own words, and outside content.
      if (res.status < 200 || res.status > 299) throw new Error(`The page answered HTTP ${res.status}.`);
      const { type } = res;
      let { text } = res;
      let origin = '';
      try { origin = new URL(res.url).hostname; } catch { /* the URL it asked for */ }
      seen?.({ ...(/html/i.test(type) ? { html: text.slice(0, 2_000_000) } : { text: text.slice(0, 2_000_000) }), origin, ref: res.url });
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
    doc: 'Save a draft in Gmail, as a reply in the same conversation or a new email. It is never sent: the person reviews it and sends it from Gmail. The person approves each draft, unless permissions.md lets drafts go ahead.',
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
    doc: 'Archive emails (archive false puts them back in the inbox), mark them read or unread, and add or remove labels. Give only what should change. The person approves each change, unless permissions.md lets changes go ahead. Nothing is deleted.',
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
    doc: 'Set up work that runs on its own at set times: a five-field cron in the person\'s timezone, and instructions you will follow unattended each time. To change a schedule, give its "id". Reports come to this conversation; add "deliver": "main" to send them to the main conversation. Add "once": true for a one-time reminder. The person approves each schedule, unless permissions.md lets schedules go ahead.',
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
  // Coding through chat (M10c): the chat is the control plane. Starting is tier 1 (everything it
  // writes is Nova's own worktree); the person is asked before the tests and the preview run (tier
  // 2) and every time before a merge (tier 3), in Tasks. In a run that read outside content it asks
  // first, as the ingest gate's guarded steps do (runner.js GUARDED).
  code_change: {
    signature: '{"repo": "/full/path/to/the/repository", "goal": "What the change should do, in plain words", "test_command": "npm test", "preview_command": "npm start", "branch": "main"}',
    doc: 'Have a coding agent make a change in one of the person’s git repositories. Nova makes it on a branch of its own copy, so nothing in their repository changes; then it asks the person before it runs test_command and the optional preview_command (which gets HOST and PORT) on it, and asks again, every time, before it merges into the branch (the checked-out one unless you name one). Nothing is ever pushed. Give "agent" only if the person named one. Tell the person what you started and that they follow it in Tasks; don\'t wait for it.',
    needsApproval: false,
    available: (ctx) => ctx.coding,
    async run(args, { coding, sessionId }) {
      // What the agent may change is the person's to widen, never the model's: a chat request gets
      // the default rule (the review of PR #239, item 3).
      if (args && Object.hasOwn(args, 'editable')) throw new Error('Only you can widen what the agent may change, through Nova’s API (POST /api/v1/coding with editable); a chat request can’t. Ask again without it, and the agent may change source files but not the tests or their settings.');
      const { run } = await coding.start(args ?? {}, { session: sessionId, origin: { kind: 'user', ref: `session:${sessionId}` } });
      return {
        output: `Started coding run ${run.id}: ${run.agent_name} writes “${run.title}” on Nova’s branch ${run.nova_branch}, from ${run.branch} in ${run.repo}. Nothing in the repository changes until the person confirms the merge. Nova asks them before it runs \`${run.test_command}\`${run.preview_command ? ' and the preview' : ''}, and again before it merges; they follow it in Tasks.`,
        summary: run.title,
        link: '/tasks',
      };
    },
  },
  code_status: {
    signature: '{}',
    doc: 'The coding runs started from chat or Tasks, newest first, and where each stands (writing, waiting for the person’s OK to test, ready to merge, merged, declined, failed), with the reason.',
    needsApproval: false,
    available: (ctx) => ctx.coding,
    run(_args, { coding }) {
      const runs = coding.list().slice(0, 20);
      if (!runs.length) return { output: 'No coding runs yet.', summary: 'no runs' };
      return {
        output: runs.map((r) => `${r.id} · ${r.title} · ${r.state} · ${r.branch} in ${r.repo}${r.reason ? `\n  ${r.reason}` : ''}`).join('\n'),
        summary: `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`,
      };
    },
  },
  // Infrastructure, networking and accounts through chat (M10d). Each starts work that asks the
  // person in Tasks before anything changes outside (tier 3, every time); in a run that read outside
  // content each asks before it even starts (runner.js GUARDED). Projects, targets, budgets, prices
  // and tokens are the person's, set outside chat.
  infra_plan: {
    signature: '{"project": "<project name>", "destroy": false}',
    doc: 'Plan an infrastructure project the person registered (OpenTofu configuration in a folder of theirs). Nova runs the plan by itself; it changes nothing. Nova prices it against the project’s monthly budget: a plan inside it is shown to the person in full, and applied only when they confirm, every time, in Tasks, after a checkpoint. A plan over budget, or with a resource Nova can’t price, is never applied: Nova alerts the person instead. "destroy": true plans removing everything in the project. You can’t change a project, its budget or its prices: the person does, outside chat. Tell the person what you started; don’t wait for it.',
    needsApproval: false,
    available: (ctx) => ctx.ops,
    run(args, { ops, sessionId }) {
      const { run } = ops.infra.start({ project: args?.project, destroy: args?.destroy === true }, { session: sessionId, origin: { kind: 'user', ref: `session:${sessionId}` } });
      return {
        output: `Started infrastructure run ${run.id} on “${run.project.name}”${run.destroy ? ', planning to destroy everything in it' : ''}. Nova runs the plan now (it changes nothing) and prices it against the project’s budget; the person sees the plan in full and confirms any apply in Tasks. Nothing is applied before that, and nothing over budget ever is.`,
        summary: run.title,
        link: '/tasks',
      };
    },
  },
  infra_status: {
    signature: '{}',
    doc: 'Infrastructure: whether OpenTofu is on this computer, each project with its budget and what it costs a month, and each run’s state (planning, waiting for the person to apply, applied, over budget, declined, failed) with the reason.',
    needsApproval: false,
    available: (ctx) => ctx.ops,
    run(_args, { ops }) {
      const x = ops.infra.list();
      const projects = x.projects.map((p) => `${p.name} · ${p.words} · ${p.resources.length} ${p.resources.length === 1 ? 'resource' : 'resources'}`);
      const runs = x.runs.slice(0, 20).map((r) => `${r.id} · ${r.title} · ${r.state}${r.reason ? `\n  ${r.reason}` : ''}`);
      return {
        output: [`OpenTofu ${x.tool.installed ? 'is' : 'isn’t'} on this computer.`, projects.length ? `Projects:\n${projects.join('\n')}` : 'No projects: the person registers one outside chat.', runs.length ? `Runs:\n${runs.join('\n')}` : 'No runs yet.'].join('\n'),
        summary: `${x.projects.length} projects, ${x.runs.length} runs`,
      };
    },
  },
  network_change: {
    signature: '{"target": "<target name>", "patch": {"firewall": {"allow_ssh": false}}, "title": "Close SSH from outside"}',
    doc: 'Change a network target the person registered (a router, DNS, a firewall, a tailnet’s policy) with a JSON merge patch of its configuration (an object of what changes; null removes a key). Nova takes a snapshot and works out the diff; the person confirms the change in Tasks, every time; after it, if Nova can’t hear from one of their devices within a few minutes, it puts the snapshot back by itself. Never put a password, key or token in a patch: secrets aren’t changed from chat. network_status lists the targets and changes.',
    needsApproval: false,
    available: (ctx) => ctx.ops,
    run(args, { ops, sessionId }) {
      const { change } = ops.network.start({ target: args?.target, patch: args?.patch, ...(args?.title ? { title: args.title } : {}) }, { session: sessionId, origin: { kind: 'user', ref: `session:${sessionId}` } });
      return {
        output: `Started network change ${change.id} on ${change.target.name}: “${change.title}”. Nova takes a snapshot and works out the diff now; nothing changes until the person confirms it in Tasks. After the change, if Nova can’t hear from one of their devices within ${Math.round(change.window_s / 60)} minutes, it puts the snapshot back by itself.`,
        summary: change.title,
        link: '/tasks',
      };
    },
  },
  network_status: {
    signature: '{}',
    doc: 'Networking: the targets the person registered (names and kinds, never their configuration), the devices whose contact keeps a change, and each change’s state (waiting for the person, watching for contact, kept, reverted) with the reason.',
    needsApproval: false,
    available: (ctx) => ctx.ops,
    run(_args, { ops }) {
      const x = ops.network.list();
      const targets = x.targets.map((t) => `${t.name} · ${t.kind}${t.token ? '' : ' · its token isn’t saved yet'}`);
      const changes = x.changes.slice(0, 20).map((c) => `${c.id} · ${c.title} · ${c.target.name} · ${c.state}${c.changed.length ? ` · ${c.changed.join(', ')}` : ''}${c.reason ? `\n  ${c.reason}` : ''}`);
      return {
        output: [targets.length ? `Targets:\n${targets.join('\n')}` : 'No targets: the person registers one outside chat.', `Devices that keep a change: ${x.devices.map((d) => d.name).join(', ') || 'none paired'}. The window is ${Math.round(x.window_s / 60)} minutes.`, changes.length ? `Changes:\n${changes.join('\n')}` : 'No changes yet.'].join('\n'),
        summary: `${x.targets.length} targets, ${x.changes.length} changes`,
      };
    },
  },
  account_change: {
    signature: '{"change": "password", "site": "accounts.example.com", "steps": [{"do": "navigate", "url": "https://accounts.example.com/security"}, {"do": "new_password", "current": "#current", "password": "#new", "confirm": "#again", "submit": "#save", "done_when": ".saved"}], "verify": {"url": "https://accounts.example.com/security", "expect": ["Password updated"]}}',
    doc: 'Change an account in Nova’s own browser, on one site: "change" is "password" (a new_password step: Nova makes the new password itself and keeps it in the vault), "create" (a create_account step with "name", the account’s email address or user name) or "mfa" (two-step sign-in, with a "code" step where the person types the code themselves). "steps" is a browser plan on that site (navigate, click, wait, read, login with the saved sign-in, and the account step), naming fields by CSS selector; "verify" names the page that shows it worked. Never ask the person for a password or a code in chat, and never put one in a plan: Nova types saved sign-ins and new passwords itself, and the person types codes. They confirm it in Tasks, every time, and must be there while it runs.',
    needsApproval: false,
    available: (ctx) => ctx.ops,
    run(args, { ops, sessionId }) {
      const t = ops.browser.account({ change: args?.change, site: args?.site, steps: args?.steps, verify: args?.verify, ...(args?.title ? { title: args.title } : {}) }, { origin: { kind: 'user', ref: `session:${sessionId}` } });
      return {
        output: `Asked the person in Tasks: “${t.title}”. It runs only when they confirm it, and only while they’re there: Nova types the saved sign-in and the new password it makes itself, and keeps it in the vault; any code is theirs to type. No password goes through this conversation.`,
        summary: t.title,
        link: '/tasks',
      };
    },
  },
  // Nova's own state, read in process from its registries (src/core/self.ts). Read-only; names and
  // states only, never a secret.
  nova_instance: {
    signature: '{}',
    doc: 'This Nova as it is now: instance and home, the person\'s profile summary, your chat model, every model provider and the local runtime (checked now), connections, open problems.',
    needsApproval: false,
    available: (ctx) => ctx.self,
    async run(_, { self }) { return { output: await self.instance(), summary: 'instance and models' }; },
  },
  nova_capture: {
    signature: '{}',
    doc: 'Capture: each source with its status and detail in its own words, and capture\'s recent errors, quoted.',
    needsApproval: false,
    available: (ctx) => ctx.self,
    run(_, { self }) { return { output: self.capture(), summary: 'capture' }; },
  },
  nova_devices: {
    signature: '{}',
    doc: 'The hub and every paired device: kind, online or not, last seen.',
    needsApproval: false,
    available: (ctx) => ctx.self,
    run(_, { self }) { return { output: self.devices(), summary: 'devices' }; },
  },
  nova_schedules: {
    signature: '{}',
    doc: 'Schedules with when they run and how their last run went (errors quoted), and automation rules with their last firing.',
    needsApproval: false,
    available: (ctx) => ctx.self,
    run(_, { self }) { return { output: self.schedules(), summary: 'schedules' }; },
  },
  nova_settings: {
    signature: '{"part": "appearance"}',
    doc: 'One part of the settings: appearance, permissions (what you may do without asking), privacy, user, identity, tuning, models, capture, providers, policy, mesh, backups. Leave out part to list them. Secrets show only as set or not.',
    needsApproval: false,
    available: (ctx) => ctx.self,
    run({ part }, { self }) { return { output: self.settings(part), summary: typeof part === 'string' && part ? part : 'settings' }; },
  },
  import_files: {
    signature: '{}',
    doc: 'List the files waiting in ~/workspace/import/. Their names come from outside, so they arrive screened, as data.',
    needsApproval: false,
    available: (ctx) => ctx.self,
    run(_args, { self }) {
      const i = self.imports();
      const lines = [...i.packs.map((p) => `${p.path}: a Nova memory export, ${p.count} ${p.count === 1 ? 'memory' : 'memories'}${p.exported_at ? `, exported ${p.exported_at.slice(0, 10)}` : ''}`), ...i.files.map((f) => `${f.path}: ${f.bytes} bytes`)];
      return { output: lines.length ? lines.join('\n') : 'Nothing waits in ~/workspace/import/.', summary: `${lines.length} ${lines.length === 1 ? 'file' : 'files'}` };
    },
  },
  memory_import: {
    signature: '{"path": "workspace/import/memory.json"}',
    doc: 'Offer the memories in a Nova memory export in ~/workspace/import/ to the person. The file is screened first, and each memory not already kept waits for the person’s OK in Memory: none is in memory until they keep it. The person approves the step. For any other file, read it and suggest memories instead.',
    needsApproval: true,
    permission: { id: 'memory-import', label: 'Offer memories from a file in workspace/import', note: 'They wait for your OK in Memory' },
    available: (ctx) => ctx.self,
    preview({ path }, { self }) {
      const p = self.planImport(path);
      return { path: p.path, total: p.total, fresh: p.fresh, already: p.already, exported_at: p.exported_at };
    },
    async run({ path }, { self }) {
      const r = await self.importPack(path);
      const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
      return {
        output: `${n(r.waiting, 'memory', 'memories')} from ${r.path} now wait for the person’s OK in Memory; none is in memory until they keep it${r.skipped ? `. ${n(r.skipped, 'was', 'were')} already kept or waiting` : ''}${r.held ? `. ${n(r.held, 'was', 'were')} left out: it looked like it was trying to give instructions` : ''}.`,
        summary: `${n(r.waiting, 'memory', 'memories')} waiting`,
      };
    },
  },
};

// The tools on offer right now: Gmail's only while it's connected, use_skill
// only when a skill is installed, delegate only in a conversation with the person.
export function availableTools({ gmail = false, skills = 0, delegate = false, self = false, coding = false, ops = false } = {}) {
  return Object.keys(TOOLS).filter((n) => !TOOLS[n].available || TOOLS[n].available({ gmail, skills, delegate, self, coding, ops }));
}

// Local-only means nothing leaves the person's devices, so tools that reach the internet (the
// web, Gmail) aren't offered at all. exec is not filtered: it asks first unless permissions.md says yes.
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
