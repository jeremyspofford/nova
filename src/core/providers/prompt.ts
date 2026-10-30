// What a provider is told about a brief. A coding agent works in the task's folder with its own
// tools; a chat provider can't touch files, so it gets the files' text and answers with the
// strict JSON files contract, which Nova applies itself.
import { CoreError } from '../errors.ts';
import type { Brief } from '../envelope.ts';

const testLine = (brief: Brief) => {
  const cmd = typeof brief.inputs?.test_command === 'string' ? brief.inputs.test_command : '';
  return cmd ? `When you finish, Nova runs \`${cmd}\` itself in this folder to check the work; it has to pass.` : '';
};

const constraintLines = (brief: Brief) => [
  brief.constraints.deadline ? `Deadline: ${brief.constraints.deadline}.` : '',
  brief.constraints.allowed_tools?.length ? `Use only these tools: ${brief.constraints.allowed_tools.join(', ')}.` : '',
].filter(Boolean);

// `may`: what the provider may change, in words (taskspace.ts scopeOf).
export function agentPrompt(brief: Brief, files: string[], may = ''): string {
  return [
    brief.goal.trim(),
    '',
    'You are working in a folder made for this task alone. Change files only inside it.',
    files.length ? `Files copied in for you: ${files.slice(0, 50).join(', ')}${files.length > 50 ? `, and ${files.length - 50} more` : ''}.` : 'The folder starts empty.',
    may,
    testLine(brief),
    ...constraintLines(brief),
    'When you are done, say in one or two plain sentences what you changed.',
  ].filter((l) => l !== null).join('\n').trim();
}

export const CONTRACT_SYSTEM = [
  'You do a task by changing files. You cannot run anything; you answer once.',
  'Reply with one JSON object and nothing else, in exactly this shape:',
  '{"files": [{"path": "relative/path.ext", "content": "the whole new content of the file"}], "notes": "one or two sentences on what you changed"}',
  'Rules: paths are relative to the task folder, use forward slashes, never start with / and never contain "..".',
  'Give the complete content of every file you change or add. Leave out files you do not change. No Markdown fences.',
].join('\n');

export function contractPrompt(brief: Brief, files: { path: string; text: string }[], may = ''): string {
  return [
    `Task: ${brief.goal.trim()}`,
    may,
    testLine(brief),
    ...constraintLines(brief),
    files.length ? 'The files in the task folder:' : 'The task folder is empty.',
    ...files.map((f) => `<file path="${f.path}">\n${f.text}\n</file>`),
  ].filter(Boolean).join('\n\n');
}

export interface ContractReply { files: unknown[]; notes: string }

// The reply, read strictly: one JSON object with a files list. A Markdown fence around it is
// forgiven (small models add one); anything else is refused with the reason.
export function parseContract(text: string): ContractReply {
  let t = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  let v: unknown;
  try { v = JSON.parse(t); } catch { throw new CoreError('validation', `The reply isn't the JSON Nova asked for: ${t.slice(0, 120) || '(empty)'}`); }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new CoreError('validation', 'The reply must be one JSON object with "files" and "notes".');
  const r = v as Record<string, unknown>;
  if (!Array.isArray(r.files)) throw new CoreError('validation', 'The reply has no "files" list.');
  return { files: r.files, notes: typeof r.notes === 'string' ? r.notes.trim() : '' };
}

// A provider's last words as a short summary for a person.
export function summarize(text: string, fallback: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return fallback;
  return t.length > 280 ? `${t.slice(0, 278).replace(/\s+\S*$/, '')}…` : t;
}
