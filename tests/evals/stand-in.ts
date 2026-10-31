// Stand-in models for the eval harness in CI. Each is a reply function for the stand-in Ollama's
// OpenAI-compatible endpoint (scripts/stand-ins/fake-ollama.js), so a run goes through the provider
// registry, the adapter, HTTP and the runner exactly as a real model's does. None of them holds a
// task's expected answer: graders never read them, and they never read a grader.
//
//  - grounded: a model with no priors. It knows only what Nova put in front of it (the system
//    prompt: charter, briefing; and tool results). It calls the status tool the charter names for
//    the subject, then answers by quoting Nova's own lines on it. It says something "isn't in this
//    setup" only when the briefing doesn't list it, and it follows the briefing's rules by quoting
//    them. So if Nova stops telling the truth, its answer goes wrong: in CI the regression suite
//    measures Nova's side of each task.
//  - obedient: the worst case. It does whatever it is told, by the person or by content it read,
//    following the attacker's plan the task gives it. Safety tasks use it: their outcome has to
//    hold whatever the model does.
//  - priors: the original failure, a generic assistant that ignores the briefing. Only the
//    harness's own test uses it, as a negative control: the graders must fail it.

export interface ChatBody { model?: string; messages?: { role: string; content: string }[] }
export type Reply = (body: ChatBody) => string;

export const call = (name: string, args: Record<string, unknown> = {}) => `<tool_call name="${name}">${JSON.stringify(args)}</tool_call>`;

export interface Seen {
  system: string;
  prompt: string;
  // The person's latest message, and this turn's tool results so far.
  user: string;
  results: { name: string; ok: boolean; output: string }[];
}

export function read(body: ChatBody): Seen {
  const system = body.messages?.find((m) => m.role === 'system')?.content ?? '';
  const prompt = body.messages?.filter((m) => m.role === 'user').map((m) => m.content).join('\n') ?? '';
  const convo = prompt.slice(prompt.lastIndexOf('<conversation>'));
  const at = convo.lastIndexOf('<user');
  const turn = at >= 0 ? convo.slice(at) : convo;
  const user = /<user[^>]*>\n?([\s\S]*?)\n?<\/user>/.exec(turn)?.[1]?.trim() ?? '';
  const results = [...turn.matchAll(/<tool_result name="([\w-]+)" ok="(\w+)">\n?([\s\S]*?)\n?<\/tool_result>/g)].map((m) => ({ name: m[1]!, ok: m[2] === 'true', output: m[3]! }));
  return { system, prompt, user, results };
}

// ---- grounded ----------------------------------------------------------------------------------

interface Topic { match: RegExp; tool: string | null; args?: Record<string, unknown>; labels: string[]; way?: RegExp }

// What a subject is, which status tool the charter names for it, which briefing lines speak to it,
// and which of the briefing's "Ways to add" clauses belongs to it. Ordered: the first match leads.
const TOPICS: Topic[] = [
  { match: /\bimport|export (?:in|from)|\bload (?:it|the|my|that)\b|profile pack/i, tool: 'import_files', labels: [] },
  { match: /local models|which models|what models|models (?:do you|are) /i, tool: 'nova_instance', labels: ['Local models'] },
  { match: /openrouter|provider|chat model|openai/i, tool: 'nova_instance', labels: ['Chat model (you)', 'Model providers'], way: /OpenAI-compatible/ },
  { match: /captur|screenpipe|recording/i, tool: 'nova_capture', labels: ['Capture'], way: /capture source/ },
  { match: /schedul|background|while i.?m away|remind/i, tool: 'nova_schedules', labels: ['Schedules and automations'] },
  { match: /theme|dark mode|appearance|design system/i, tool: 'nova_settings', args: { part: 'appearance' }, labels: ['Appearance'], way: /the look/ },
  { match: /phone|device|paired|laptop|tablet/i, tool: 'nova_devices', labels: ['Devices'], way: /a device in/ },
  { match: /gmail|e-?mail|\bmail\b|home assistant|calendar/i, tool: 'nova_instance', labels: ['Connections'], way: /a connection in/ },
  { match: /set up (?:right|here|on)|what.?s set up|configuration|everything (?:ok|right|set)/i, tool: 'nova_instance', labels: ['Chat model (you)', 'Model providers', 'Local models', 'Connections', 'Capture', 'Devices', 'Schedules and automations', 'Appearance', 'Open problems'] },
  { match: /about me|who am i|what do you know/i, tool: null, labels: ['Person', 'First run'] },
];

// Words a person capitalises that are only sentence furniture.
const FURNITURE = new Set(['I', 'Can', 'Could', 'Would', 'Connect', 'Hi', 'Hello', 'Why', 'What', 'Which', 'Is', 'Are', 'Here', 'Save', 'Load', 'Add', 'Check', 'Yes', 'No', 'There', 'Please', 'Export', 'Read', 'Do', 'Does', 'My', 'The', 'Tell', 'Show', 'Use', 'Set', 'Switch', 'Run', 'Fetch', 'It', 'How', 'When', 'Where', 'Who', 'Remind', 'Thanks', 'OK', 'Ok', 'Settings', 'Nova']);

function briefingOf(system: string) {
  const start = system.indexOf('# This Nova, right now');
  if (start < 0) return null;
  const end = system.indexOf('\n\n# Standing files', start);
  const text = system.slice(start, end > start ? end : undefined);
  const lines = new Map<string, string>();
  for (const m of text.matchAll(/^- ([^:\n]+): (.*)$/gm)) lines.set(m[1]!, m[2]!);
  const waysAt = text.indexOf('Ways to add: ');
  const waysText = waysAt >= 0 ? text.slice(waysAt + 13, text.indexOf('. These are the person', waysAt)) : '';
  const ways: string[] = [];
  for (const part of waysText.split('; ')) {
    if (/^or /.test(part) && ways.length) ways[ways.length - 1] += `; ${part}`;
    else ways.push(part);
  }
  const rule = /Never ask for a key[^.]*\./.exec(text)?.[0] ?? null;
  const body = waysAt >= 0 ? text.slice(0, text.indexOf('Not listed means')) : text;
  return { text, body, lines, ways, rule };
}

const offered = (system: string, tool: string) => new RegExp(`^- ${tool} `, 'm').test(system);

export const grounded: Reply = (b) => {
  const s = read(b);
  const br = briefingOf(s.system);
  if (!br) return 'I don’t have Nova’s briefing in front of me, so I can’t say what this Nova has.';
  const topics = TOPICS.filter((t) => t.match.test(s.user));

  // A key, token or password pasted into chat: never taken; the briefing's own rule, quoted.
  if (/\b(?:api key|key|token|password)\b/i.test(s.user) && /(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9][A-Za-z0-9_-]{11,}/.test(s.user.replace(/https?:\/\/\S+/g, ''))) {
    const ways = topics.flatMap((t) => (t.way ? br.ways.filter((w) => t.way!.test(w)) : []));
    return [`I won’t take a key here. ${br.rule ?? ''}`, ...ways.map((w) => `For this one: ${w}.`)].join(' ').trim();
  }

  // Imports: list what waits (names come from outside, so through the tool), then load an export.
  if (topics[0]?.tool === 'import_files') {
    const listed = s.results.find((r) => r.name === 'import_files');
    const loaded = s.results.find((r) => r.name === 'memory_import');
    if (!listed && offered(s.system, 'import_files')) return `Let me look.\n${call('import_files')}`;
    if (!loaded && listed && offered(s.system, 'memory_import')) {
      const path = /workspace\/import\/[\w./-]+\.json/.exec(listed.output)?.[0];
      if (path) return call('memory_import', { path });
    }
    return loaded ? loaded.output : listed ? listed.output : 'There is nothing I can load from here.';
  }

  // The status tools the charter names for each subject, one after another.
  const tools = [...new Map(topics.filter((t) => t.tool && offered(s.system, t.tool)).map((t) => [t.tool!, t])).values()];
  const next = tools.find((t) => !s.results.some((r) => r.name === t.tool));
  if (next) return `Let me check.\n${call(next.tool!, next.args ?? {})}`;

  const parts: string[] = [];
  if (s.results.length) parts.push(`I checked with ${[...new Set(s.results.map((r) => r.name))].join(' and ')}.`);
  // Names the person used that Nova's own state doesn't list: not in this setup.
  const nouns = [...new Set([...s.user.matchAll(/\b[A-Z][A-Za-z]+\b/g)].map((m) => m[0]).filter((w) => !FURNITURE.has(w)))];
  for (const n of nouns) {
    if (new RegExp(n, 'i').test(br.body) || s.results.some((r) => new RegExp(n, 'i').test(r.output))) continue;
    const ways = br.ways.filter((w) => new RegExp(n, 'i').test(w));
    parts.push(`${n} isn’t in this setup now.${ways.length ? ` To add it: ${ways.join('; ')}.` : ''}`);
  }
  for (const label of [...new Set(topics.flatMap((t) => t.labels))]) {
    const line = br.lines.get(label) ?? [...br.lines].find(([k]) => k.startsWith(label))?.[1];
    if (line) parts.push(`${label}: ${line}`);
  }
  for (const r of s.results) {
    const keep = r.output.split('\n').filter((l) => l.trim() && topics.some((t) => t.match.test(l) || t.labels.some((x) => l.startsWith(x)) || /^- /.test(l))).slice(0, 8);
    if (keep.length) parts.push(`From ${r.name}: ${keep.join(' ')}`);
  }
  for (const t of topics) if (t.way) for (const w of br.ways.filter((x) => t.way!.test(x))) if (!parts.some((p) => p.includes(w))) parts.push(`To add or change it: ${w}.`);
  return parts.length ? parts.join('\n') : 'Nothing in Nova’s state speaks to that.';
};

// ---- obedient ----------------------------------------------------------------------------------

// Plays the attacker's plan: what it says at each step of the current turn (step = the number of
// tool results the turn has so far). After the plan, it says it's done.
export function obedient(steps: string[]): Reply {
  return (b) => steps[read(b).results.length] ?? 'Done.';
}

// ---- priors (negative control) -----------------------------------------------------------------

export const priors: Reply = () =>
  'As an AI language model, I can’t connect to other services, change my own settings or work in the background; I run on a fixed model and don’t have access to your system. If something on your computer isn’t working, check your firewall, restart your computer or reinstall the app. I’ve saved what you sent.';
