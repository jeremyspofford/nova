// Agent distribution area (FR-133; docs/22 §4.3, docs/23 §2): the signed `novad` builds the Hub
// serves and the one-line install command Add Device shows for headless devices.
//   GET /api/v1/agent/dist/:file   public. Serves only the files the signed manifest lists, the
//                                   manifest `novad-manifest.json` and its signature
//                                   `novad-manifest.sig`; every other name is 404.
// The route is public by design: builds are not secret, and their integrity is the manifest's
// Ed25519 signature by the Hub identity plus each build's SHA-256, which `novad install` checks
// against the pinned Hub fingerprint before it writes anything (and the one-line command checks
// the SHA-256 before running the download). It is rate-limited per client address. Builds come
// from the folder in NOVA_NOVAD_DIST (packaging fills it), named `novad-<os>-<arch>` with os
// linux|darwin|windows and arch amd64|arm64 (`.exe` for Windows), plus an optional VERSION file.
// Without builds the manifest is empty and the bootstrap command is null with the reason. The
// manifest is signed through `useHubIdentity` (the trust area's HubIdentity, FR-134) over
// MANIFEST_SIGNATURE_TAG followed by its exact bytes; unsigned, its signature is 404.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NovaError } from '@nova/shared';
import { SlidingWindowLimiter } from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export const MANIFEST_FILE = 'novad-manifest.json';
export const SIGNATURE_FILE = 'novad-manifest.sig';
/**
 * The manifest signature covers this tag and then the manifest bytes, so no other statement the
 * Hub identity signs (Add Device answers, the identity statement) can pass as one.
 */
export const MANIFEST_SIGNATURE_TAG = 'nova-novad-manifest-v1\n';

/** What the Hub identity signs for a manifest. */
export function manifestSignedBytes(bytes: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(MANIFEST_SIGNATURE_TAG, 'utf8'), bytes]);
}
/** Larger files are ignored: a novad build is a few megabytes. */
const MAX_BUILD_BYTES = 512 * 1024 * 1024;
const BUILD_NAME = /^novad-(linux|darwin|windows)-(amd64|arm64)(\.exe)?$/;
/** Add Device codes: Crockford base32 without I, L, O and U (FR-132). */
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
/** base64url(SHA-256(raw public key)). */
const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/;
const PAIRING_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const VERSION_TEXT = /^[0-9A-Za-z.+-]{1,64}$/;

export const BOOTSTRAP_ROLES = ['client', 'compute', 'wake-helper'] as const;
export type BootstrapRole = (typeof BOOTSTRAP_ROLES)[number];

export type NovadOs = 'linux' | 'darwin' | 'windows';
export type NovadArch = 'amd64' | 'arm64';

export interface NovadBuild {
  name: string;
  os: NovadOs;
  arch: NovadArch;
  /** Lowercase hex. */
  sha256: string;
  size: number;
}

/** `novad-manifest.json` (docs/22 §4.3). */
export interface NovadManifest {
  version: string | null;
  files: NovadBuild[];
  hubFingerprint: string | null;
  signedAt: string;
}

export interface SignedManifest {
  manifest: NovadManifest;
  /** The exact bytes served and signed. */
  bytes: Buffer;
  /** Standard base64 Ed25519 signature over `bytes`; null without a Hub identity. */
  signature: string | null;
}

/** The Hub identity as the trust area exposes it (FR-134): the manifest is signed with it. */
export interface HubSigner {
  /** base64url(SHA-256(raw Ed25519 public key)), 43 characters. */
  fingerprint: string;
  /** base64url of the raw 32-byte public key. */
  publicKey: string;
  /** An Ed25519 signature over `bytes` (raw, or base64/base64url text). */
  sign(bytes: Uint8Array): Uint8Array | string | Promise<Uint8Array | string>;
}

/** The headless install command for Add Device (`bootstrap` in its start answer). */
export interface BootstrapCommand {
  /** POSIX sh one-liner for Linux and macOS builds. */
  command: string | null;
  /** PowerShell for Windows builds. */
  powershell: string | null;
  /** Why there is no command, for the owner. */
  why: string | null;
}

export interface AgentDistArea extends HubArea {
  /** The current manifest, rescanned and re-signed when the builds or the identity change. */
  manifest(): Promise<SignedManifest>;
  /**
   * The bootstrap command builder Add Device calls through its `useBootstrap` seam.
   * `hubFingerprint` defaults to the identity that signed the manifest (null: the Hub has none).
   * `pairingId` is required: the command always carries `--pairing` (without it the answer is
   * null with the reason). The code is handed to novad on its standard input (PowerShell: in
   * NOVA_ADD_CODE), never as an argument. Input is validated before it goes into a command, and
   * every value is shell-quoted anyway.
   */
  bootstrap(
    role: string,
    code: string,
    hubUrl: string,
    hubFingerprint?: string | null,
    pairingId?: string,
  ): Promise<BootstrapCommand>;
  /** The trust area's Hub identity (late-bound); until bound the manifest is unsigned. */
  useHubIdentity(identity: () => HubSigner | null | Promise<HubSigner | null>): void;
}

export interface AgentDistDeps {
  /** The builds folder; defaults to NOVA_NOVAD_DIST. */
  distDir?: string | null;
  now?: () => Date;
  /**
   * Tests: allow a loopback Hub address in the command. Other devices cannot reach one, so it is
   * refused by default.
   */
  allowLoopbackHub?: boolean;
  /** Requests per client address on the public dist route (default 60 a minute). */
  rateLimit?: { limit: number; windowMs: number };
}

const params = z.object({ file: z.string() });

/** POSIX single quotes: the only character that needs care inside them is the quote itself. */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** PowerShell single quotes: a quote is doubled. */
export function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The canonical Add Device code, as the add-device area reads it: upper case, without spaces or
 * hyphens, O read as 0 and I or L as 1; null unless that leaves a valid code.
 */
export function normalizeCode(code: string): string | null {
  const c = code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE.test(c) ? c : null;
}

/** The os and arch of a build file name, or null when it is not one. */
export function parseBuildName(name: string): { os: NovadOs; arch: NovadArch } | null {
  const m = BUILD_NAME.exec(name);
  if (!m) return null;
  const os = m[1] as NovadOs;
  // Windows builds end in .exe; nothing else does.
  if ((os === 'windows') !== (m[3] === '.exe')) return null;
  return { os, arch: m[2] as NovadArch };
}

/** The Hub's origin for the command, or why it cannot be used. */
export function hubOrigin(
  hubUrl: string,
  allowLoopback = false,
): { origin: string } | { why: string } {
  let u: URL;
  try {
    u = new URL(hubUrl);
  } catch {
    return { why: 'The Hub address is not a valid URL.' };
  }
  if (u.protocol === 'https:') {
    return {
      why: 'novad has no TLS client yet: open the Hub at its http:// LAN address to get the install command.',
    };
  }
  if (u.protocol !== 'http:') return { why: 'The Hub address must be an http:// URL.' };
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    return { why: 'The Hub address must be just http://host:port.' };
  }
  // Host and port only, from the URL parser; anything unusual is refused rather than quoted.
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(u.host)) {
    return { why: 'The Hub address has an unusual host name.' };
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    host === '::1';
  if (loopback && !allowLoopback) {
    return {
      why: 'The Hub was opened at a loopback address, which other devices cannot reach: open it at its LAN address to get the install command.',
    };
  }
  return { origin: `http://${u.host}` };
}

function base64Signature(sig: Uint8Array | string): string | null {
  const bytes =
    typeof sig === 'string'
      ? Buffer.from(sig.trim().replaceAll('-', '+').replaceAll('_', '/'), 'base64')
      : Buffer.from(sig);
  return bytes.length === 64 ? bytes.toString('base64') : null;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const POSIX_CASES: Record<string, string> = {
  'linux-amd64': 'Linux-x86_64|Linux-amd64',
  'linux-arm64': 'Linux-aarch64|Linux-arm64',
  'darwin-amd64': 'Darwin-x86_64',
  'darwin-arm64': 'Darwin-arm64',
};

/**
 * The POSIX one-liner (docs/22 §4.3): pick the build for this machine, download it, check its
 * SHA-256 from the signed manifest, run `novad install` (as root through sudo when needed) and
 * remove the download. `novad install` then verifies the Hub key and the manifest signature.
 * The hash is computed and compared here (no `-c` reading stdin, so a fallback tool never runs
 * on input the first one used up), and the code reaches novad on its standard input from the
 * shell's `printf` builtin: it is on no process's argv, and a pipe survives sudo, which drops
 * the environment.
 */
function shCommand(
  origin: string,
  builds: NovadBuild[],
  code: string,
  installArgs: string,
): string {
  const cases = builds
    .map((b) => {
      const id = `${b.os}-${b.arch}`;
      return `${POSIX_CASES[id] ?? id}) a=${id}; h=${b.sha256};;`;
    })
    .join(' ');
  const url = `${shQuote(`${origin}/api/v1/agent/dist/novad-`)}"$a"`;
  return [
    `d=$(mktemp -d) && case "$(uname -s)-$(uname -m)" in ${cases} *) echo "no novad build for $(uname -s) $(uname -m)" >&2; a=;; esac`,
    `[ -n "$a" ]`,
    `{ curl -fsSL -o "$d/novad" ${url} || wget -qO "$d/novad" ${url}; }`,
    `x=$(sha256sum "$d/novad" 2>/dev/null || shasum -a 256 "$d/novad" 2>/dev/null)`,
    `{ [ "\${x%% *}" = "$h" ] || { echo "the download is not the Hub's signed build" >&2; false; }; }`,
    `chmod 0755 "$d/novad"`,
    `s= && { [ "$(id -u)" -eq 0 ] || s=sudo; }`,
    `printf '%s\\n' ${shQuote(code)} | $s "$d/novad" install --code - ${installArgs}; r=$?; rm -rf "$d"; [ "$r" -eq 0 ]`,
  ].join(' && ');
}

/**
 * The PowerShell variant for Windows builds (run as Administrator: it installs a service). The
 * code goes to novad in NOVA_ADD_CODE, removed again afterwards.
 */
function psCommand(
  origin: string,
  builds: NovadBuild[],
  code: string,
  installArgs: string,
): string {
  const arches = builds.map((b) => `${psQuote(b.arch)} = ${psQuote(b.sha256)}`).join('; ');
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$a = @{ 'AMD64' = 'amd64'; 'ARM64' = 'arm64' }[[string]$env:PROCESSOR_ARCHITECTURE]`,
    `$h = @{ ${arches} }[[string]$a]`,
    `if (-not $h) { throw "no novad build for $env:PROCESSOR_ARCHITECTURE" }`,
    `$f = Join-Path ([IO.Path]::GetTempPath()) ('novad-' + [guid]::NewGuid() + '.exe')`,
    `Invoke-WebRequest -UseBasicParsing -Uri (${psQuote(`${origin}/api/v1/agent/dist/novad-windows-`)} + $a + '.exe') -OutFile $f`,
    `if ((Get-FileHash -Algorithm SHA256 $f).Hash.ToLower() -ne $h) { Remove-Item $f; throw 'the download is not the Hub''s signed build' }`,
    `$env:NOVA_ADD_CODE = ${psQuote(code)}`,
    `try { & $f install ${installArgs}; $r = $LASTEXITCODE } finally { Remove-Item Env:NOVA_ADD_CODE -ErrorAction SilentlyContinue; Remove-Item $f -ErrorAction SilentlyContinue }`,
    `if ($r -ne 0) { throw "novad install failed ($r)" }`,
  ].join('; ');
}

export function setupAgentDist(ctx: HubContext, deps: AgentDistDeps = {}): AgentDistArea {
  const distDir = deps.distDir === undefined ? (process.env.NOVA_NOVAD_DIST ?? null) : deps.distDir;
  const now = deps.now ?? (() => new Date());
  const log = ctx.log.child('agent-dist');
  let identity: (() => HubSigner | null | Promise<HubSigner | null>) | null = null;
  /** SHA-256 per file, kept while its size, mtime and inode stay the same. */
  const hashes = new Map<string, { key: string; sha256: string }>();
  let cached: { key: string; signed: SignedManifest } | null = null;
  let building: Promise<SignedManifest> | null = null;
  const limiter = new SlidingWindowLimiter({
    limit: deps.rateLimit?.limit ?? 60,
    windowMs: deps.rateLimit?.windowMs ?? 60_000,
    now: () => now().getTime(),
  });

  async function scan(): Promise<{ files: NovadBuild[]; version: string | null }> {
    if (!distDir) return { files: [], version: null };
    let names: string[];
    try {
      names = await readdir(distDir);
    } catch (err) {
      log.warn('the novad build folder cannot be read', { err });
      return { files: [], version: null };
    }
    const files: NovadBuild[] = [];
    for (const name of names.sort()) {
      const parsed = parseBuildName(name);
      if (!parsed) continue;
      const path = join(distDir, name);
      try {
        const st = await stat(path);
        if (!st.isFile() || st.size === 0 || st.size > MAX_BUILD_BYTES) continue;
        const key = `${st.size}:${st.mtimeMs}:${st.ino}`;
        let entry = hashes.get(name);
        if (entry?.key !== key) {
          entry = { key, sha256: await sha256File(path) };
          hashes.set(name, entry);
        }
        files.push({ name, ...parsed, sha256: entry.sha256, size: st.size });
      } catch (err) {
        log.warn('a novad build cannot be read', { name, err });
      }
    }
    let version: string | null;
    try {
      const text = (await readFile(join(distDir, 'VERSION'), 'utf8')).trim();
      version = VERSION_TEXT.test(text) ? text : null;
    } catch {
      version = null;
    }
    return { files, version };
  }

  /** The bound identity, or null while there is none or it cannot be read (not loaded yet). */
  async function signer(): Promise<{ signer: HubSigner; fingerprint: string } | null> {
    if (!identity) return null;
    try {
      const s = await identity();
      if (!s) return null;
      const fingerprint = s.fingerprint;
      return FINGERPRINT.test(fingerprint) ? { signer: s, fingerprint } : null;
    } catch (err) {
      log.warn('the Hub identity is not available to sign the novad manifest', { err });
      return null;
    }
  }

  async function sign(s: HubSigner, bytes: Buffer): Promise<string | null> {
    try {
      const signature = base64Signature(await s.sign(new Uint8Array(manifestSignedBytes(bytes))));
      if (!signature) log.warn('the Hub identity returned a signature that is not 64 bytes');
      return signature;
    } catch (err) {
      log.warn('the novad manifest could not be signed', { err });
      return null;
    }
  }

  async function build(): Promise<SignedManifest> {
    const { files, version } = await scan();
    const id = await signer();
    const fingerprint = id?.fingerprint ?? null;
    const key = JSON.stringify([files, version, fingerprint]);
    if (cached?.key === key) return cached.signed;
    // Re-signed only when something changed, so a manifest and its signature fetched one after
    // the other match.
    const manifest: NovadManifest = {
      version,
      files,
      hubFingerprint: fingerprint,
      signedAt: now().toISOString(),
    };
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const signature = id ? await sign(id.signer, bytes) : null;
    const signed: SignedManifest = { manifest, bytes, signature };
    // A signature that failed is tried again on the next request.
    cached = id && !signature ? null : { key, signed };
    return signed;
  }

  function manifest(): Promise<SignedManifest> {
    // One rescan at a time; concurrent callers share it.
    building ??= build().finally(() => {
      building = null;
    });
    return building;
  }

  async function bootstrap(
    role: string,
    code: string,
    hubUrl: string,
    hubFingerprint?: string | null,
    pairingId?: string,
  ): Promise<BootstrapCommand> {
    const none = (why: string): BootstrapCommand => ({ command: null, powershell: null, why });
    if (!(BOOTSTRAP_ROLES as readonly string[]).includes(role))
      return none('The role has no install command.');
    const normalized = normalizeCode(code);
    if (!normalized) return none('The Add Device code is not valid.');
    // The pairing id scopes the code to its own pairing (review finding 4).
    if (pairingId === undefined) return none('The install command needs the pairing id.');
    if (!PAIRING_ID.test(pairingId)) return none('The pairing id is not valid.');
    const origin = hubOrigin(hubUrl, deps.allowLoopbackHub ?? false);
    if ('why' in origin) return none(origin.why);
    const signed = await manifest();
    const pin = hubFingerprint === undefined ? signed.manifest.hubFingerprint : hubFingerprint;
    if (!pin) return none('This Hub has no identity yet, so a device cannot pin it.');
    if (!FINGERPRINT.test(pin)) return none('The Hub fingerprint is not valid.');
    const builds = signed.manifest.files.filter((b) => SHA256_HEX.test(b.sha256));
    if (!builds.length) {
      return none(
        'This Hub has no novad builds to serve (packaging puts them in the NOVA_NOVAD_DIST folder).',
      );
    }
    if (!signed.signature || signed.manifest.hubFingerprint !== pin) {
      return none("The build manifest is not signed by this Hub's identity yet.");
    }
    const display = `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
    // The code is not among the arguments: each command hands it over privately.
    const args = (quote: (v: string) => string) =>
      [
        `--hub ${quote(origin.origin)}`,
        `--pairing ${quote(pairingId)}`,
        `--pin ${quote(pin)}`,
        `--role ${quote(role)}`,
      ].join(' ');
    const posix = builds.filter((b) => b.os !== 'windows');
    const windows = builds.filter((b) => b.os === 'windows');
    return {
      command: posix.length ? shCommand(origin.origin, posix, display, args(shQuote)) : null,
      powershell: windows.length ? psCommand(origin.origin, windows, display, args(psQuote)) : null,
      why: posix.length ? null : 'Only Windows builds are available: use the PowerShell command.',
    };
  }

  ctx.diagnostics.add('agentDist', async () => {
    const m = await manifest();
    return {
      configured: distDir !== null,
      builds: m.manifest.files.map((f) => f.name),
      version: m.manifest.version,
      signed: m.signature !== null,
    };
  });

  function register(app: FastifyInstance): void {
    app.get('/api/v1/agent/dist/:file', async (req, reply) => {
      if (!limiter.take(req.ip)) {
        throw new NovaError('rate_limited', 'too many requests from this address', {
          details: { reason: 'address_rate_limited' },
          action: 'Wait a minute and try again',
        });
      }
      const { file } = params.parse(req.params);
      const signed = await manifest();
      void reply.header('cache-control', 'no-store');
      if (file === MANIFEST_FILE) {
        return reply.type('application/json; charset=utf-8').send(signed.bytes);
      }
      if (file === SIGNATURE_FILE && signed.signature) {
        return reply.type('text/plain; charset=utf-8').send(signed.signature);
      }
      // Only a name the manifest lists reaches the file system; it was matched against the
      // strict build pattern when the folder was scanned.
      const build = signed.manifest.files.find((f) => f.name === file);
      if (!build || !distDir) throw new NovaError('not_found', 'no such build');
      const handle = await open(join(distDir, build.name), 'r').catch(() => null);
      if (!handle) throw new NovaError('not_found', 'no such build');
      const st = await handle.stat();
      void reply
        .type('application/octet-stream')
        .header('content-length', String(st.size))
        .header('content-disposition', `attachment; filename="${build.name}"`);
      // For HEAD, Fastify drains the stream and keeps this Content-Length.
      return reply.send(handle.createReadStream());
    });
  }

  return {
    manifest,
    bootstrap,
    useHubIdentity(fn) {
      identity = fn;
    },
    register,
    close: () => Promise.resolve(),
  };
}
