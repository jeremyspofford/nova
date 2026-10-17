// Git details the Code views show and suggest (FR-070, docs/10 §8): the branch a commit on the
// default branch moves to (`nova/<slug>`), and whether the session is on the default branch.
import type { CodeSessionView } from '@nova/shared';

/** Lowercase words joined by hyphens, at most `max` characters, cut at a word boundary. */
export function slugify(text: string, max = 40): string {
  const words = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  let out = '';
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  // One very long word still gives a usable slug.
  return out || (words[0] ?? '').slice(0, max);
}

/** `nova/<slug>` from the first line of the commit message, else from the fallback. */
export function suggestBranch(message: string, fallback = ''): string {
  const first = message.split('\n')[0] ?? '';
  return `nova/${slugify(first) || slugify(fallback) || 'changes'}`;
}

type Repo = NonNullable<CodeSessionView['repo']>;

/** The repository's default branch: from the Hub when it sends one, else `main` or `master`. */
export function defaultBranch(repo: Repo): string | null {
  // `defaultBranch` is not in CodeSessionView yet; a Hub that knows it may send it.
  const known = (repo as Repo & { defaultBranch?: string | null }).defaultBranch;
  if (typeof known === 'string' && known) return known;
  return repo.branch === 'main' || repo.branch === 'master' ? repo.branch : null;
}

export function onDefaultBranch(repo: Repo | null): boolean {
  if (!repo?.branch) return false;
  return repo.branch === defaultBranch(repo);
}

/** A branch name Git accepts, roughly: no spaces, no `..`, no leading or trailing slash or dot. */
export function branchProblem(name: string, current: string | null): string | null {
  const n = name.trim();
  if (!n) return 'Enter a branch name.';
  if (current && n === current) return `Choose a branch other than ${current}.`;
  if (/\s|\.\.|[~^:?*[\\]|@\{|\/\/|^[/.]|[/.]$|\.lock$/.test(n))
    return 'Use letters, digits, hyphens and slashes, for example nova/fix-login.';
  return null;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
