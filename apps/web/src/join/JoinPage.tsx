// The joining device's page, `/add-device` (FR-132; docs/22 §4.1, §4.4; docs/04 §9 flow 1; Add
// Device protocol v2). It works without a session: the QR code or the link carries the pairing id
// (`p`) and the Hub's fingerprint (`fp`, the pin) in the query and the code in the fragment
// (`#c=`, which never reaches a server log; the page removes it from the address at once). The
// page checks it reached the Hub that made the code (the Hub key must hash to the pin), makes a
// device key the page cannot export, commits to a random nonce with the code, reveals it once the
// Hub answered with its own, and shows the six-digit confirmation the owner types on the Hub:
// comparing the two screens is the security step. With a pin, the Hub's signature over the
// confirmation must verify, and the Hub's confirmation must equal the page's own; anything else
// stops the page. It then polls the signed status until the owner decides; approved, the Hub sets
// this browser's session cookie and the page offers to open and install the app. Without a code
// in the link it asks for the one shown on the Hub. Phone width first.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, Icon, Spinner, TextField, applyTheme, resolveTheme } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { readCachedTheme } from '../appearance.ts';
import { joinClient, type JoinClient, type JoinCommitted } from './client.ts';
import {
  commitment,
  displayConfirmation,
  displayPairingCode,
  exportPublicKey,
  generateDeviceKey,
  hubRevealStatement,
  keyFingerprint,
  normalizePairingCode,
  pairingConfirmationV2,
  randomNonce,
  signReveal,
  signStatus,
  verifyText,
} from './crypto.ts';
import { detectPlatform, installWay, type JoinPlatform } from './platform.ts';
import { pollStatus, type PollDeps } from './poll.ts';
import {
  browserJoinStore,
  pageNav,
  rememberThisDevice,
  type JoinRecord,
  type JoinStore,
} from './store.ts';
import './join.css';

export const JOIN_PATH = '/add-device';

/** True for the joining device's page (it renders without a session). */
export function isJoinPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === JOIN_PATH;
}

export interface JoinParams {
  pairingId: string | null;
  /** The Hub fingerprint the code was made with; the page stops if the Hub answers another. */
  fingerprint: string | null;
  /** The code from the fragment, canonical; null when absent or malformed. */
  code: string | null;
  /** A fragment code that is not a code. */
  badCode: boolean;
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The pairing id, fingerprint and code from `?p=…&fp=…#c=…`. */
export function readJoinParams(search: string, hash: string): JoinParams {
  const q = new URLSearchParams(search);
  const p = q.get('p');
  const fp = q.get('fp');
  const m = /(?:^#|&)c=([^&]*)/.exec(hash);
  let raw: string | null = null;
  if (m) {
    try {
      raw = decodeURIComponent(m[1] ?? '');
    } catch {
      raw = '';
    }
  }
  const code = raw === null ? null : normalizePairingCode(raw);
  return {
    pairingId: p && ID.test(p) ? p : null,
    fingerprint: fp || null,
    code,
    badCode: raw !== null && code === null,
  };
}

type Phase =
  | { kind: 'checking' }
  | { kind: 'insecure' }
  | { kind: 'hub-error'; error: unknown }
  | { kind: 'wrong-hub' }
  | { kind: 'form' }
  | { kind: 'waiting'; record: JoinRecord; offline: boolean }
  | { kind: 'mismatch' }
  | { kind: 'approved'; deviceId: string | null }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'failed'; error: unknown };

/** The browser's install prompt (Chromium), kept until the user asks for it. */
interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: string }>;
}

export interface JoinPageProps {
  fetchImpl?: typeof fetch;
  store?: JoinStore;
  /** Defaults to the page's address. */
  search?: string;
  hash?: string;
  userAgent?: string;
  /** Tests: the poll clock and waits. */
  poll?: Pick<PollDeps, 'now' | 'wait' | 'minGapMs'>;
}

/** A refusal of `add/complete` or the status poll, in plain words. */
export function joinErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return errorMessage(err, 'Something went wrong.');
  const d = err.body.details ?? {};
  const reason = typeof d.reason === 'string' ? d.reason : null;
  switch (reason ?? err.body.code) {
    case 'wrong_code': {
      const left = typeof d.attemptsLeft === 'number' ? d.attemptsLeft : null;
      if (left === 0)
        return 'That code is not right, and the Hub stopped accepting it. Ask for a new code on the Hub.';
      return left === null
        ? 'That code is not right. Check it on the Hub.'
        : `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`;
    }
    case 'expired':
    case 'request_expired':
      return 'This code has expired or was already used. Ask for a new code on the Hub.';
    case 'kind_not_allowed':
      return 'This code is for a compute node or a Wake helper. Run the install command shown on the Hub on that computer instead.';
    case 'key_revoked':
      return 'This device was revoked on the Hub. Ask the owner to add it again.';
    case 'key_in_use':
      return 'This device is already added. Start over to add it with a new key.';
    case 'add_device_disabled':
      return 'Adding devices is turned off on this Hub.';
    case 'address_rate_limited':
    case 'rate_limited':
      return 'Too many tries from this network. Wait a minute and try again.';
    case 'bad_signature':
    case 'missing_proof':
      return 'The Hub did not accept this device’s signature. Start over.';
    case 'bad_reveal':
      return 'The Hub refused this device’s answer, so the request was dropped. Ask for a new code on the Hub.';
    case 'already_revealed':
      return 'This request was already answered. Ask for a new code on the Hub and start over.';
    default:
      return errorMessage(err, 'Something went wrong.');
  }
}

/** Errors after which the code in the link cannot work any more. */
/** Web Crypto (`crypto.subtle`) is there: a secure context (HTTPS, or this computer itself). */
export function secureCrypto(): boolean {
  return window.isSecureContext !== false && typeof globalThis.crypto?.subtle === 'object';
}

function codeIsGone(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  const d = err.body.details ?? {};
  return (
    err.status === 410 ||
    (d.reason === 'wrong_code' && d.attemptsLeft === 0) ||
    d.reason === 'kind_not_allowed'
  );
}

export function JoinPage({
  fetchImpl,
  store: givenStore,
  search,
  hash,
  userAgent,
  poll,
}: JoinPageProps) {
  const [client] = useState<JoinClient>(() => joinClient(fetchImpl));
  const [pollOpts] = useState(poll);
  const [store] = useState<JoinStore>(() => givenStore ?? browserJoinStore());
  const [params] = useState<JoinParams>(() =>
    readJoinParams(search ?? window.location.search, hash ?? window.location.hash),
  );
  const [platform] = useState<JoinPlatform>(() =>
    detectPlatform(userAgent ?? navigator.userAgent, navigator.maxTouchPoints || 0),
  );
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const [hub, setHub] = useState<{ fingerprint: string; publicKey: string | null }>({
    fingerprint: '',
    publicKey: null,
  });
  // The pairing a typed code belongs to: the link's, until the link's code stops working.
  const [pairingId, setPairingId] = useState(params.pairingId);
  const [linkCode, setLinkCode] = useState(params.code);
  const [codeText, setCodeText] = useState('');
  const [name, setName] = useState(platform.name);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(
    params.badCode ? 'The code in the link is not valid. Type the code shown on the Hub.' : null,
  );
  const [codeError, setCodeError] = useState<string | null>(null);
  const [install, setInstall] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** A commit that was not revealed yet (its code is used up), to reveal again on retry. */
  const committed = useRef<{
    code: string;
    keys: CryptoKeyPair;
    publicKey: string;
    deviceNonce: string;
    answer: JoinCommitted;
    /** The Hub's clock minus this device's, from the Date header. */
    offset: number;
  } | null>(null);
  const formId = useId();

  // The code leaves the address bar (and the history entry) at once.
  useEffect(() => {
    if (window.location.hash && hash === undefined)
      history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [hash]);

  useEffect(() => {
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
    applyTheme(resolveTheme(readCachedTheme(), dark), document.documentElement);
  }, []);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstall(e as InstallPrompt);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  // Resume a request this browser is waiting on, else check the Hub.
  useEffect(() => {
    let alive = true;
    void (async () => {
      // The device key and the checks need Web Crypto, which browsers give only to a secure
      // connection (HTTPS, or this computer itself): say that, rather than failing the pin check.
      if (!secureCrypto()) {
        setPhase({ kind: 'insecure' });
        return;
      }
      const saved = await store.load().catch(() => null);
      if (!alive) return;
      if (saved) {
        const same = !params.pairingId || saved.pairingId === params.pairingId;
        if (same && Date.parse(saved.expiresAt) > Date.now()) {
          setPhase({ kind: 'waiting', record: saved, offline: false });
          return;
        }
        await store.clear().catch(() => undefined);
      }
      try {
        const { body } = await client.hello();
        const fingerprint = body.hubFingerprint ?? null;
        const publicKey = body.hubPublicKey ?? null;
        // With a pin, the Hub's key must hash to it (and the Hub must say the same).
        const pinned =
          !params.fingerprint ||
          (publicKey !== null &&
            fingerprint === params.fingerprint &&
            (await keyFingerprint(publicKey).catch(() => null)) === params.fingerprint);
        if (!alive) return;
        if (!pinned) {
          setPhase({ kind: 'wrong-hub' });
          return;
        }
        setHub({ fingerprint: fingerprint ?? '', publicKey });
        setPhase({ kind: 'form' });
      } catch (error) {
        if (alive) setPhase({ kind: 'hub-error', error });
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, store, params, attempt]);

  // Poll while waiting for the owner.
  const waitingRecord = phase.kind === 'waiting' ? phase.record : null;
  useEffect(() => {
    if (!waitingRecord) return;
    const record = waitingRecord;
    const ctl = new AbortController();
    void pollStatus(
      {
        ...pollOpts,
        lastTime: record.lastTime,
        poll: async (time) =>
          client.status(
            record.requestId,
            time,
            await signStatus(record.keys.privateKey, record.requestId, time),
          ),
        onProgress: ({ offline }) =>
          setPhase((p) => (p.kind === 'waiting' && p.offline !== offline ? { ...p, offline } : p)),
      },
      ctl.signal,
    ).then(async (out) => {
      if (out.status === 'stopped' || ctl.signal.aborted) return;
      await store.clear().catch(() => undefined);
      if (out.status === 'approved') {
        const deviceId = out.view.deviceId ?? null;
        if (deviceId) rememberThisDevice(deviceId);
        setPhase({ kind: 'approved', deviceId });
      } else if (out.status === 'failed') setPhase({ kind: 'failed', error: out.error });
      else setPhase({ kind: out.status });
    });
    return () => ctl.abort();
  }, [waitingRecord, client, store, pollOpts]);

  useEffect(() => {
    if (phase.kind !== 'form' && phase.kind !== 'checking') headingRef.current?.focus();
  }, [phase.kind]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const code = linkCode ?? normalizePairingCode(codeText);
    if (!code) {
      setCodeError('Enter the 8-character code shown on the Hub, like ABCD-EFGH.');
      return;
    }
    const deviceName = name.trim();
    if (!deviceName) return;
    setCodeError(null);
    setFormError(null);
    setBusy(true);
    try {
      // A commit whose reveal did not get through is revealed again (the code is used up).
      let c = committed.current;
      if (!c || c.code !== code) {
        const keys = await generateDeviceKey();
        const publicKey = await exportPublicKey(keys.publicKey);
        const deviceNonce = randomNonce();
        const answer = await client.complete({
          ...(pairingId ? { pairingId } : {}),
          code: displayPairingCode(code),
          publicKey,
          name: deviceName,
          platform: platform.platform,
          kind: 'browser',
          commitment: await commitment(publicKey, deviceNonce),
        });
        const offset = answer.hubTime === null ? 0 : answer.hubTime - Date.now();
        c = { code, keys, publicKey, deviceNonce, answer: answer.body, offset };
        committed.current = c;
      }
      const commit = c.answer;
      let time = Math.floor((Date.now() + c.offset) / 1000);
      let revealed;
      try {
        revealed = await client.reveal(
          commit.requestId,
          c.deviceNonce,
          time,
          await signReveal(c.keys.privateKey, commit.requestId, time),
        );
      } catch (err) {
        // Without an answer (or when rate-limited) the reveal can be sent again; any other
        // refusal ends this request.
        if (err instanceof ApiError && err.status !== 429) {
          committed.current = null;
          setPhase({ kind: 'failed', error: err });
          return;
        }
        throw err;
      }
      committed.current = null;
      const rev = revealed.body;
      time = Math.max(time, Math.floor((revealed.hubTime ?? Date.now()) / 1000));
      const mine = await pairingConfirmationV2({
        hubFingerprint: hub.fingerprint,
        pairingId: commit.pairingId,
        publicKey: c.publicKey,
        code,
        deviceNonce: c.deviceNonce,
        hubNonce: commit.hubNonce,
      });
      if (params.fingerprint) {
        const signed =
          hub.publicKey !== null &&
          rev.hubSignature !== null &&
          (await verifyText(
            hub.publicKey,
            hubRevealStatement({
              requestId: commit.requestId,
              pairingId: commit.pairingId,
              publicKey: c.publicKey,
              confirmation: rev.confirmation,
            }),
            rev.hubSignature,
          ));
        if (!signed) {
          setPhase({ kind: 'wrong-hub' });
          return;
        }
      }
      if (mine !== rev.confirmation) {
        setPhase({ kind: 'mismatch' });
        return;
      }
      // The Hub waits up to 10 minutes for the owner; keep at least that long for a reload.
      const tenMinutes = new Date(Date.now() + 10 * 60_000).toISOString();
      const record: JoinRecord = {
        pairingId: commit.pairingId,
        requestId: commit.requestId,
        confirmation: rev.confirmation,
        expiresAt: commit.expiresAt > tenMinutes ? commit.expiresAt : tenMinutes,
        name: deviceName,
        keys: c.keys,
        lastTime: time,
      };
      await store.save(record).catch(() => undefined);
      setPhase({ kind: 'waiting', record, offline: false });
    } catch (err) {
      setFormError(joinErrorMessage(err));
      if (codeIsGone(err)) {
        // A new code belongs to a new pairing, which the person types.
        setLinkCode(null);
        setPairingId(null);
        setCodeText('');
      }
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    committed.current = null;
    void store.clear().catch(() => undefined);
    history.replaceState(null, '', JOIN_PATH);
    setLinkCode(null);
    setPairingId(null);
    setCodeText('');
    setFormError(null);
    setPhase({ kind: 'form' });
  };

  const way = installWay(platform, install !== null);
  const promptInstall = async () => {
    if (!install) return;
    await install.prompt();
    const choice = await install.userChoice?.catch(() => null);
    setInstall(null);
    if (choice?.outcome === 'accepted') setInstalled(true);
  };

  return (
    <div className="shell join">
      <header className="topbar">
        <span className="brand">Nova</span>
      </header>
      <main className="main" id="main">
        <section className="panel join-panel" aria-labelledby={`${formId}-h`}>
          {phase.kind === 'checking' ? (
            <>
              <h1 id={`${formId}-h`}>Add this device</h1>
              <Spinner label="Checking the Hub" />
            </>
          ) : null}

          {phase.kind === 'insecure' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                This page needs a secure connection
              </h1>
              <div role="alert" className="stack">
                <p className="join-flush">
                  This device opened the Hub over plain HTTP at a network address. Browsers allow
                  the keys this step needs only on a secure connection, so this device cannot ask to
                  join from here. Nothing was sent to the Hub.
                </p>
                <p className="muted join-flush">
                  On the Hub, open Network → Trust and turn on the Hub&apos;s own certificate
                  (HTTPS), install its root certificate on this device, then open the link or scan
                  the QR code again. Or add this device with the Nova app.
                </p>
              </div>
            </>
          ) : null}

          {phase.kind === 'hub-error' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                Cannot reach the Hub
              </h1>
              <div role="alert" className="stack">
                <p className="muted join-flush">
                  {errorMessage(phase.error, 'The Hub did not answer.')}
                </p>
                <div className="row">
                  <Button
                    onClick={() => {
                      setPhase({ kind: 'checking' });
                      setAttempt((n) => n + 1);
                    }}
                  >
                    Retry
                  </Button>
                </div>
              </div>
            </>
          ) : null}

          {phase.kind === 'wrong-hub' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                <Icon name="alert" /> This is not your Hub
              </h1>
              <div role="alert" className="join-stop stack">
                <p className="join-flush">
                  This page cannot prove it is the Hub that made the code. Someone may be in the
                  middle, so this device stops here. Do not approve a request from it on the Hub.
                </p>
                <p className="muted join-flush">
                  Open the link or scan the QR code again on a network you trust, or ask the owner
                  for a new code.
                </p>
              </div>
            </>
          ) : null}

          {phase.kind === 'form' ? (
            <>
              <h1 id={`${formId}-h`}>Add this device</h1>
              <p className="muted join-flush">
                This asks the Hub to add this device. Nothing is shared until the owner approves it
                on the Hub.
              </p>
              <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
                {linkCode ? (
                  <p className="join-flush">
                    Code from the link:{' '}
                    <code className="join-code">{displayPairingCode(linkCode)}</code>
                  </p>
                ) : (
                  <TextField
                    label="Code shown on the Hub"
                    hint="8 letters and digits, like ABCD-EFGH"
                    value={codeText}
                    onChange={(e) => setCodeText(e.target.value)}
                    autoComplete="one-time-code"
                    autoCapitalize="characters"
                    spellCheck={false}
                    maxLength={20}
                    className="join-code-input"
                    error={codeError ?? undefined}
                  />
                )}
                <TextField
                  label="Name for this device"
                  hint="How it shows on the Hub. The owner can change it."
                  value={name}
                  maxLength={100}
                  onChange={(e) => setName(e.target.value)}
                  error={name.trim() ? undefined : 'Enter a name.'}
                />
                {formError ? (
                  <p role="alert" className="nv-field-error join-flush">
                    {formError}
                  </p>
                ) : null}
                <div className="row">
                  <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
                    {busy ? <Spinner /> : null} Ask to join
                  </Button>
                </div>
              </form>
            </>
          ) : null}

          {phase.kind === 'waiting' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                Approve on the Hub
              </h1>
              <p className="join-flush">
                On the Hub, type this code to approve {phase.record.name}. Check that it is the same
                on both screens.
              </p>
              <p className="join-confirmation">{displayConfirmation(phase.record.confirmation)}</p>
              <div className="join-waiting" role="status">
                {phase.offline ? (
                  <>
                    <Icon name="alert" />
                    <span>Cannot reach the Hub. Trying again…</span>
                  </>
                ) : (
                  <>
                    <Spinner />
                    <span>Waiting for the owner to approve this device.</span>
                  </>
                )}
              </div>
              <div className="row">
                <Button variant="ghost" onClick={startOver}>
                  Start over
                </Button>
              </div>
            </>
          ) : null}

          {phase.kind === 'mismatch' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                <Icon name="alert" /> The codes do not match
              </h1>
              <div role="alert" className="join-stop stack">
                <p className="join-flush">
                  The Hub answered with a different code than this device worked out. Something
                  between this device and the Hub may have changed the request, so this device stops
                  here.
                </p>
                <p className="muted join-flush">
                  Do not approve this request on the Hub. Ask for a new code and try again on a
                  network you trust.
                </p>
              </div>
              <div className="row">
                <Button onClick={startOver}>Start over</Button>
              </div>
            </>
          ) : null}

          {phase.kind === 'approved' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1} className="join-done">
                <Icon name="check" /> This device is added
              </h1>
              <p className="join-flush">You are signed in to Nova here.</p>
              <div className="row">
                <Button variant="primary" onClick={() => pageNav.assign('/')}>
                  Open Nova
                </Button>
              </div>
              <section className="join-install stack" aria-labelledby={`${formId}-install`}>
                <h2 id={`${formId}-install`}>Install the app</h2>
                {installed ? (
                  <p className="join-flush">Nova is installed. Open it from your apps.</p>
                ) : way === 'ios-share' ? (
                  <p className="join-flush">
                    Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. Nova then
                    opens like an app.
                  </p>
                ) : way === 'prompt' ? (
                  <>
                    <p className="join-flush">Install Nova to open it like an app.</p>
                    <div className="row">
                      <Button onClick={() => void promptInstall()}>
                        <Icon name="download" /> Install Nova
                      </Button>
                    </div>
                  </>
                ) : way === 'menu' ? (
                  <p className="join-flush">
                    Use <strong>Install app</strong> or <strong>Add to Home screen</strong> in your
                    browser’s menu, or keep using Nova in the browser.
                  </p>
                ) : (
                  <p className="join-flush">
                    This browser cannot install Nova as an app. Open it in the browser and bookmark
                    it.
                  </p>
                )}
              </section>
            </>
          ) : null}

          {phase.kind === 'denied' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                Not approved
              </h1>
              <p role="alert" className="join-flush">
                The owner denied this device on the Hub. It was not added.
              </p>
              <div className="row">
                <Button onClick={startOver}>Use a new code</Button>
              </div>
            </>
          ) : null}

          {phase.kind === 'expired' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                The request expired
              </h1>
              <p role="alert" className="join-flush">
                It was not approved in time. Ask for a new code on the Hub, then try again.
              </p>
              <div className="row">
                <Button onClick={startOver}>Use a new code</Button>
              </div>
            </>
          ) : null}

          {phase.kind === 'failed' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                This device was not added
              </h1>
              <p role="alert" className="join-flush">
                {joinErrorMessage(phase.error)}
              </p>
              <div className="row">
                <Button onClick={startOver}>Start over</Button>
              </div>
            </>
          ) : null}
        </section>
      </main>
    </div>
  );
}
