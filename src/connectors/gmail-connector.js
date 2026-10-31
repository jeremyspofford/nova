// Era 2's Gmail, repackaged as a connector (M5 plan §2). The behaviour is the same Gmail
// (src/connectors/gmail.js): it reads, saves drafts and organizes, and never sends or deletes;
// the chat tools and the Skills page still drive it. What the connector adds:
//  - a manifest in the extension host, and its secrets in the vault under connector/gmail/;
//  - new mail as an event trigger: only while a rule listens for `inbox`, Nova looks at the inbox
//    every few minutes and fires once per new message (by id; the record keeps only a hash);
//  - Disconnect in Settings › Connections: signs out at Google where it can and deletes every
//    Gmail secret, the rules listening to it, and its settings.
// Connecting stays on the Skills page, where Google's sign-in comes back to.
import { GMAIL_SECRETS, GmailOAuth } from './gmail.js';

export const GMAIL_MANIFEST = {
  id: 'gmail',
  version: '1.0.0',
  kind: 'connector',
  name: 'Gmail',
  capabilities: ['mail.read', 'mail.draft', 'mail.organize', 'mail.events'],
  permissions: [
    { kind: 'network', target: 'Gmail, at Google', why: 'to read your mail, save drafts and file messages' },
    { kind: 'data-read', target: 'your email', why: 'to find and read messages when you ask' },
    { kind: 'data-write', target: 'your Gmail drafts and labels', why: 'to save drafts for you to send, and to archive, label and mark messages' },
  ],
  secrets: GMAIL_SECRETS,
  config_schema: { type: 'object', properties: {} },
  setup_flow: { page: '/skills#gmail' },
  health_check: { kind: 'status' },
  nova_compat: '>=0.1.0 <1.0.0',
  on_remove: { delete: ['config.json'], keep: [], export: [] },
};

// Message ids in a search result (mail.js searchResult), the same over the API and over IMAP.
const ids = (output) => [...String(output ?? '').matchAll(/\bid=([0-9a-f]+) conversation=([0-9a-f]+)/g)].map((m) => ({ id: m[1], conversation: m[2] }));

export function gmailConnector(gmail, { pollMs = 5 * 60_000 } = {}) {
  return (ctx) => {
    let timer = null;
    let seen = null; // ids already in the inbox when Nova started looking
    let polling = false;

    const listening = () => ctx.topics().includes('inbox');

    async function poll() {
      if (polling || !gmail.status().connected || !listening() || !ctx.permits('remote')) return;
      polling = true;
      try {
        const found = ids((await gmail.search({ query: 'in:inbox newer_than:2d', max: 25 })).output);
        // The first look only learns what is there: mail from before isn't news.
        if (seen) {
          for (const m of found) if (!seen.has(m.id)) await ctx.emit('inbox', m, m.id);
        }
        seen = new Set([...(seen ?? []), ...found.map((m) => m.id)].slice(-500));
      } catch {
        // Gmail's own errors (reconnect, unreachable) show in its status; the next look tries again.
      } finally {
        polling = false;
      }
    }

    return {
      manifest: GMAIL_MANIFEST,
      summary: 'Your email: Nova can find and read messages, save drafts for you to send, and tidy your inbox.',
      can: [
        'Search and read your mail when you ask.',
        'Save drafts; you review and send them from Gmail.',
        'Archive, label and mark messages read or unread, after asking, unless you turn that off in Settings.',
        'Notice new mail, for the rules you set up.',
      ],
      never: ['Send email.', 'Delete email.'],
      setup: { kind: 'link', href: '/skills#gmail', label: 'Connect Gmail' },
      egress: () => 'remote',
      status() {
        const s = gmail.status();
        return {
          connected: !!s.connected, broken: !!s.broken, account: s.account ?? null, since: s.since ?? null,
          live: s.connected && listening() ? (timer ? 'listening' : 'off') : null,
          detail: s.broken ? 'Gmail needs reconnecting: Google no longer accepts Nova’s sign-in.' : s.method === 'password' ? 'Connected with an app password.' : s.method === 'google' ? 'Connected through your own Google client.' : null,
        };
      },
      // Everything Gmail holds: the app password (Google offers no way for Nova to revoke one), the
      // Google sign-in (revoked at Google), and the saved OAuth client.
      async disconnect() {
        let revoked = false;
        let note;
        if (gmail.imap.saved()) {
          gmail.imap.forget();
          note = 'Nova forgot the app password. Google keeps it working until you remove it at myaccount.google.com/apppasswords.';
        }
        if (gmail.read('token.json')) {
          const s = await GmailOAuth.prototype.disconnect.call(gmail);
          revoked = !!s.revoked;
          if (!revoked) note = 'Google didn’t answer, so also remove Nova in your Google account’s security settings.';
        }
        gmail.forgetClient();
        seen = null;
        return note ? { revoked, note } : { revoked };
      },
      start() {
        if (timer) return;
        timer = setInterval(poll, pollMs);
        timer.unref?.();
        poll();
      },
      stop() {
        if (timer) clearInterval(timer);
        timer = null;
      },
      topic: (t) => (t === 'inbox' ? null : 'Gmail rules listen for new mail in the inbox: the topic is inbox.'),
      // For tests: look now rather than wait for the interval.
      poll,
    };
  };
}
