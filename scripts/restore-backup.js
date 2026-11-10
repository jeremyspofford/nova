// Restores a nightly backup, or opens an encrypted copy with its recovery key, into a new home
// (docs/restore.md). Nova never restores over a home: the new home is a folder that isn't there yet,
// or an empty one.
//   node scripts/restore-backup.js <backup folder or .nbk file> [new home] [--keep-from <old home>]
// The new home defaults to NOVA_HOME (or ~/Nova). An encrypted copy asks for its recovery key on
// the terminal, or reads it from standard input; never from the command line, where other programs
// and the shell's history can see it. --keep-from names the home this one replaces, if it is still
// there: its forgets, revoked devices, keys and vault are kept as they are now.
import { loadConfig } from '../src/config.js';
import { loadMigrations, restoreFromBackup } from '../src/core/index.ts';
import { runningPid } from '../src/home.js';
import { existsSync, statSync } from 'node:fs';

const args = process.argv.slice(2);
const at = args.indexOf('--keep-from');
const keepFrom = at >= 0 ? args[at + 1] : null;
const plain = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
if (!plain[0] || (at >= 0 && !keepFrom) || plain.length > 2) {
  console.error('Usage: node scripts/restore-backup.js <backup folder or .nbk file> [new home] [--keep-from <old home>]. See docs/restore.md.');
  process.exit(2);
}
const from = plain[0];
const into = plain[1] ?? loadConfig().home;

for (const home of [into, keepFrom].filter(Boolean)) {
  const pid = runningPid(home);
  if (pid) {
    console.error(`Nova is running ${home} (pid ${pid}). Stop it first, then run this again. Nothing was changed.`);
    process.exit(1);
  }
}

let recoveryKey;
if (existsSync(from) && statSync(from).isFile()) {
  recoveryKey = await readKey();
  if (!recoveryKey) {
    console.error('An encrypted copy opens with its recovery key. Nothing was changed.');
    process.exit(1);
  }
}

try {
  const r = restoreFromBackup({ from, into, keepFrom, recoveryKey, migrations: loadMigrations() });
  for (const line of r.said) console.log(line);
  console.log(`Start Nova on it with: NOVA_HOME=${r.home} npm start`);
} catch (e) {
  console.error(`Nothing was restored: ${e.message}`);
  process.exit(1);
}

// The recovery key: typed at the terminal without echo, or piped in.
async function readKey() {
  if (!process.stdin.isTTY) {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return text.trim();
  }
  process.stderr.write('Recovery key (it isn’t shown as you type): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((done) => {
    let key = '';
    const finish = (value) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', on);
      process.stderr.write('\n');
      done(value);
    };
    const on = (s) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') return finish(key.trim());
        if (ch === '\u0003') { finish(''); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') key = key.slice(0, -1);
        else key += ch;
      }
    };
    process.stdin.on('data', on);
  });
}
