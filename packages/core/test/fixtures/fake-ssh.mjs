// A stand-in for the OpenSSH client in tests (code-m7-ssh): it reads the options Nova passes,
// checks the host key against the known_hosts file the way StrictHostKeyChecking does, checks the
// key file or the password (asking SSH_ASKPASS), then runs the remote command with sh in a fake
// remote home on this machine. FAKE_SSH_* variables configure the "host".
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';

const args = process.argv.slice(2);
const opts = {};
let host = null;
let control = null;
let hostNext = false;
const remote = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (host === null) {
    if (a === '-o') {
      const [k, ...v] = args[++i].split('=');
      opts[k] = v.join('=').replace(/^"(.*)"$/, '$1');
    } else if (a === '-F' || a === '-p' || a === '-l') opts[a] = args[++i];
    else if (a === '-O') control = args[++i];
    else if (a === '--') hostNext = true;
    else if (a.startsWith('-') && !hostNext) {
      // Like the real client: an unknown option is an error, never a host.
      process.stderr.write(`ssh: unknown option ${a}\n`);
      process.exit(255);
    } else host = a;
    continue;
  }
  remote.push(a);
}
const env = process.env;
if (env.FAKE_SSH_LOG)
  appendFileSync(
    env.FAKE_SSH_LOG,
    `${JSON.stringify({
      host,
      dashedHost: hostNext,
      control,
      user: opts['-l'],
      port: opts['-p'],
      config: opts['-F'],
      strict: opts.StrictHostKeyChecking,
      identity: opts.IdentityFile ?? null,
      identityMode: opts.IdentityFile
        ? (statSync(opts.IdentityFile).mode & 0o777).toString(8)
        : null,
      agent: env.SSH_AUTH_SOCK ?? null,
      remote: remote.join(' ').slice(0, 160),
      at: Date.now(),
    })}\n`,
  );
if (control) process.exit(0);
if (env.FAKE_SSH_DOWN === '1') {
  process.stderr.write(`ssh: connect to host ${host} port ${opts['-p']}: Connection refused\n`);
  process.exit(255);
}
const alias = opts.HostKeyAlias ?? host;
const knownHosts = opts.UserKnownHostsFile;
const key = env.FAKE_SSH_HOST_KEY;
const lines = existsSync(knownHosts) ? readFileSync(knownHosts, 'utf8').split('\n') : [];
const known = lines.find((l) => l.startsWith(`${alias} `));
if (known) {
  if (known.slice(alias.length + 1).trim() !== key) {
    process.stderr.write(
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n' +
        '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n' +
        'Host key verification failed.\n',
    );
    process.exit(255);
  }
} else if (opts.StrictHostKeyChecking === 'accept-new') {
  appendFileSync(knownHosts, `${alias} ${key}\n`);
} else {
  process.stderr.write(`No host key is known for ${host}.\nHost key verification failed.\n`);
  process.exit(255);
}
let allowed;
if (opts.IdentityFile) {
  allowed = readFileSync(opts.IdentityFile, 'utf8').trim() === env.FAKE_SSH_ACCEPT_KEY;
} else {
  const r = spawnSync(env.SSH_ASKPASS, [`${opts['-l']}@${host}'s password: `], {
    encoding: 'utf8',
  });
  allowed = r.stdout.replace(/\n$/, '') === env.FAKE_SSH_PASSWORD;
}
if (!allowed) {
  process.stderr.write(`${opts['-l']}@${host}: Permission denied (publickey,password).\n`);
  process.exit(255);
}
const child = spawn('sh', ['-c', remote.join(' ')], {
  cwd: env.FAKE_SSH_HOME,
  env: { PATH: env.PATH, HOME: env.FAKE_SSH_HOME, LANG: 'C' },
  stdio: ['pipe', 'inherit', 'inherit'],
});
process.stdin.pipe(child.stdin);
child.on('close', (code) => process.exit(code ?? 255));
