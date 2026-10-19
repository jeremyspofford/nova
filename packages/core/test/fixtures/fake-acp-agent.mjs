// A fake external coding agent speaking the Agent Client Protocol on stdio (FR-203 tests). The
// prompt's first word picks what it does:
//   edit <path> <text>   ask permission (edit), then write the file through Nova
//   rogue <path>         write through Nova without asking first
//   read <path>          read a file through Nova and reply with it
//   fetch <url>          ask permission (fetch) and reply with the answer
//   think                ask permission (think)
//   run <command>        ask permission (execute), run it in a Nova terminal, reply with output
//   hang                 wait for session/cancel
//   crash                exit at once
//   always               offer only allow_always and reject options
// FAKE_ACP_VERSION sets the protocol version it answers with.
import { createInterface } from 'node:readline';

let next = 1000;
const waiting = new Map();
let session = null;
let hang = null;

function send(msg) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
}
function request(method, params) {
  const id = next++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}
function say(text) {
  send({
    method: 'session/update',
    params: {
      sessionId: session,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  });
}
function options(onlyAlways) {
  return onlyAlways
    ? [
        { optionId: 'always', name: 'Always', kind: 'allow_always' },
        { optionId: 'no', name: 'No', kind: 'reject_once' },
      ]
    : [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Always', kind: 'allow_always' },
        { optionId: 'no', name: 'No', kind: 'reject_once' },
      ];
}
async function ask(kind, title, extra = {}, onlyAlways = false) {
  const r = await request('session/request_permission', {
    sessionId: session,
    toolCall: { toolCallId: `t${next}`, title, kind, status: 'pending', ...extra },
    options: options(onlyAlways),
  });
  return r.result?.outcome;
}

async function prompt(text) {
  const [verb, ...rest] = text.split(' ');
  switch (verb) {
    case 'edit': {
      const [path, ...words] = rest;
      send({
        method: 'session/update',
        params: {
          sessionId: session,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'e1',
            title: `Edit ${path}`,
            kind: 'edit',
            status: 'pending',
          },
        },
      });
      const outcome = await ask('edit', `Edit ${path}`, { locations: [{ path }] });
      if (outcome?.optionId !== 'yes') {
        say(`rejected ${outcome?.optionId ?? outcome?.outcome}`);
        return 'end_turn';
      }
      const w = await request('fs/write_text_file', {
        sessionId: session,
        path,
        content: words.join(' '),
      });
      say(w.error ? `write failed: ${w.error.message}` : 'wrote it');
      return 'end_turn';
    }
    case 'rogue': {
      const w = await request('fs/write_text_file', {
        sessionId: session,
        path: rest[0],
        content: 'rogue',
      });
      say(w.error ? `write failed: ${w.error.message}` : 'wrote it');
      return 'end_turn';
    }
    case 'read': {
      const r = await request('fs/read_text_file', {
        sessionId: session,
        path: rest[0],
        line: rest[1] ? Number(rest[1]) : undefined,
        limit: rest[2] ? Number(rest[2]) : undefined,
      });
      say(r.error ? `read failed: ${r.error.message}` : `content: ${r.result.content}`);
      return 'end_turn';
    }
    case 'fetch': {
      const outcome = await ask('fetch', `Fetch ${rest[0]}`, { rawInput: { url: rest[0] } });
      say(`fetch ${outcome?.optionId ?? outcome?.outcome}`);
      return 'end_turn';
    }
    case 'think': {
      const outcome = await ask('think', 'Think');
      say(`think ${outcome?.optionId ?? outcome?.outcome}`);
      return 'end_turn';
    }
    case 'always': {
      const outcome = await ask('fetch', 'Fetch', {}, true);
      say(`always ${outcome?.optionId ?? outcome?.outcome}`);
      return 'end_turn';
    }
    case 'run': {
      const command = rest.join(' ');
      const outcome = await ask('execute', `Run ${command}`, { rawInput: { command } });
      if (outcome?.optionId !== 'yes') {
        say('run rejected');
        return 'end_turn';
      }
      const t = await request('terminal/create', {
        sessionId: session,
        command: 'sh',
        args: ['-c', command],
        outputByteLimit: 1000,
      });
      if (t.error) {
        say(`run failed: ${t.error.message}`);
        return 'end_turn';
      }
      const id = t.result.terminalId;
      const exit = await request('terminal/wait_for_exit', { sessionId: session, terminalId: id });
      const out = await request('terminal/output', { sessionId: session, terminalId: id });
      await request('terminal/release', { sessionId: session, terminalId: id });
      say(`exit ${exit.result.exitCode}: ${out.result.output}`);
      return 'end_turn';
    }
    case 'hang':
      return await new Promise((resolve) => (hang = resolve));
    case 'crash':
      process.exit(3);
      break;
    default:
      say(`unknown ${verb}`);
      return 'end_turn';
  }
}

process.stdout.write('this line is not a protocol message\n');
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && waiting.has(msg.id) && msg.method === undefined) {
    const resolve = waiting.get(msg.id);
    waiting.delete(msg.id);
    resolve(msg);
    return;
  }
  switch (msg.method) {
    case 'initialize':
      send({
        id: msg.id,
        result: {
          protocolVersion: Number(process.env.FAKE_ACP_VERSION ?? 1),
          agentCapabilities: { loadSession: false },
          authMethods: [],
          agentInfo: { name: 'fake-agent', version: '1.0.0' },
          seenCapabilities: msg.params.clientCapabilities,
        },
      });
      break;
    case 'session/new':
      session = 'sess-1';
      send({ id: msg.id, result: { sessionId: session, cwdSeen: msg.params.cwd } });
      break;
    case 'session/prompt':
      void prompt(msg.params.prompt.map((p) => p.text).join('')).then((stopReason) =>
        send({ id: msg.id, result: { stopReason } }),
      );
      break;
    case 'session/cancel':
      hang?.('cancelled');
      break;
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'no' } });
  }
});
rl.on('close', () => process.exit(0));
