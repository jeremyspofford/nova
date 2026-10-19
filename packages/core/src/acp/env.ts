// Environment variables an external agent asks for on a terminal (FR-203; M8, ADR-097). They
// reach the command only through an allowlist of names that change how tools present output or
// identify a commit, never where code, libraries, credentials or network traffic come from: no
// PATH, HOME, LD_*, proxy or CA variables, nothing Nova's sandbox sets itself (NOVA_*), and no
// value that is a vault reference or that the redactor recognizes as a credential (credentials
// never enter the sandbox, docs/12 §5). Anything else is dropped. The variables are set as
// leading assignments of the command, so the policy engine sees them: deny and ask rules look
// through them, and allow rules never match a command that carries them (it asks instead).
import { defaultRedactor } from '@nova/security';

/** Names an agent may set on a terminal, exactly. */
export const TERMINAL_ENV_NAMES: ReadonlySet<string> = new Set([
  'CI',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'COLUMNS',
  'LINES',
  'LANG',
  'LANGUAGE',
  'TZ',
  'PAGER',
  'GIT_PAGER',
  'MANPAGER',
  'DEBIAN_FRONTEND',
  'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE',
  'PYTHONIOENCODING',
  'PYTHONHASHSEED',
  'NODE_ENV',
  'RUST_BACKTRACE',
  'RUST_LOG',
  'CARGO_TERM_COLOR',
  'GIT_TERMINAL_PROMPT',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'DO_NOT_TRACK',
  'NEXT_TELEMETRY_DISABLED',
]);

/** Name prefixes an agent may set (locale categories). */
export const TERMINAL_ENV_PREFIXES: readonly string[] = ['LC_'];

/** At most this many variables per terminal, each value at most this long. */
export const MAX_TERMINAL_ENV = 32;
export const MAX_TERMINAL_ENV_VALUE = 4096;

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// Control characters (tabs and newlines included) would let a value spill into the command.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function terminalEnvNameAllowed(name: string): boolean {
  if (!NAME.test(name)) return false;
  return (
    TERMINAL_ENV_NAMES.has(name) ||
    TERMINAL_ENV_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length)
  );
}

/**
 * The variables of a terminal request that pass the allowlist, in request order (a later entry
 * of the same name wins), and the names that were dropped.
 */
export function terminalEnv(env: readonly { name: string; value: string }[] | undefined): {
  pass: [name: string, value: string][];
  dropped: string[];
} {
  const pass = new Map<string, string>();
  const dropped: string[] = [];
  for (const { name, value } of env ?? []) {
    const ok =
      terminalEnvNameAllowed(name) &&
      value.length <= MAX_TERMINAL_ENV_VALUE &&
      !CONTROL.test(value) &&
      !value.includes('secret://') &&
      defaultRedactor.redactString(value) === value;
    if (!ok || (!pass.has(name) && pass.size >= MAX_TERMINAL_ENV)) {
      dropped.push(NAME.test(name) ? name : '(invalid name)');
      continue;
    }
    pass.delete(name);
    pass.set(name, value);
  }
  return { pass: [...pass], dropped };
}
