// Settings' structure (Amendment 2026-10-30-C Part 1 §4): one set of categories, grouped by what
// the person is trying to do, shown as a grouped list on a phone and as a sidebar beside a detail
// pane on a wider screen. One level only: a category holds settings, never more categories.
// Search knows the words people use, not just the labels, and every result says where it lives.
// Pure, so it is unit-tested (tests/ui-fixes.test.js).

// Each category draws Settings' existing parts (app.js PARTS), in this order.
export const CATEGORIES = Object.freeze([
  { id: 'you', label: 'You and Nova', summary: 'Names and how Nova talks to you', parts: ['you'] },
  { id: 'appearance', label: 'Appearance', summary: 'Theme, light and dark, contrast', parts: ['look'] },
  { id: 'privacy', label: 'Privacy and permissions', summary: 'What stays here, what asks first, capture', parts: ['privacy', 'perms', 'capture'] },
  { id: 'connections', label: 'Connections', summary: 'Accounts and services Nova can reach', parts: ['connections'] },
  { id: 'models', label: 'Models and providers', summary: 'Local models and outside help', parts: ['providers', 'models'] },
  { id: 'devices', label: 'Devices', summary: 'Phones and computers paired with Nova', parts: ['devices'] },
  { id: 'backups', label: 'Backups and changes', summary: 'Checkpoints, restores, Nova’s own changes', parts: ['checkpoints', 'changes'] },
  { id: 'danger', label: 'Start over', summary: 'Export everything, or erase Nova here', parts: ['danger'] },
]);

// The grouped list's sections.
export const GROUPS = Object.freeze([
  { title: 'You', cats: ['you', 'appearance', 'privacy'] },
  { title: 'What Nova works with', cats: ['connections', 'models', 'devices'] },
  { title: 'Keeping Nova safe', cats: ['backups', 'danger'] },
]);

export const categoryOf = (id) => CATEGORIES.find((c) => c.id === id) ?? null;
export const categoryOfPart = (part) => CATEGORIES.find((c) => c.parts.includes(part)) ?? null;

// What search can find: a label, the element it jumps to, and the words people use for it.
export const ENTRIES = Object.freeze([
  { cat: 'you', label: 'Your name', target: 'you-name-row', words: ['name', 'my name', 'call me', 'nickname', 'what nova calls me'] },
  { cat: 'you', label: 'Nova’s name', target: 'nova-name-row', words: ['rename', 'assistant name', 'agent name', 'nova name', 'call nova'] },
  { cat: 'you', label: 'Directness', target: 'directness-row', words: ['tone', 'blunt', 'gentle', 'plain', 'honest', 'personality', 'how nova talks', 'feedback'] },
  { cat: 'appearance', label: 'Theme', target: 'appearance-design', words: ['text size', 'font size', 'bigger text', 'type size', 'theme', 'themes', 'design', 'design system', 'look', 'looks', 'colour', 'colours', 'color', 'colors', 'skin', 'style', 'palette', 'appearance', 'font', 'fonts', 'wallpaper'] },
  { cat: 'appearance', label: 'Light and dark', target: 'appearance-mode', words: ['mode', 'color scheme', 'colour scheme', 'appearance mode', 'dark mode', 'light mode', 'dark', 'light', 'night mode', 'night', 'auto', 'brightness', 'dark theme', 'light theme'] },
  { cat: 'appearance', label: 'Contrast', target: 'contrast-check', words: ['high contrast', 'low vision', 'hard to see', 'contrast', 'readability', 'readable', 'hard to read', 'accessibility', 'legibility', 'wcag', 'faint'] },
  { cat: 'privacy', label: 'Privacy', target: 'privacy', words: ['privacy mode', 'voice', 'microphone', 'mic', 'dictation', 'speech', 'talk', 'privacy', 'private', 'local', 'local only', 'cloud', 'offline', 'data', 'send data'] },
  { cat: 'privacy', label: 'Without asking', target: 'perms', words: ['permissions', 'permission', 'ask first', 'approvals', 'approve', 'allow', 'trust', 'without asking', 'auto approve'] },
  { cat: 'privacy', label: 'Capture', target: 'capture', words: ['screenpipe', 'capture source', 'capture sources', 'sources', 'never capture', 'spaces', 'retention', 'capture', 'screen', 'record', 'recording', 'watch', 'clipboard', 'what nova sees', 'notes from apps'] },
  { cat: 'connections', label: 'Connections', target: 'connections', words: ['connections', 'connection', 'connectors', 'integrations', 'accounts', 'account', 'home assistant', 'gmail', 'email', 'mail', 'calendar', 'services', 'link'] },
  { cat: 'models', label: 'Providers', target: 'providers', words: ['api key', 'api keys', 'token', 'n8n', 'relay', 'providers', 'provider', 'api key', 'claude', 'openai', 'cloud model', 'coding agent', 'outside help'] },
  { cat: 'models', label: 'Models', target: 'models', words: ['models', 'model', 'local models', 'ollama', 'download', 'llm', 'ai', 'gpu', 'disk space'] },
  { cat: 'devices', label: 'Paired devices', target: 'devices', words: ['tailscale', 'mesh address', 'network', 'remote access', 'hub', 'standby', 'devices', 'device', 'phone', 'phones', 'pair', 'pairing', 'add a device', 'add phone', 'qr', 'qr code', 'tablet', 'laptop', 'computer', 'mesh', 'revoke', 'iphone', 'android'] },
  { cat: 'devices', label: 'Install Nova', target: 'install-row', words: ['install', 'app', 'home screen', 'pwa', 'add to home screen', 'shortcut'] },
  { cat: 'backups', label: 'Backups', target: 'checkpoints', words: ['restore', 'backup', 'backups', 'back up', 'checkpoint', 'checkpoints', 'restore', 'snapshot', 'roll back', 'undo everything'] },
  { cat: 'backups', label: 'Changes', target: 'changes', words: ['changes', 'updates', 'update', 'extensions', 'plugins', 'add-ons', 'upgrade', 'new features'] },
  { cat: 'danger', label: 'Erase Nova', target: 'danger-zone', words: ['reset', 'erase', 'delete everything', 'start over', 'factory reset', 'wipe', 'export', 'remove nova', 'uninstall'] },
]);

const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// One slip: a letter missing, extra, swapped or wrong (only for words of five letters or more).
function near(a, b) {
  if (Math.abs(a.length - b.length) > 1 || a.length < 4 || b.length < 4) return false;
  if (a.length === b.length) {
    const diff = [...a].map((c, i) => (c === b[i] ? -1 : i)).filter((i) => i >= 0);
    return diff.length === 1 || (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]);
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  return false;
}

// How well one query matches one entry: 0 for not at all.
function score(q, e) {
  const qw = q.split(' ');
  const label = norm(e.label);
  const phrases = [label, ...e.words.map(norm)];
  if (phrases.includes(q)) return label === q ? 100 : 90;
  if (phrases.some((p) => p.startsWith(q))) return 70;
  const words = new Set(phrases.flatMap((p) => p.split(' ')));
  const each = qw.map((w) => (words.has(w) ? 3 : [...words].some((x) => x.startsWith(w) && w.length >= 3) ? 2 : [...words].some((x) => near(w, x)) ? 1 : 0));
  if (each.some((v) => v === 0)) return 0;
  return 10 * Math.min(...each) + each.reduce((a, b) => a + b, 0);
}

// Results, best first: { label, path ("Appearance › Theme"), target, cat }.
export function searchSettings(query) {
  const q = norm(query);
  if (!q) return [];
  return ENTRIES.map((e, i) => ({ e, i, s: score(q, e) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(({ e }) => ({ label: e.label, path: `${categoryOf(e.cat).label} › ${e.label}`, target: e.target, cat: e.cat }));
}
