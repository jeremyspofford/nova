// A fake of the CLIs the Network Setup assistant drives (tailscale, headscale, netbird, wg,
// wg-quick, ufw, apt-get), for tests only: `node fake-mesh.mjs <tool> <args...>`. It keeps a small
// world in `$NOVA_FAKE_MESH_DIR/state.json`, appends every call to `calls.jsonl` (argv, stdin and
// the secret-carrying environment variables, so tests can prove where a secret went), and prints
// output shaped like each CLI's documented JSON. Written from the CLIs' documented behavior; no
// text is copied from them.
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const dir = process.env.NOVA_FAKE_MESH_DIR;
if (!dir) {
  process.stderr.write('NOVA_FAKE_MESH_DIR is not set\n');
  process.exit(2);
}
const [tool, ...args] = process.argv.slice(2);
const statePath = join(dir, 'state.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));

let stdin;
try {
  stdin = readFileSync(0, 'utf8');
} catch {
  stdin = '';
}
const ENV = ['NB_SETUP_KEY', 'HEADSCALE_CLI_ADDRESS', 'HEADSCALE_CLI_API_KEY', 'DEBIAN_FRONTEND'];
appendFileSync(
  join(dir, 'calls.jsonl'),
  JSON.stringify({
    tool,
    args,
    stdin,
    env: Object.fromEntries(
      ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
    ),
  }) + '\n',
);

const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const out = (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
const fail = (text, code = 1) => {
  process.stderr.write(`${text}\n`);
  process.exit(code);
};
const flag = (name) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === name) return args[i + 1] ?? '';
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
};

const BIN = { 'wg-quick': 'wg' };
if (state.installed[BIN[tool] ?? tool] === false) fail(`${tool}: command not found`, 127);
const injected = state.fail?.[`${tool} ${args[0] ?? ''}`];
if (injected) fail(injected);

const ts = state.tailscale;
const hs = state.headscale;

function tailscalePrefs() {
  return {
    ControlURL: ts.controlUrl ?? 'https://controlplane.tailscale.com',
    RouteAll: false,
    ExitNodeID: '',
    CorpDNS: ts.acceptDns,
    WantRunning: ts.wantRunning,
    LoggedOut: ts.loggedOut,
    ShieldsUp: false,
    AdvertiseTags: ts.tags,
    Hostname: ts.hostname ?? '',
    AdvertiseRoutes: ts.routes,
  };
}

function hsNode() {
  return hs.nodes.find((n) => n.given_name === ts.hostname);
}

switch (tool) {
  case 'tailscale': {
    const sub = args[0];
    if (sub === 'version') out('1.76.1\n  tailscale commit: 0000000\n  go version: go1.23.1');
    else if (sub === 'status') {
      const running = ts.backendState === 'Running';
      out(
        JSON.stringify({
          Version: '1.76.1',
          BackendState: ts.backendState,
          TailscaleIPs: running ? ts.ips : null,
          Self: {
            ID: 'n1',
            HostName: ts.hostname ?? 'hub',
            DNSName: running && ts.dnsName ? `${ts.dnsName}.` : '',
            OS: 'linux',
            TailscaleIPs: running ? ts.ips : null,
            Online: running,
            ...(running && ts.tags.length ? { Tags: ts.tags } : {}),
          },
          MagicDNSSuffix: 'nova.mesh',
          Peer: Object.fromEntries(
            (running ? ts.peers : []).map((p, i) => [
              `nodekey:${i}`,
              {
                HostName: p.name,
                DNSName: `${p.name}.nova.mesh.`,
                TailscaleIPs: p.ips,
                Online: p.online,
                OS: p.os,
              },
            ]),
          ),
        }),
      );
    } else if (sub === 'debug' && args[1] === 'prefs')
      out(JSON.stringify(tailscalePrefs(), null, 2));
    else if (sub === 'up') {
      const keyArg = flag('--auth-key') ?? '';
      const key =
        keyArg === 'file:/dev/stdin'
          ? stdin.trim()
          : keyArg.startsWith('file:')
            ? readFileSync(keyArg.slice(5), 'utf8').trim()
            : keyArg;
      const loginServer = flag('--login-server') ?? null;
      const hsKey = hs.keys.find((k) => k.key === key && !k.used);
      if (!(state.tailscaleAuthKeys ?? []).includes(key) && !hsKey)
        fail('backend error: invalid key: unable to validate API key');
      if (hsKey) hsKey.used = true;
      ts.hostname = flag('--hostname') ?? 'hub';
      ts.controlUrl = loginServer;
      ts.tags = (flag('--advertise-tags') ?? '').split(',').filter(Boolean);
      ts.acceptDns = (flag('--accept-dns') ?? 'true') === 'true';
      ts.backendState = state.joinState ?? 'Running';
      ts.loggedOut = false;
      ts.wantRunning = true;
      ts.ips = ['100.64.0.5', 'fd7a:115c:a1e0::5'];
      ts.dnsName = `${ts.hostname}.nova.mesh`;
      if (hsKey && !hsNode()) {
        hs.nodes.push({
          id: String(hs.nextNodeId++),
          name: ts.hostname,
          given_name: ts.hostname,
          ip_addresses: ['100.64.0.5'],
          online: true,
          user: { id: hsKey.user, name: hs.users.find((u) => u.id === hsKey.user)?.name ?? '' },
          forced_tags: [],
          valid_tags: ts.tags,
          approved_routes: [],
          available_routes: [],
        });
      }
      save();
    } else if (sub === 'set') {
      for (const a of args.slice(1)) {
        const [k, v = ''] = a.split('=');
        if (k === '--accept-dns') ts.acceptDns = v === 'true';
        else if (k === '--advertise-routes') {
          const exit = ['0.0.0.0/0', '::/0'].filter((r) => ts.routes.includes(r));
          ts.routes = [...v.split(',').filter(Boolean), ...exit];
        } else if (k === '--advertise-exit-node') {
          const plain = ts.routes.filter((r) => r !== '0.0.0.0/0' && r !== '::/0');
          ts.routes = v === 'true' ? [...plain, '0.0.0.0/0', '::/0'] : plain;
        } else fail(`flag provided but not defined: ${k}`, 2);
      }
      save();
    } else if (sub === 'logout') {
      Object.assign(ts, {
        backendState: 'NeedsLogin',
        loggedOut: true,
        wantRunning: false,
        ips: [],
        dnsName: null,
        tags: [],
      });
      hs.nodes = hs.nodes.filter((n) => n.given_name !== ts.hostname);
      save();
    } else if (sub === 'down') {
      Object.assign(ts, { backendState: 'Stopped', wantRunning: false });
      save();
    } else if (sub === 'cert') {
      if (!state.cert)
        fail(
          '500 Internal Server Error: your Tailscale account does not support getting TLS certs',
        );
      out(state.cert.certPem + state.cert.keyPem);
    } else fail(`unknown subcommand: ${sub}`, 2);
    break;
  }
  case 'headscale': {
    if (
      hs.apiKey &&
      process.env.HEADSCALE_CLI_ADDRESS &&
      process.env.HEADSCALE_CLI_API_KEY !== hs.apiKey
    )
      fail('rpc error: code = Unauthenticated desc = invalid token');
    const [noun, verb] = args;
    if (noun === 'version') out(JSON.stringify({ version: 'v0.26.1' }));
    else if (noun === 'users' && verb === 'list') out(JSON.stringify(hs.users));
    else if (noun === 'users' && verb === 'create') {
      const name = args[2];
      if (hs.users.some((u) => u.name === name)) fail('user already exists');
      hs.users.push({ id: String(hs.nextUserId++), name });
      save();
      out(`User created`);
    } else if (noun === 'users' && verb === 'destroy') {
      const name = flag('--name');
      hs.users = hs.users.filter((u) => u.name !== name);
      save();
    } else if (noun === 'nodes' && verb === 'list') out(JSON.stringify(hs.nodes));
    else if (noun === 'nodes' && verb === 'approve-routes') {
      const node = hs.nodes.find((n) => n.id === flag('--identifier'));
      if (!node) fail('node not found');
      node.approved_routes = (flag('--routes') ?? '').split(',').filter(Boolean);
      save();
    } else if (noun === 'policy' && verb === 'get') {
      if (hs.policyMode === 'file') fail('policy is in file mode');
      if (hs.policy === null) fail('acl policy not found');
      out(hs.policy);
    } else if (noun === 'policy' && verb === 'set') {
      if (hs.policyMode === 'file') fail('policy is in file mode');
      const text = readFileSync(flag('--file'), 'utf8');
      try {
        JSON.parse(text.replace(/\/\/.*$/gm, ''));
      } catch {
        fail('parsing policy: invalid JSON');
      }
      hs.policy = text;
      save();
    } else if (noun === 'preauthkeys' && verb === 'create') {
      const user = flag('--user');
      if (!hs.users.some((u) => u.id === user)) fail('user not found');
      const key = `hskey-${randomBytes(12).toString('hex')}`;
      hs.keys.push({
        key,
        user,
        used: false,
        tags: (flag('--tags') ?? '').split(',').filter(Boolean),
      });
      save();
      out(
        JSON.stringify({
          id: String(hs.keys.length),
          key,
          user: { id: user },
          reusable: false,
          ephemeral: false,
          used: false,
          acl_tags: (flag('--tags') ?? '').split(',').filter(Boolean),
        }),
      );
    } else fail(`unknown command ${noun} ${verb}`, 2);
    break;
  }
  case 'netbird': {
    const nb = state.netbird;
    const sub = args[0];
    if (sub === 'version') out('0.36.5');
    else if (sub === 'status') {
      if (!nb.connected) fail('Daemon status: NeedsLogin\n\nRun UP command to log in with SSO');
      out(
        JSON.stringify({
          peers: {
            total: 1,
            connected: 1,
            details: [
              { fqdn: 'laptop.netbird.cloud', netbirdIp: '100.92.0.2', status: 'Connected' },
            ],
          },
          cliVersion: '0.36.5',
          daemonVersion: '0.36.5',
          management: { url: nb.managementUrl, connected: true, error: '' },
          signal: { url: 'https://signal.netbird.io:443', connected: true, error: '' },
          netbirdIp: '100.92.0.1/16',
          publicKey: 'pub',
          usesKernelInterface: true,
          fqdn: `${nb.hostname}.netbird.cloud`,
        }),
      );
    } else if (sub === 'up') {
      if (!(nb.setupKeys ?? []).includes(process.env.NB_SETUP_KEY))
        fail('login failed: invalid setup key');
      Object.assign(nb, {
        connected: true,
        managementUrl: flag('--management-url'),
        hostname: flag('--hostname'),
      });
      save();
      out('Connected');
    } else if (sub === 'down') {
      nb.connected = false;
      save();
      out('Disconnected');
    } else fail(`unknown command ${sub}`, 2);
    break;
  }
  case 'wg': {
    if (args[0] === '--version') out('wireguard-tools v1.0.20210914 - https://example.invalid/');
    else if (args[0] === 'show' && args[1] === 'interfaces') out(state.wg.interfaces.join(' '));
    else if (args[0] === 'show') {
      if (!state.wg.interfaces.includes(args[1]))
        fail(`Unable to access interface: No such device`);
      out(`interface: ${args[1]}`);
    } else fail('usage', 2);
    break;
  }
  case 'wg-quick': {
    const [verb, path] = args;
    const iface = basename(path).replace(/\.conf$/, '');
    if (verb === 'up') {
      const text = readFileSync(path, 'utf8');
      if (!/^PrivateKey = \S+$/m.test(text)) fail('no private key');
      if (state.wg.interfaces.includes(iface)) fail(`wg-quick: \`${iface}' already exists`);
      state.wg.interfaces.push(iface);
      state.wg.lastConfig = text.replace(/^PrivateKey = .*$/m, 'PrivateKey = (hidden)');
    } else if (verb === 'down') {
      if (!state.wg.interfaces.includes(iface))
        fail(`wg-quick: \`${iface}' is not a WireGuard interface`);
      state.wg.interfaces = state.wg.interfaces.filter((i) => i !== iface);
    }
    save();
    break;
  }
  case 'ufw': {
    const sub = args[0];
    if (sub === 'version') out('ufw 0.36.2');
    else if (sub === 'status') out(`Status: ${state.ufw.active ? 'active' : 'inactive'}`);
    else if (sub === 'show' && args[1] === 'added') {
      out(
        [
          "Added user rules (see 'ufw status' for running firewall):",
          ...state.ufw.added.map((r) => `ufw ${r}`),
        ].join('\n'),
      );
    } else if (sub === 'allow') {
      state.ufw.added.push(args.map((a) => (a.includes(' ') ? `'${a}'` : a)).join(' '));
      save();
      out('Rule added');
    } else if (sub === 'delete') {
      const spec = args.slice(1).join(' ');
      const before = state.ufw.added.length;
      state.ufw.added = state.ufw.added.filter((r) => !r.startsWith(spec));
      if (state.ufw.added.length === before) fail('Could not delete non-existent rule');
      save();
      out('Rule deleted');
    } else fail(`unknown command ${sub}`, 2);
    break;
  }
  case 'apt-get': {
    const [verb] = args;
    const pkg = args.at(-1);
    const tools =
      { tailscale: ['tailscale'], netbird: ['netbird'], 'wireguard-tools': ['wg', 'wg-quick'] }[
        pkg
      ] ?? [];
    if (!tools.length) fail(`E: Unable to locate package ${pkg}`, 100);
    for (const t of tools) state.installed[t] = verb === 'install';
    save();
    out(`${verb === 'install' ? 'Setting up' : 'Removing'} ${pkg} ...`);
    break;
  }
  default:
    fail(`${tool}: command not found`, 127);
}
