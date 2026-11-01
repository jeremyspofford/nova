// What the hub hands a computer that joins by command (M4 plan §2): the installer script
// (`GET /join.sh`), the device agent itself as a tar (`GET /device-agent.tar`), and the runtime
// agent as a signed bundle (`GET /api/v1/mesh/runtime`). All are built here, in-process, from the
// files in this repository, so what a device runs is exactly what this hub runs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeManifest, runtimeManifestMessage, type RuntimeManifest } from './wire.ts';

// src/, which holds src/device and src/core/mesh/wire.ts.
export const SRC_DIR = fileURLToPath(new URL('../../', import.meta.url));
const DEVICE_DIR = join(SRC_DIR, 'device');
// The runtime agent's files. The boot agent installs them into <device home>/runtime.
export const RUNTIME_FILES = ['runtime.ts', 'queue.ts', 'rollout.ts'] as const;

// ---- tar ---------------------------------------------------------------------------------------

// A ustar archive, written by hand so the hub needs no dependency: a 512-byte header per entry,
// the contents padded to 512 bytes, and two empty blocks at the end. Paths are relative and at
// most 100 bytes (ours are short), so the name field alone carries them.
export interface TarEntry { path: string; body?: Uint8Array; mode?: number; mtime?: number }

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

function header(path: string, size: number, mode: number, mtime: number, type: '0' | '5'): Buffer {
  if (Buffer.byteLength(path) > 100 || path.startsWith('/') || path.split('/').includes('..')) throw new Error(`tar: unusable path ${path}`);
  const h = Buffer.alloc(512);
  h.write(path, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii'); // uid
  h.write(octal(0, 8), 116, 8, 'ascii'); // gid
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(mtime, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii'); // the checksum counts its own field as spaces
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

export function tar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  const dirs = new Set<string>();
  for (const e of entries) {
    const mtime = Math.floor(e.mtime ?? 0);
    // Each folder once, before what it holds, so every tar makes them with sane modes.
    const segs = e.path.split('/');
    for (let i = 1; i < segs.length; i++) {
      const d = `${segs.slice(0, i).join('/')}/`;
      if (dirs.has(d)) continue;
      dirs.add(d);
      parts.push(header(d, 0, 0o755, mtime, '5'));
    }
    const body = Buffer.from(e.body ?? new Uint8Array());
    parts.push(header(e.path, body.length, e.mode ?? 0o644, mtime, '0'), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// ---- the device agent --------------------------------------------------------------------------

function deviceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  };
  walk(DEVICE_DIR);
  return out;
}

// Every file the agent carries, by its path inside the archive: src/device/**, the two core files
// it imports (src/core/mesh/wire.ts, which imports only node:crypto, and src/core/models/hardware.ts,
// which imports only Node's built-ins), and a package.json that makes the folder an ES module
// package of its own.
export function agentFiles(version: string): TarEntry[] {
  const files = [...deviceFiles(), join(SRC_DIR, 'core', 'mesh', 'wire.ts'), join(SRC_DIR, 'core', 'models', 'hardware.ts')];
  const entries: TarEntry[] = files.map((p) => ({ path: relative(join(SRC_DIR, '..'), p).split(sep).join('/'), body: readFileSync(p), mtime: statSync(p).mtimeMs / 1000 }));
  const pkg = { name: 'nova-device-agent', version, private: true, type: 'module', license: 'AGPL-3.0-only', engines: { node: '>=26' } };
  entries.unshift({ path: 'package.json', body: Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`), mtime: Date.now() / 1000 });
  return entries;
}

export function agentTar(version: string): Buffer {
  return tar(agentFiles(version));
}

// The runtime agent as a bundle: its files, a manifest of their hashes and a version, signed with
// this node's identity key. The version carries the hash, so a device knows a change by it.
export interface RuntimeBundle { manifest: RuntimeManifest; signature: string; signer: string; files: Record<string, string> }

export function runtimeBundle(novaVersion: string, sign: (message: Uint8Array) => string, signer: string, signed: { epoch: number; issued_at: string }): RuntimeBundle {
  const raw: Record<string, Buffer> = {};
  for (const f of RUNTIME_FILES) raw[f] = readFileSync(join(DEVICE_DIR, f));
  const draft = runtimeManifest('', raw);
  const manifest = { ...draft, version: `${novaVersion}+${draft.sha256.slice(0, 12)}`, epoch: signed.epoch, issued_at: signed.issued_at };
  return {
    manifest, signature: sign(runtimeManifestMessage(manifest)), signer,
    files: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.toString('base64')])),
  };
}

// ---- the installer -------------------------------------------------------------------------------

// The one-line command's script: `curl -fsS <hub>/join.sh | sh -s -- <code> [--name …]`. POSIX sh,
// nothing installed system-wide: the agent goes to <device home>/agent and its keys to
// <device home>/boot. TLS trust is the system's, or NOVA_CA_FILE's.
//
// Trust on first use: the script and the archive come from whatever answers at the hub's address,
// and the script names the archive's SHA-256, so the two must at least agree (a damaged or swapped
// download is refused). Nothing outside that channel vouches for them: the command is only as
// safe as the address it fetches from (HTTPS with a certificate the computer trusts, or a network
// the person controls). The six digits, compared on both screens, then prove which hub the agent
// joined, but by then the agent has already run.
export function joinScript(hubUrl: string | null, tarSha256: string | null = null): string {
  if (!hubUrl) {
    return `#!/bin/sh
echo "This Nova has no address other devices can reach, so nothing can join it yet. Start it with a mesh address (NOVA_MESH_URL); its README says how." >&2
exit 1
`;
  }
  const hub = hubUrl.replace(/'/g, '');
  const sha = /^[0-9a-f]{64}$/.test(tarSha256 ?? '') ? tarSha256! : '';
  return `#!/bin/sh
# Adds this computer to Nova at ${hub}.
#   curl -fsS ${hub}/join.sh | sh -s -- <code> [--name <name>] [--kind computer|standby] [--roles compute,storage] [--nova-home <dir>]
# What it does: checks for Node.js 26 or newer, downloads Nova's device agent from the same hub,
# unpacks it into the device home (NOVA_DEVICE_HOME, or ~/.nova-device), asks to join with the code,
# and once you approve on the hub, starts the agent in the background. It installs nothing outside
# the device home. Set NOVA_CA_FILE to trust a hub whose certificate the system doesn't know, and
# NOVA_JOIN_NO_RUN=1 to start the agent yourself. It checks the agent it downloads against the
# SHA-256 below; both come from the same hub, so run this only where ${hub} can only be your Nova.
set -eu
HUB='${hub}'
AGENT_SHA256='${sha}'
if [ "$#" -lt 1 ] || [ -z "$1" ]; then
  echo "Usage: curl -fsS $HUB/join.sh | sh -s -- <code>" >&2
  exit 2
fi
CODE="$1"
shift
if ! command -v node >/dev/null 2>&1; then
  echo "Nova's device agent needs Node.js 26 or newer, and Node.js isn't installed here. Install it (https://nodejs.org), then run the command again." >&2
  exit 1
fi
MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
case "$MAJOR" in ''|*[!0-9]*) MAJOR=0 ;; esac
if [ "$MAJOR" -lt 26 ]; then
  echo "Nova's device agent needs Node.js 26 or newer; this computer has $(node --version 2>/dev/null || echo 'an unknown version'). Update Node.js, then run the command again." >&2
  exit 1
fi
DEVICE_HOME="\${NOVA_DEVICE_HOME:-$HOME/.nova-device}"
umask 077
mkdir -p "$DEVICE_HOME"
TMP="$DEVICE_HOME/agent.download"
rm -rf "$TMP"
mkdir -p "$TMP/agent"
trap 'rm -rf "$TMP"' EXIT
if [ -n "\${NOVA_CA_FILE:-}" ]; then
  curl -fsS --cacert "$NOVA_CA_FILE" -o "$TMP/agent.tar" "$HUB/device-agent.tar"
else
  curl -fsS -o "$TMP/agent.tar" "$HUB/device-agent.tar"
fi
if command -v sha256sum >/dev/null 2>&1; then GOT=$(sha256sum "$TMP/agent.tar" | cut -d ' ' -f 1)
elif command -v shasum >/dev/null 2>&1; then GOT=$(shasum -a 256 "$TMP/agent.tar" | cut -d ' ' -f 1)
elif command -v openssl >/dev/null 2>&1; then GOT=$(openssl dgst -sha256 "$TMP/agent.tar" | sed 's/.*= *//')
else
  echo "This computer has no way to check the download (sha256sum, shasum or openssl), so nothing was installed." >&2
  exit 1
fi
if [ -z "$AGENT_SHA256" ] || [ "$GOT" != "$AGENT_SHA256" ]; then
  echo "The agent downloaded from $HUB doesn’t match the one this script names, so nothing was installed. Try again; if it happens again, something between this computer and Nova may be changing what it downloads." >&2
  exit 1
fi
tar -xf "$TMP/agent.tar" -C "$TMP/agent"
rm -rf "$DEVICE_HOME/agent"
mv "$TMP/agent" "$DEVICE_HOME/agent"
BOOT="$DEVICE_HOME/agent/src/device/boot.ts"
NOVA_DEVICE_HOME="$DEVICE_HOME" node "$BOOT" join "$HUB" --code "$CODE" "$@"
# A standby runs as a Nova server, not as this agent: --kind standby and --kind=standby alike.
PREV=''
for A in "$@"; do
  if [ "$A" = "--kind=standby" ] || { [ "$PREV" = "--kind" ] && [ "$A" = "standby" ]; }; then exit 0; fi
  PREV="$A"
done
if [ -n "\${NOVA_JOIN_NO_RUN:-}" ]; then
  echo "To start the agent: NOVA_DEVICE_HOME='$DEVICE_HOME' node '$BOOT' run"
  exit 0
fi
NOVA_DEVICE_HOME="$DEVICE_HOME" nohup node --disable-sigusr1 "$BOOT" run >>"$DEVICE_HOME/agent.log" 2>&1 </dev/null &
echo "The agent is running in the background (its log: $DEVICE_HOME/agent.log)."
echo "Check on it: NOVA_DEVICE_HOME='$DEVICE_HOME' node '$BOOT' status"
`;
}
