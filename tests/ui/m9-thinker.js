#!/usr/bin/env node
// A stand-in model for the M9 progress test: it reads the prompt, thinks for THINK_MS without a
// word (a real silence, so the page's Thinking line and its 10 s words can be seen), then writes
// its reply in a few pieces with real gaps between them, as a model streams.
const think = Number(process.env.THINK_MS ?? 2500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.stdin.setEncoding('utf8');
for await (const _ of process.stdin) { /* the prompt */ }
await sleep(think);
for (const piece of ['Here is ', 'what I ', 'found: ', 'the peas ', 'go first.']) {
  process.stdout.write(piece);
  await sleep(150);
}
