// Bearer tokens for every listener (FR-192). Tokens are random, shown once, and stored only as
// SHA-256 hashes. Comparison is constant-time.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type TokenKind = 'setup' | 'session' | 'device' | 'mcp_client' | 'app';

const PREFIX: Record<TokenKind, string> = {
  setup: 'nvs',
  session: 'nvx',
  device: 'nvd',
  mcp_client: 'nvm',
  app: 'nva',
};

/** A new token like `nvx_<43 base64url chars>` (256 bits of entropy). */
export function newToken(kind: TokenKind): string {
  return `${PREFIX[kind]}_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenKind(token: string): TokenKind | null {
  const prefix = token.split('_', 1)[0];
  const entry = Object.entries(PREFIX).find(([, p]) => p === prefix);
  return entry ? (entry[0] as TokenKind) : null;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
