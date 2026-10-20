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
// in the link it asks for the one shown on the Hub. Phone width first. When the QR carries a Relay
// (`r`, `rp`: the owner chose to pair through it), the page pairs through the Relay instead
// (./relay.ts, FR-137): it needs no direct answer from the Hub, shows the same six digits as the
// Hub, waits for the Hub's sealed notice, and keeps the pairing so the app can reach the Hub through
// the Relay from anywhere.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, Icon, Spinner, TextField, applyTheme, resolveTheme } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { readCachedTheme } from '../appearance.ts';
import { embed } from '../settings/embed.tsx';
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
  NoSessionError,
  RouteDroppedError,
  browserRelayJoin,
  relayJoinError,
  relayParams,
  startRelayJoin,
  waitForRelayApproval,
  type PendingJoin,
  type RelayJoinDeps,
} from './relay.ts';
import {
  browserJoinStore,
  pageNav,
  rememberThisDevice,
  type JoinRecord,
  type JoinStore,
} from './store.ts';
import { JOIN_ERROR_TEXT as E, JOIN_TEXT as S } from './strings.ts';
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
  /** The Relay to pair through (`r`, `rp`), when the link names a safe one. */
  relay: { relayUrl: string; relayPairingId: string } | null;
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
    relay: relayParams(q),
  };
}

type Phase =
  | { kind: 'checking' }
  | { kind: 'insecure' }
  | { kind: 'hub-error'; error: unknown }
  | { kind: 'wrong-hub' }
  | { kind: 'form' }
  | { kind: 'waiting'; record: JoinRecord; offline: boolean }
  | { kind: 'relay-waiting'; pending: PendingJoin; offline: boolean }
  | { kind: 'mismatch' }
  | { kind: 'approved'; deviceId: string | null; via: 'direct' | 'relay' }
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
  /** Pairing through the Relay (tests pass fakes). */
  relay?: RelayJoinDeps;
}

/** A refusal of `add/complete` or the status poll, in plain words. */
export function joinErrorMessage(err: unknown): string {
  if (err instanceof NoSessionError || err instanceof RouteDroppedError)
    return relayJoinError(err).message;
  if (!(err instanceof ApiError)) return errorMessage(err, E.generic);
  const d = err.body.details ?? {};
  const reason = typeof d.reason === 'string' ? d.reason : null;
  switch (reason ?? err.body.code) {
    case 'wrong_code': {
      const left = typeof d.attemptsLeft === 'number' ? d.attemptsLeft : null;
      if (left === 0) return E.wrongCodeStopped;
      return left === null ? E.wrongCode : E.wrongCodeLeft({ n: left });
    }
    case 'expired':
    case 'request_expired':
      return E.expired;
    case 'kind_not_allowed':
      return E.kindNotAllowed;
    case 'key_revoked':
      return E.keyRevoked;
    case 'key_in_use':
      return E.keyInUse;
    case 'add_device_disabled':
      return E.disabled;
    case 'address_rate_limited':
    case 'rate_limited':
      return E.rateLimited;
    case 'bad_signature':
    case 'missing_proof':
      return E.badSignature;
    case 'bad_reveal':
      return E.badReveal;
    case 'already_revealed':
      return E.alreadyRevealed;
    default:
      return errorMessage(err, E.generic);
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
  relay,
}: JoinPageProps) {
  const [client] = useState<JoinClient>(() => joinClient(fetchImpl));
  const [relayDeps] = useState<RelayJoinDeps>(() => relay ?? browserRelayJoin());
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
  // The Relay of the link, until its code stops working (a typed code joins directly).
  const [linkRelay, setLinkRelay] = useState(params.relay);
  const [codeText, setCodeText] = useState('');
  const [name, setName] = useState(platform.name);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(params.badCode ? S.badLinkCode : null);
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
      const pendingRelay = await relayDeps.store.loadPending().catch(() => null);
      if (!alive) return;
      if (pendingRelay) {
        const same = !params.pairingId || pendingRelay.join.addPairingId === params.pairingId;
        if (same && Date.parse(pendingRelay.join.expiresAt) > Date.now()) {
          setPhase({ kind: 'relay-waiting', pending: pendingRelay, offline: false });
          return;
        }
        await relayDeps.store.clearPending().catch(() => undefined);
      }
      // Through the Relay the Hub's own address need not answer: the sealed offer carries the
      // Hub's signed key, checked against the pin.
      if (params.relay) {
        setPhase({ kind: 'form' });
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
  }, [client, store, relayDeps, params, attempt]);

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
        setPhase({ kind: 'approved', deviceId, via: 'direct' });
      } else if (out.status === 'failed') setPhase({ kind: 'failed', error: out.error });
      else setPhase({ kind: out.status });
    });
    return () => ctl.abort();
  }, [waitingRecord, client, store, pollOpts]);

  // Through the Relay: wait for the Hub's notice, then fetch the session through the tunnel.
  const relayPending = phase.kind === 'relay-waiting' ? phase.pending : null;
  useEffect(() => {
    if (!relayPending) return;
    const ctl = new AbortController();
    void waitForRelayApproval(relayPending, relayDeps, ctl.signal, {
      ...(pollOpts ? { poll: pollOpts } : {}),
      onOffline: (offline) =>
        setPhase((p) =>
          p.kind === 'relay-waiting' && p.offline !== offline ? { ...p, offline } : p,
        ),
    }).then((out) => {
      if (out.status === 'stopped' || ctl.signal.aborted) return;
      if (out.status === 'approved') {
        if (out.deviceId) rememberThisDevice(out.deviceId);
        setPhase({ kind: 'approved', deviceId: out.deviceId, via: 'relay' });
      } else if (out.status === 'failed') setPhase({ kind: 'failed', error: out.error });
      else setPhase({ kind: out.status });
    });
    return () => ctl.abort();
  }, [relayPending, relayDeps, pollOpts]);

  useEffect(() => {
    if (phase.kind !== 'form' && phase.kind !== 'checking') headingRef.current?.focus();
  }, [phase.kind]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const code = linkCode ?? normalizePairingCode(codeText);
    if (!code) {
      setCodeError(S.enterCode);
      return;
    }
    const deviceName = name.trim();
    if (!deviceName) return;
    setCodeError(null);
    setFormError(null);
    setBusy(true);
    if (linkRelay) {
      try {
        const pending = await startRelayJoin(
          {
            ...linkRelay,
            code,
            name: deviceName,
            platform: platform.platform,
            fingerprint: params.fingerprint,
          },
          relayDeps,
        );
        setPhase({ kind: 'relay-waiting', pending, offline: false });
      } catch (err) {
        const why = relayJoinError(err);
        if (why.wrongHub) setPhase({ kind: 'wrong-hub' });
        else setFormError(why.message);
        if (why.gone) {
          setLinkCode(null);
          setLinkRelay(null);
          setPairingId(null);
          setCodeText('');
        }
      } finally {
        setBusy(false);
      }
      return;
    }
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
    void relayDeps.store.clearPending().catch(() => undefined);
    history.replaceState(null, '', JOIN_PATH);
    setLinkCode(null);
    setLinkRelay(null);
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
              <h1 id={`${formId}-h`}>{S.addThisDevice}</h1>
              <Spinner label={S.checkingHub} />
            </>
          ) : null}

          {phase.kind === 'insecure' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                {S.insecureTitle}
              </h1>
              <div role="alert" className="stack">
                <p className="join-flush">{S.insecureBody}</p>
                <p className="muted join-flush">{S.insecureFix}</p>
              </div>
            </>
          ) : null}

          {phase.kind === 'hub-error' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                {S.cannotReachHub}
              </h1>
              <div role="alert" className="stack">
                <p className="muted join-flush">{errorMessage(phase.error, S.noAnswer)}</p>
                <div className="row">
                  <Button
                    onClick={() => {
                      setPhase({ kind: 'checking' });
                      setAttempt((n) => n + 1);
                    }}
                  >
                    {S.retry}
                  </Button>
                </div>
              </div>
            </>
          ) : null}

          {phase.kind === 'wrong-hub' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                <Icon name="alert" /> {S.wrongHubTitle}
              </h1>
              <div role="alert" className="join-stop stack">
                <p className="join-flush">{S.wrongHubBody}</p>
                <p className="muted join-flush">{S.wrongHubFix}</p>
              </div>
            </>
          ) : null}

          {phase.kind === 'form' ? (
            <>
              <h1 id={`${formId}-h`}>{S.addThisDevice}</h1>
              <p className="muted join-flush">{linkRelay ? S.formIntroRelay : S.formIntro}</p>
              <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
                {linkCode ? (
                  <p className="join-flush">
                    {embed(S.codeFromLink, {
                      code: (
                        <code className="join-code" dir="ltr">
                          {displayPairingCode(linkCode)}
                        </code>
                      ),
                    })}
                  </p>
                ) : (
                  <TextField
                    label={S.codeLabel}
                    hint={S.codeHint}
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
                  label={S.nameLabel}
                  hint={S.nameHint}
                  value={name}
                  maxLength={100}
                  onChange={(e) => setName(e.target.value)}
                  error={name.trim() ? undefined : S.enterName}
                />
                {formError ? (
                  <p role="alert" className="nv-field-error join-flush">
                    {formError}
                  </p>
                ) : null}
                <div className="row">
                  <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
                    {busy ? <Spinner /> : null} {S.askToJoin}
                  </Button>
                </div>
              </form>
            </>
          ) : null}

          {phase.kind === 'waiting' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                {S.approveTitle}
              </h1>
              <p className="join-flush">
                {embed(S.approveBody, { name: <bdi>{phase.record.name}</bdi> })}
              </p>
              <p className="join-confirmation">{displayConfirmation(phase.record.confirmation)}</p>
              <div className="join-waiting" role="status">
                {phase.offline ? (
                  <>
                    <Icon name="alert" />
                    <span>{S.retryingHub}</span>
                  </>
                ) : (
                  <>
                    <Spinner />
                    <span>{S.waiting}</span>
                  </>
                )}
              </div>
              <div className="row">
                <Button variant="ghost" onClick={startOver}>
                  {S.startOver}
                </Button>
              </div>
            </>
          ) : null}

          {phase.kind === 'relay-waiting' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                {S.approveTitle}
              </h1>
              <p className="join-flush">
                {embed(S.approveBody, { name: <bdi>{phase.pending.join.name}</bdi> })}
              </p>
              <p className="join-confirmation">
                {displayConfirmation(phase.pending.join.confirmation)}
              </p>
              <div className="join-waiting" role="status">
                {phase.offline ? (
                  <>
                    <Icon name="alert" />
                    <span>{S.retryingRelay}</span>
                  </>
                ) : (
                  <>
                    <Spinner />
                    <span>{S.waitingRelay}</span>
                  </>
                )}
              </div>
              <div className="row">
                <Button variant="ghost" onClick={startOver}>
                  {S.startOver}
                </Button>
              </div>
            </>
          ) : null}

          {phase.kind === 'mismatch' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                <Icon name="alert" /> {S.mismatchTitle}
              </h1>
              <div role="alert" className="join-stop stack">
                <p className="join-flush">{S.mismatchBody}</p>
                <p className="muted join-flush">{S.mismatchFix}</p>
              </div>
              <div className="row">
                <Button onClick={startOver}>{S.startOver}</Button>
              </div>
            </>
          ) : null}

          {phase.kind === 'approved' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1} className="join-done">
                <Icon name="check" /> {S.addedTitle}
              </h1>
              <p className="join-flush">{phase.via === 'relay' ? S.signedInRelay : S.signedIn}</p>
              <div className="row">
                <Button variant="primary" onClick={() => pageNav.assign('/')}>
                  {S.openNova}
                </Button>
              </div>
              <section className="join-install stack" aria-labelledby={`${formId}-install`}>
                <h2 id={`${formId}-install`}>{S.installTitle}</h2>
                {installed ? (
                  <p className="join-flush">{S.installed}</p>
                ) : way === 'ios-share' ? (
                  <p className="join-flush">
                    {embed(S.iosSteps, {
                      share: <strong>{S.iosShare}</strong>,
                      add: <strong>{S.iosAdd}</strong>,
                    })}
                  </p>
                ) : way === 'prompt' ? (
                  <>
                    <p className="join-flush">{S.promptIntro}</p>
                    <div className="row">
                      <Button onClick={() => void promptInstall()}>
                        <Icon name="download" /> {S.installNova}
                      </Button>
                    </div>
                  </>
                ) : way === 'menu' ? (
                  <p className="join-flush">
                    {embed(S.menuSteps, {
                      install: <strong>{S.menuInstall}</strong>,
                      add: <strong>{S.menuAdd}</strong>,
                    })}
                  </p>
                ) : (
                  <p className="join-flush">{S.cannotInstall}</p>
                )}
              </section>
            </>
          ) : null}

          {phase.kind === 'denied' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                {S.deniedTitle}
              </h1>
              <p role="alert" className="join-flush">
                {S.deniedBody}
              </p>
              <div className="row">
                <Button onClick={startOver}>{S.useNewCode}</Button>
              </div>
            </>
          ) : null}

          {phase.kind === 'expired' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                {S.expiredTitle}
              </h1>
              <p role="alert" className="join-flush">
                {S.expiredBody}
              </p>
              <div className="row">
                <Button onClick={startOver}>{S.useNewCode}</Button>
              </div>
            </>
          ) : null}

          {phase.kind === 'failed' ? (
            <>
              <h1 id={`${formId}-h`} ref={headingRef} tabIndex={-1}>
                {S.failedTitle}
              </h1>
              <p role="alert" className="join-flush">
                {joinErrorMessage(phase.error)}
              </p>
              <div className="row">
                <Button onClick={startOver}>{S.startOver}</Button>
              </div>
            </>
          ) : null}
        </section>
      </main>
    </div>
  );
}
