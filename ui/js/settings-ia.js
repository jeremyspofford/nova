// Settings' structure (Amendment 2026-10-30-C Part 1 §4): one set of categories, grouped by what
// the person is trying to do, shown as a grouped list on a phone and as a sidebar beside a detail
// pane on a wider screen. One level only: a category holds settings, never more categories.
// Search knows the words people use, not just the labels, and every result says where it lives.
// Pure, so it is unit-tested (tests/ui-fixes.test.js).

// Each category draws Settings' existing parts (app.js PARTS), in this order.
export const CATEGORIES = Object.freeze([
  { id: 'you', label: 'You and Nova', summary: 'Names and how Nova talks to you', parts: ['you'] },
  { id: 'appearance', label: 'Appearance', summary: 'Theme, light and dark, contrast', parts: ['look'] },
  { id: 'privacy', label: 'Privacy and permissions', summary: 'What stays here and what asks first', parts: ['privacy', 'perms'] },
  { id: 'connections', label: 'Connections', summary: 'Accounts and services Nova can reach', parts: ['connections', 'sites'] },
  { id: 'models', label: 'Models and providers', summary: 'Local models and outside help', parts: ['providers', 'models'] },
  { id: 'devices', label: 'Devices', summary: 'Phones and computers paired with Nova', parts: ['devices'] },
  { id: 'capture', label: 'Capture', summary: 'Sources, consent, and what Nova remembers', parts: ['capture'] },
  { id: 'services', label: 'Services', summary: 'How Nova runs its services here', parts: ['services'] },
  { id: 'about', label: 'About Nova', summary: 'Its version and build, what’s new, where it stands', parts: ['about'] },
  { id: 'security', label: 'Security', summary: 'Passkeys that confirm tier-3 actions here', parts: ['security'] },
  { id: 'backups', label: 'Backups and changes', summary: 'Backup folders, checkpoints, restores and changes', parts: ['backups', 'checkpoints', 'changes'] },
  { id: 'config', label: 'Configuration', summary: 'Every setting of yours, a few questions, or a file', parts: ['form', 'config'] },
  { id: 'danger', label: 'Start over', summary: 'Export everything, or erase Nova here', parts: ['danger'] },
]);

// The grouped list's sections.
export const GROUPS = Object.freeze([
  { title: 'You', cats: ['you', 'appearance', 'privacy'] },
  { title: 'What Nova works with', cats: ['connections', 'models', 'devices', 'capture', 'services'] },
  { title: 'About', cats: ['about'] },
  { title: 'Keeping Nova safe', cats: ['security', 'backups', 'config', 'danger'] },
]);

export const categoryOf = (id) => CATEGORIES.find((c) => c.id === id) ?? null;

// What search can find: a label, the element it jumps to, and the words people use for it.
export const ENTRIES = Object.freeze([
  { cat: 'you', label: 'Your name', target: 'you-name-row', words: ['name', 'my name', 'call me', 'nickname', 'what nova calls me'] },
  { cat: 'you', label: 'Nova’s name', target: 'nova-name-row', words: ['rename', 'assistant name', 'agent name', 'nova name', 'call nova'] },
  { cat: 'you', label: 'Directness', target: 'directness-row', words: ['tone', 'blunt', 'gentle', 'plain', 'honest', 'personality', 'how nova talks', 'feedback'] },
  { cat: 'appearance', label: 'Theme', target: 'appearance-design', words: ['text size', 'font size', 'bigger text', 'type size', 'theme', 'themes', 'design', 'design system', 'look', 'looks', 'colour', 'colours', 'color', 'colors', 'skin', 'style', 'palette', 'appearance', 'font', 'fonts', 'wallpaper'] },
  { cat: 'appearance', label: 'Light and dark', target: 'appearance-mode', words: ['mode', 'color scheme', 'colour scheme', 'appearance mode', 'dark mode', 'light mode', 'dark', 'light', 'night mode', 'night', 'auto', 'brightness', 'dark theme', 'light theme'] },
  { cat: 'appearance', label: 'Contrast', target: 'contrast-check', words: ['high contrast', 'low vision', 'hard to see', 'contrast', 'readability', 'readable', 'hard to read', 'accessibility', 'legibility', 'wcag', 'faint'] },
  { cat: 'privacy', label: 'Privacy', target: 'privacy', words: ['privacy mode', 'voice', 'microphone', 'mic', 'dictation', 'speech', 'talk', 'privacy', 'private', 'local', 'local only', 'cloud', 'offline', 'data', 'send data'] },
  // Before Without asking: "ask first" and "approvals" find the whole place first, the
  // conversation's switches next.
  { cat: 'privacy', label: 'Approvals', target: 'approvals', words: ['approvals', 'approval', 'approval tiers', 'tier', 'tiers', 'ask first', 'asks first', 'confirm every time', 'confirms every time', 'just does it', 'does it and tells you', 'what asks first', 'loosen', 'tighten', 'never presses pay'] },
  { cat: 'privacy', label: 'Without asking', target: 'perms', words: ['permissions', 'permission', 'ask first', 'approvals', 'approve', 'allow', 'trust', 'without asking', 'auto approve'] },
  { cat: 'capture', label: 'Capture', target: 'capture', words: ['screenpipe', 'capture source', 'capture sources', 'sources', 'never capture', 'spaces', 'retention', 'capture', 'screen', 'record', 'recording', 'watch', 'clipboard', 'what nova sees', 'notes from apps'] },
  { cat: 'connections', label: 'Connections', target: 'connections', words: ['connections', 'connection', 'connectors', 'integrations', 'accounts', 'account', 'home assistant', 'gmail', 'email', 'mail', 'calendar', 'services', 'link'] },
  { cat: 'connections', label: 'Site sign-ins', target: 'browser-sites', words: ['site sign-ins', 'site sign-in', 'sign-ins', 'sign ins', 'saved passwords', 'passwords', 'logins', 'login', 'log in', 'cookies', 'browser', 'nova browser', 'websites', 'web sites', 'forget site', 'signed in'] },
  { cat: 'models', label: 'Providers', target: 'providers', words: ['api key', 'api keys', 'token', 'n8n', 'relay', 'providers', 'provider', 'api key', 'claude', 'openai', 'cloud model', 'coding agent', 'outside help'] },
  { cat: 'models', label: 'Models', target: 'models', words: ['models', 'model', 'local models', 'ollama', 'download', 'llm', 'ai', 'gpu', 'disk space'] },
  { cat: 'devices', label: 'Paired devices', target: 'devices', words: ['tailscale', 'mesh address', 'network', 'remote access', 'hub', 'standby', 'devices', 'device', 'phone', 'phones', 'pair', 'pairing', 'add a device', 'add phone', 'qr', 'qr code', 'tablet', 'laptop', 'computer', 'mesh', 'revoke', 'iphone', 'android'] },
  { cat: 'devices', label: 'Machines and services', target: 'devices-topology', words: ['topology', 'map', 'machine', 'machines', 'workloads', 'versions', 'where services run'] },
  { cat: 'devices', label: 'Device roles', target: 'devices', words: ['roles', 'role', 'purpose', 'what it is for', 'thin client', 'hub candidate', 'compute', 'storage', 'capture source', 'general server'] },
  { cat: 'services', label: 'How services run', target: 'services-backend', words: ['services', 'service', 'backend', 'supervisor', 'k3s', 'kubernetes', 'containers', 'cluster', 'ordinary programs', 'switch backend'] },
  { cat: 'devices', label: 'Install Nova', target: 'install-row', words: ['install', 'app', 'home screen', 'pwa', 'add to home screen', 'shortcut'] },
  { cat: 'security', label: 'Passkeys', target: 'security', words: ['passkey', 'passkeys', 'security key', 'yubikey', 'fingerprint', 'face id', 'touch id', 'webauthn', 'security', 'tier 3', 'tier-3', 'confirm', 'second passkey'] },
  { cat: 'backups', label: 'Backups', target: 'settings-backups', words: ['folder', 'encrypted', 'recovery key', 'retention', 'restore', 'backup', 'backups', 'back up', 'checkpoint', 'checkpoints', 'restore', 'snapshot', 'roll back', 'undo everything'] },
  { cat: 'backups', label: 'Changes', target: 'changes', words: ['changes', 'updates', 'update', 'extensions', 'plugins', 'add-ons', 'upgrade', 'new features'] },
  { cat: 'config', label: 'Configuration file', target: 'config', words: ['configuration', 'config', 'nova.config.json', 'import', 'export', 'pack', 'user pack', 'settings file', 'bring in settings', 'json'] },
  { cat: 'config', label: 'Your settings', target: 'config-form', words: ['all my settings', 'every setting', 'timezone', 'time zone', 'quiet hours', 'do not disturb', 'warmth', 'speaking up', 'proactive', 'use the default', 'back to default', 'defaults', 'guided setup', 'questions', 'layer', 'your pack'] },
  { cat: 'about', label: 'About Nova', target: 'about', words: ['about', 'version', 'which version', 'build', 'commit', 'running build', 'redeploy', 'deploy', 'latest build', 'changelog', 'whats new', 'what changed', 'release notes', 'pipeline', 'roadmap', 'where nova stands', 'progress', 'milestones'] },
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

// The search as Settings shows it (the composition's default, decided): the category list keeps
// only the categories with a match, each with its count, in the list's own order; the matches
// themselves are marked in the detail. `found` is best first; `cats` follows CATEGORIES.
export function filterSettings(query) {
  const found = searchSettings(query);
  const counts = new Map();
  for (const r of found) counts.set(r.cat, (counts.get(r.cat) ?? 0) + 1);
  return { found, cats: CATEGORIES.filter((c) => counts.has(c.id)).map((c) => ({ id: c.id, count: counts.get(c.id) })) };
}
