// The sample plugin's tool.pre hook (docs/08 §4.1, docs/18 J4). Nova sends the event as JSON on
// stdin; this hook blocks a fetch_status call whose URL is not on the plugin's declared host, and
// otherwise answers nothing (no opinion). A hook can only tighten: it never allows anything.
// Plain Node, no dependencies.
import { stdin, stdout } from 'node:process';

const ALLOWED_HOSTS = ['api.example.com'];

let input = '';
stdin.setEncoding('utf8');
for await (const chunk of stdin) input += chunk;

let event = {};
try {
  event = JSON.parse(input || '{}');
} catch {
  // Unreadable input: no opinion.
}

const tool = event.tool?.name ?? event.toolName ?? event.tool ?? '';
const args = event.args ?? event.arguments ?? event.tool?.args ?? {};
if (typeof tool === 'string' && tool.endsWith('fetch_status') && typeof args.url === 'string') {
  let host;
  try {
    host = new URL(args.url).hostname;
  } catch {
    host = '';
  }
  if (!ALLOWED_HOSTS.includes(host)) {
    stdout.write(
      JSON.stringify({
        block: {
          reason: `The sample plugin may only reach ${ALLOWED_HOSTS.join(', ')}, not ${host || 'that URL'}.`,
        },
      }),
    );
  }
}
