// Streaming, in the order the page needs it (review of PR #234, must-fix 2). The page keeps a reply's
// live text from two events: `live` (the phase, and the text so far) and `delta` (one new piece). If
// the server says "streaming" after sending a piece, with the text from before it, the page loses that
// piece; if it kept the longer text instead, whatever a step streamed before its tool call (blank
// lines, a ```xml fence) would stay on screen into the next step. So the server sends `live` first,
// then the piece; a step's end resets the text; and the page simply follows the events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { call, startNova } from './ingest/support.js';

// A model that streams in pieces. Step 0: something visible before a tool call (a fence, or only
// blank lines), then the call. Step 1: the answer, in pieces.
function model(before) {
  return async ({ prompt, onText }) => {
    const convo = prompt.slice(prompt.lastIndexOf('<conversation>'), prompt.lastIndexOf('</conversation>'));
    const step = (convo.slice(Math.max(convo.lastIndexOf('<user'), 0)).match(/<tool_result /g) ?? []).length;
    const pieces = step === 0 ? [...before, call('read_file', { path: 'USER.md' })] : ['The peas ', 'go in ', 'first.'];
    for (const p of pieces) { onText(p); await new Promise((r) => setTimeout(r, 5)); }
    return { text: pieces.join(''), aborted: false };
  };
}

// The page's own rule (ui/js/app.js), applied to the events as they arrive.
function page(events) {
  let live = null;
  const seen = [];
  for (const [type, d] of events) {
    if (type === 'live') live = d && { ...d };
    if (type === 'delta' && live && live.turn === d.turn && live.attempt === d.attempt) { live.text = (live.text || '') + d.text; if (live.phase !== 'streaming') live.phase = 'streaming'; }
    seen.push(live ? { phase: live.phase, text: live.text ?? '' } : null);
  }
  return seen;
}

for (const [what, before] of [['a ```xml fence', ['Let me look.\n\n', '```xml\n']], ['only blank lines', ['\n', '\n\n']]]) {
  test(`streaming: ${what} before a tool call doesn’t stay on screen, and no piece is lost`, async () => {
    const h = await startNova({ agent: model(before) });
    const events = [];
    h.nova.runner.on('live', (_, d) => events.push(['live', d]));
    h.nova.runner.on('delta', (_, d) => events.push(['delta', d]));
    try {
      await h.run('What goes in first?');
      const seen = page(events);
      // While step 0 streams, the page shows exactly what the model has sent so far.
      const shown = seen.filter((x) => x?.phase === 'streaming').map((x) => x.text);
      assert.ok(shown.includes(before.join('')), `the first step's words, whole: ${JSON.stringify(shown)}`);
      // Once the step turns to its tool, nothing of it is left: no fence, no blank lines.
      const at = seen.findIndex((x) => x && x.phase === 'tool');
      assert.ok(at > 0, 'the step went to its tool');
      for (const x of seen.slice(at)) if (x && x.phase !== 'streaming') assert.equal(x.text, '', `after the tool call, ${x.phase} shows no stale text`);
      // The next step starts clean (Thinking) and its answer arrives piece by piece, nothing lost.
      const second = seen.slice(at).filter((x) => x?.phase === 'streaming' && x.text).map((x) => x.text);
      assert.deepEqual(second, ['The peas ', 'The peas go in ', 'The peas go in first.']);
      assert.ok(seen.slice(at).some((x) => x?.phase === 'thinking' && x.text === ''), 'Thinking shows between the steps');
    } finally { await h.close(); }
  });
}

test('the page follows the events and keeps no text of its own', () => {
  const app = readFileSync('ui/js/app.js', 'utf8');
  const handler = app.slice(app.indexOf("es.addEventListener('live'"), app.indexOf("es.addEventListener('delta'"));
  assert.doesNotMatch(handler, /length\s*</, 'no “keep the longer text” workaround');
});
