// Hardening of the shell's two browser sessions (docs/12, ADR-031). The Hub session (its own
// persistent partition) talks only to the verified Hub: every request elsewhere is cancelled, the
// Hub's certificate is accepted only as the pinned identity vouched for (docs/22 §5), and the
// page gets only the permissions the web UI needs. The local session runs the shell's own pages
// and loads nothing but their files.
import type { Certificate, Session } from 'electron';
import { localRequestAllowed, permissionAllowed, requestAllowed } from '../allowlist.ts';
import type { HoldOutcome } from '../hold.ts';
import type { HubTrust } from '../connect.ts';
import { certificateDecision, certificatesFromPem } from '../pinning.ts';

export const HUB_PARTITION = 'persist:nova-hub';

// Chromium's verify results: 0 accepts, -2 fails, -3 uses Chromium's own verification.
const ACCEPT = 0;
const REJECT = -2;
const CHROMIUM = -3;

export interface HubBinding {
  origin: string;
  trust: HubTrust;
  /**
   * Whether a statement check passed in this run. Until one does (the shell started while the Hub
   * was unreachable), nothing goes to the Hub: the page runs from the web UI's offline copy.
   */
  verified: boolean;
}

/** The chain Chromium was shown, leaf first, as Node certificates. */
export function chainOf(cert: Certificate): ReturnType<typeof certificatesFromPem> {
  const pems: string[] = [];
  const seen = new Set<string>();
  let c: Certificate | undefined = cert;
  while (c && c.data && !seen.has(c.data) && pems.length < 10) {
    seen.add(c.data);
    pems.push(c.data);
    c = c.issuerCert;
  }
  return certificatesFromPem(pems);
}

export interface HubSessionDeps {
  hub: () => HubBinding | null;
  /** Run the statement check again with a new nonce; resolves with the trust now in force. */
  reverify: () => Promise<HubBinding | null>;
  /** Park a request to a Hub not verified yet until it is, or until it fails (hold.ts). */
  hold: (release: (outcome: HoldOutcome) => void) => void;
}

export function hardenHubSession(ses: Session, deps: HubSessionDeps): void {
  const { hub, reverify } = deps;
  ses.webRequest.onBeforeRequest((details, callback) => {
    const h = hub();
    if (!h) return callback({ cancel: true });
    if (/^(data|blob|devtools):/.test(details.url)) return callback({});
    if (!requestAllowed(details.url, h.origin)) return callback({ cancel: true });
    if (h.verified) return callback({});
    // Not verified yet (an offline start): the request waits for the check, never goes out first.
    deps.hold((outcome) => callback(outcome.allow ? {} : { cancel: true }));
  });

  ses.setCertificateVerifyProc((req, callback) => {
    const h = hub();
    if (!h) return callback(REJECT);
    const host = new URL(h.origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (req.hostname.replace(/^\[|\]$/g, '').toLowerCase() !== host) return callback(REJECT);
    const trust = h.trust;
    if (trust.kind === 'platform') return callback(CHROMIUM);
    if (trust.kind !== 'pinned') return callback(REJECT);
    let chain: ReturnType<typeof chainOf>;
    try {
      chain = chainOf(req.certificate);
      if (certificateDecision(chain, host, trust) === 'accept') return callback(ACCEPT);
    } catch {
      return callback(REJECT);
    }
    // A certificate the last statement did not list (a renewal): ask again (docs/22 §5 step 7).
    reverify()
      .then((next) => {
        const t = next?.trust;
        callback(
          t?.kind === 'pinned' && certificateDecision(chain, host, t) === 'accept'
            ? ACCEPT
            : t?.kind === 'platform'
              ? CHROMIUM
              : REJECT,
        );
      })
      .catch(() => callback(REJECT));
  });

  // Permissions go to the Hub's own top frame only, judged by its real origin (a sandboxed
  // document at a Hub URL reports "null"). Notifications are the shell's (notify.ts).
  const hubOrigin = () => hub()?.origin ?? null;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(
      permissionAllowed({
        permission,
        isMainFrame: details.isMainFrame,
        frameOrigin: details.isMainFrame ? wc.mainFrame.origin : 'null',
        hubOrigin: hubOrigin(),
        mediaTypes: 'mediaTypes' in details ? (details.mediaTypes ?? []) : [],
      }),
    );
  });
  ses.setPermissionCheckHandler((wc, permission, _origin, details) =>
    permissionAllowed({
      permission,
      isMainFrame: details.isMainFrame,
      frameOrigin: details.isMainFrame && wc ? wc.mainFrame.origin : 'null',
      hubOrigin: hubOrigin(),
      mediaTypes: details.mediaType ? [details.mediaType] : [],
    }),
  );
}

export function hardenLocalSession(ses: Session, rendererDirUrl: string): void {
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !localRequestAllowed(details.url, rendererDirUrl) });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}
