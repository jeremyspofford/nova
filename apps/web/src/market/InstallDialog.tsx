// Install or update a marketplace item (FR-049; docs/14 §5, docs/08 §3.2 and §7, docs/26 §3): the
// Hub fetches and checks the item first (`POST /market/preview`), and the dialog shows its verdict
// (Verified, or Unverified and why), what it can do read from the item itself, the permission diff
// of an update (added, changed and removed), what it brings (a plugin's skills, servers, roles,
// app screens and hooks to trust; a theme's colors; a pet's states; an MCP server's settings) and
// whether policy refuses it. Nothing is installed until Install. An Unverified item needs the
// explicit sideload confirmation, an update that adds or changes permissions needs them accepted
// (the diff's hash goes back to the Hub; changed lines are worded part by part, sensitive ones
// marked), and an extension update by another publisher needs the new publisher accepted (its
// stored secrets and data are cleared). Who signed is named only for a key the owner trusts;
// otherwise its fingerprint and "not trusted". A refusal stays in the dialog in plain words.
import { useEffect, useId, useState, type ReactNode } from 'react';
import type {
  BundleConfigField,
  MarketInstallView,
  MarketItemKind,
  MarketPermissionLine,
  MarketPreview,
} from '@nova/shared';
import { Button, Dialog, Icon, Spinner, TextField } from '@nova/ui';
import { VerifiedBadge } from '../settings/badges.tsx';
import { configValues, initialConfig, type ConfigDraft } from '../settings/BundleInstall.tsx';
import { rich } from '../i18n/rich.tsx';
import { HOOK_EVENT_TEXT } from '../settings/plugin-text.ts';
import { checkTheme } from '../settings/theme-file.ts';
import { useSettings } from '../settings.tsx';
import type { MarketApi } from './api-m8.ts';
import {
  BLOCKED_TEXT,
  INSTALL_TEXT,
  KIND_TEXT,
  PERMISSION_ICON,
  UNVERIFIED_TEXT,
  entryPointText,
  marketErrorMessage,
  marketPublisherText,
  permissionDetail,
  vouchText,
} from './format.ts';
import { ChangedPermission, PublisherChangeNotice } from './Changes.tsx';
import { ManagedNote } from '../managed/ManagedNote.tsx';

export interface InstallTarget {
  catalogId: string;
  kind: MarketItemKind;
  id: string;
  name: string;
}

export function MarketPermissions({
  lines,
  label,
}: {
  lines: readonly MarketPermissionLine[];
  label: string;
}) {
  if (lines.length === 0) return <p className="muted">{INSTALL_TEXT.none}</p>;
  return (
    <ul className="market-perms" aria-label={label}>
      {lines.map((l) => (
        <li key={l.key}>
          <Icon name={PERMISSION_ICON[l.kind]} />
          <span>
            {l.text}
            {l.detail ? <span className="muted"> ({permissionDetail(l)})</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function InstallDialog({
  market,
  target,
  onClose,
  onInstalled,
}: {
  market: MarketApi;
  target: InstallTarget;
  onClose: () => void;
  onInstalled: (view: MarketInstallView, update: boolean) => void;
}) {
  const [preview, setPreview] = useState<MarketPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    market
      .previewMarketItem({ catalogId: target.catalogId, kind: target.kind, id: target.id })
      .then(
        (p) => {
          if (!alive) return;
          setPreview(p);
          setLoadError(null);
        },
        (err: unknown) =>
          alive && setLoadError(marketErrorMessage(err, INSTALL_TEXT.previewFailed)),
      );
    return () => {
      alive = false;
    };
  }, [market, target.catalogId, target.kind, target.id, attempt]);

  if (!preview)
    return (
      <Dialog
        open
        title={INSTALL_TEXT.checkingTitle({ name: target.name })}
        onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>{INSTALL_TEXT.cancel}</Button>
            {loadError ? (
              <Button onClick={() => setAttempt((n) => n + 1)}>{INSTALL_TEXT.retry}</Button>
            ) : null}
          </>
        }
      >
        {loadError ? (
          <p role="alert" className="nv-field-error">
            {loadError}
          </p>
        ) : (
          <Spinner label={INSTALL_TEXT.checking} />
        )}
      </Dialog>
    );
  return (
    <PreviewDialog market={market} preview={preview} onClose={onClose} onInstalled={onInstalled} />
  );
}

interface HookRow {
  id: string;
  event: string;
  matcher: string | null;
  contentHash: string;
  runs: string | null;
  timeoutMs: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A plugin preview's hooks (the plugins area's HookView shape), defensively. */
function hookRows(details: Record<string, unknown>): HookRow[] {
  return list(details.hooks).flatMap((h) => {
    if (!isRecord(h) || !str(h.id) || !str(h.contentHash)) return [];
    const handler = isRecord(h.handler) ? h.handler : null;
    const runs =
      handler?.type === 'command' && Array.isArray(handler.command)
        ? handler.command.map(String).join(' ')
        : str(handler?.tool);
    return [
      {
        id: str(h.id)!,
        event: str(h.event) ?? '',
        matcher: str(h.matcher),
        contentHash: str(h.contentHash)!,
        runs,
        timeoutMs: typeof h.timeoutMs === 'number' ? h.timeoutMs : null,
      },
    ];
  });
}

const eventText = (event: string) =>
  (HOOK_EVENT_TEXT as Record<string, string | undefined>)[event] ?? event;

function PreviewDialog({
  market,
  preview: p,
  onClose,
  onInstalled,
}: {
  market: MarketApi;
  preview: MarketPreview;
  onClose: () => void;
  onInstalled: (view: MarketInstallView, update: boolean) => void;
}) {
  const settings = useSettings();
  const kindsLocked = settings.get('market.allowedKinds').locked;
  const [sideload, setSideload] = useState(false);
  const [accept, setAccept] = useState(false);
  const [newPublisher, setNewPublisher] = useState(false);
  const [enable, setEnable] = useState(true);
  const [trust, setTrust] = useState<Set<string>>(() => new Set());
  const fields: BundleConfigField[] =
    p.kind === 'mcp' ? (list(p.details.userConfig) as BundleConfigField[]) : [];
  const [draft, setDraft] = useState<ConfigDraft>(() => initialConfig(fields));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = p.replaces !== null;
  const unverified = p.verification.status === 'unverified';
  const hooks = p.kind === 'plugin' ? hookRows(p.details) : [];
  const blocked =
    !p.allowed ||
    (p.requires.sideloadConfirmation && !sideload) ||
    (p.requires.permissionAcceptance && !accept) ||
    (p.requires.publisherChangeAcceptance && !newPublisher);

  const install = async () => {
    let userConfig: Record<string, unknown> | undefined;
    if (fields.length) {
      const out = configValues(fields, draft);
      if ('errors' in out) {
        setFieldErrors(out.errors);
        return;
      }
      setFieldErrors({});
      userConfig = out.values;
    }
    setBusy(true);
    setError(null);
    try {
      const view = await market.installMarketItem({
        previewId: p.previewId,
        ...(p.requires.sideloadConfirmation ? { confirmSideload: sideload } : {}),
        ...(p.requires.permissionAcceptance && p.diff ? { acceptPermissions: p.diff.hash } : {}),
        ...(p.requires.publisherChangeAcceptance ? { acceptPublisherChange: newPublisher } : {}),
        enable,
        ...(hooks.length
          ? {
              trustHooks: hooks
                .filter((h) => trust.has(h.id))
                .map((h) => ({ id: h.id, contentHash: h.contentHash })),
            }
          : {}),
        ...(userConfig ? { userConfig } : {}),
      });
      onInstalled(view, update);
    } catch (err) {
      setBusy(false);
      setError(marketErrorMessage(err, INSTALL_TEXT.failed));
    }
  };

  const publisher = p.verification.publisher;
  return (
    <Dialog
      open
      title={
        update
          ? INSTALL_TEXT.update({ name: p.name, version: p.version })
          : INSTALL_TEXT.install({ name: p.name, version: p.version })
      }
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>{INSTALL_TEXT.cancel}</Button>
          <Button variant="primary" disabled={busy || blocked} onClick={() => void install()}>
            {busy ? <Spinner /> : null}{' '}
            {update ? INSTALL_TEXT.updateButton : INSTALL_TEXT.installButton}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="ws-row-meta">
          <VerifiedBadge verified={!unverified} />
          <span>{KIND_TEXT[p.kind].one}</span>
          <code className="ws-code-inline">{p.id}</code>
          {p.replaces ? (
            <span className="muted">{INSTALL_TEXT.replaces({ version: p.replaces.version })}</span>
          ) : null}
        </p>
        {p.verification.vouchedBy ? (
          // Who vouches, by name: the catalog, and a bundle's own trusted publisher.
          vouchText(p.verification.vouchedBy).map((t) => (
            <p key={t} className="muted market-vouch">
              {t}
            </p>
          ))
        ) : publisher ? (
          <p className="muted">{marketPublisherText(publisher)}</p>
        ) : null}
        {p.publisherChange ? (
          <PublisherChangeNotice
            change={p.publisherChange}
            accepted={newPublisher}
            onAccept={setNewPublisher}
          />
        ) : null}

        {!p.allowed && p.blockedBy ? (
          <div className="ws-callout" role="note" data-tone="blocked">
            <Icon name="stop" />
            <div className="stack">
              <p>
                <strong>{INSTALL_TEXT.blocked}</strong> {BLOCKED_TEXT[p.blockedBy]}
              </p>
              {p.blockedBy === 'managed' ? (
                <ManagedNote setting="restrict.unverifiedInstalls" />
              ) : p.blockedBy === 'kind_not_allowed' && kindsLocked ? (
                <ManagedNote setting="market.allowedKinds" />
              ) : null}
            </div>
          </div>
        ) : null}

        {unverified ? (
          <div className="ws-callout" role="note">
            <Icon name="alert" />
            <div className="stack">
              <p>
                <strong>{INSTALL_TEXT.unverifiedTitle}</strong> {INSTALL_TEXT.unverifiedBody}
              </p>
              {p.verification.reasons.length ? (
                <ul className="ws-plain-list" aria-label={INSTALL_TEXT.why}>
                  {p.verification.reasons.map((r) => (
                    <li key={r}>{UNVERIFIED_TEXT[r]}</li>
                  ))}
                </ul>
              ) : null}
              {p.allowed ? (
                <label className="ws-check">
                  <input
                    type="checkbox"
                    checked={sideload}
                    onChange={(e) => setSideload(e.target.checked)}
                  />
                  <span>{INSTALL_TEXT.sideload}</span>
                </label>
              ) : null}
            </div>
          </div>
        ) : null}

        {p.warnings.length ? (
          <ul className="ws-plain-list" aria-label={INSTALL_TEXT.warnings}>
            {p.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}

        {p.diff ? (
          <section aria-labelledby="market-diff">
            <h3 id="market-diff" className="ws-subhead">
              {INSTALL_TEXT.diff}
            </h3>
            {p.diff.added.length || p.diff.removed.length || p.diff.changed.length ? (
              <ul className="ws-plain-list">
                {p.diff.added.map((l) => (
                  <li key={`+${l.key}`}>
                    <strong>{INSTALL_TEXT.diffAdded}:</strong> {l.text}
                  </li>
                ))}
                {p.diff.changed.map((c) => (
                  <ChangedPermission
                    key={`~${c.key}`}
                    change={c}
                    kind={p.permissions.find((l) => l.key === c.key)?.kind}
                    label={INSTALL_TEXT.diffChanged}
                  />
                ))}
                {p.diff.removed.map((l) => (
                  <li key={`-${l.key}`}>
                    {INSTALL_TEXT.diffRemoved}: {l.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{INSTALL_TEXT.diffNone}</p>
            )}
            {p.requires.permissionAcceptance ? (
              <label className="ws-check">
                <input
                  type="checkbox"
                  checked={accept}
                  onChange={(e) => setAccept(e.target.checked)}
                />
                <span>{INSTALL_TEXT.acceptDiff}</span>
              </label>
            ) : p.diff.removed.length && !p.diff.added.length && !p.diff.changed.length ? (
              <p className="muted">{INSTALL_TEXT.diffOnlyRemoved}</p>
            ) : null}
          </section>
        ) : null}

        <section aria-labelledby="market-can">
          <h3 id="market-can" className="ws-subhead">
            {INSTALL_TEXT.can}
          </h3>
          <MarketPermissions lines={p.permissions} label={INSTALL_TEXT.can} />
          <p className="muted">{INSTALL_TEXT.enforced}</p>
        </section>

        <KindDetails preview={p} />

        {hooks.length ? (
          <section aria-labelledby="market-hooks">
            <h3 id="market-hooks" className="ws-subhead">
              {INSTALL_TEXT.hooks}
            </h3>
            <p className="muted">{INSTALL_TEXT.hooksHint}</p>
            <ul className="ws-list">
              {hooks.map((h) => (
                <li
                  key={h.id}
                  className="ws-list-row"
                  aria-label={INSTALL_TEXT.hookRow({ id: h.id })}
                >
                  <dl className="ws-dl">
                    <dt>{INSTALL_TEXT.hookEvent}</dt>
                    <dd>
                      {h.matcher
                        ? rich(INSTALL_TEXT.eventMatches, {
                            event: eventText(h.event),
                            matcher: <code className="ws-code-inline">{h.matcher}</code>,
                          })
                        : eventText(h.event)}
                    </dd>
                    {h.runs ? (
                      <>
                        <dt>{INSTALL_TEXT.hookRuns}</dt>
                        <dd>
                          <code className="ws-code-inline">{h.runs}</code>
                        </dd>
                      </>
                    ) : null}
                    <dt>{INSTALL_TEXT.hookHash}</dt>
                    <dd>
                      <code className="ws-code-inline">{h.contentHash}</code>
                    </dd>
                  </dl>
                  <label className="ws-check">
                    <input
                      type="checkbox"
                      checked={trust.has(h.id)}
                      onChange={(e) =>
                        setTrust((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(h.id);
                          else next.delete(h.id);
                          return next;
                        })
                      }
                    />
                    <span>{INSTALL_TEXT.trustNow({ id: h.id })}</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {fields.length ? (
          <fieldset className="stack market-config">
            <legend>{INSTALL_TEXT.settingsForm}</legend>
            {fields.map((f) =>
              f.type === 'boolean' ? (
                <label key={f.key} className="ws-check">
                  <input
                    type="checkbox"
                    checked={draft[f.key] === true}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.checked }))}
                  />
                  <span>{f.title}</span>
                </label>
              ) : (
                <TextField
                  key={f.key}
                  label={f.required ? INSTALL_TEXT.required({ title: f.title }) : f.title}
                  type={f.sensitive ? 'password' : 'text'}
                  autoComplete="off"
                  hint={f.description ?? undefined}
                  error={fieldErrors[f.key]}
                  value={typeof draft[f.key] === 'string' ? (draft[f.key] as string) : ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              ),
            )}
          </fieldset>
        ) : null}

        {p.kind === 'plugin' || p.kind === 'mcp' ? (
          <label className="ws-check">
            <input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} />
            <span>{INSTALL_TEXT.turnOn}</span>
          </label>
        ) : null}
        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** What the item brings, by kind, from the preview's details. */
function KindDetails({ preview: p }: { preview: MarketPreview }) {
  const d = p.details;
  if (p.kind === 'plugin') {
    const skills = list(d.skills).flatMap((s) =>
      isRecord(s) && str(s.name) ? [{ name: str(s.name)!, description: str(s.description) }] : [],
    );
    const servers = list(d.mcpServers).flatMap((s) =>
      isRecord(s) && str(s.name)
        ? [{ name: str(s.name)!, what: str(s.command) ?? str(s.url) ?? '' }]
        : [],
    );
    const roles = list(d.roles).map(String);
    const entries = list(d.uiEntryPoints).flatMap((e) =>
      isRecord(e) ? [entryPointText(str(e.title) ?? str(e.resource) ?? '', str(e.kind) ?? '')] : [],
    );
    return (
      <>
        {skills.length ? (
          <Section title={INSTALL_TEXT.skills}>
            {skills.map((s) => (
              <li key={s.name}>
                <strong>{s.name}</strong>
                {s.description ? `: ${s.description}` : ''}
              </li>
            ))}
          </Section>
        ) : null}
        {servers.length ? (
          <Section title={INSTALL_TEXT.servers}>
            {servers.map((s) => (
              <li key={s.name}>
                <strong>{s.name}</strong> <code className="ws-code-inline">{s.what}</code>
              </li>
            ))}
          </Section>
        ) : null}
        {roles.length ? (
          <Section title={INSTALL_TEXT.roles}>
            {roles.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </Section>
        ) : null}
        {entries.length ? (
          <Section title={INSTALL_TEXT.entryPoints}>
            {entries.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </Section>
        ) : null}
      </>
    );
  }
  if (p.kind === 'theme') {
    const check = checkTheme(d.theme);
    if (!check.ok) return null;
    const keys = ['--u-bg', '--u-surface', '--u-text', '--u-accent'] as const;
    return (
      <section aria-labelledby="market-theme">
        <h3 id="market-theme" className="ws-subhead">
          {INSTALL_TEXT.theme}
        </h3>
        <p className="ws-row-meta">
          <span className="ws-swatches" aria-hidden="true">
            {keys.map((k) =>
              check.theme.tokens[k] ? (
                <span key={k} className="ws-swatch" style={{ background: check.theme.tokens[k] }} />
              ) : null,
            )}
          </span>
          <span dir="auto">{check.theme.name}</span>
          <span className="muted">{INSTALL_TEXT.variant({ variant: check.theme.variant })}</span>
        </p>
      </section>
    );
  }
  if (p.kind === 'pet') {
    const states = list(d.states).map(String);
    return states.length ? (
      <Section title={INSTALL_TEXT.petStates}>
        {states.map((s) => (
          <li key={s}>{INSTALL_TEXT.petState({ state: s })}</li>
        ))}
      </Section>
    ) : null;
  }
  if (p.kind === 'skill') {
    const tools = list(d.allowedTools).map(String);
    return (
      <>
        {str(d.description) ? <p>{str(d.description)}</p> : null}
        {tools.length ? (
          <Section title={INSTALL_TEXT.skillTools}>
            {tools.map((t) => (
              <li key={t}>
                <code className="ws-code-inline">{t}</code>
              </li>
            ))}
          </Section>
        ) : null}
      </>
    );
  }
  // MCP: a registry entry (a remote server) or a bundle.
  if (d.form === 'registry' && str(d.url))
    return (
      <p>{INSTALL_TEXT.serverAt({ transport: str(d.transport) ?? 'http', url: str(d.url)! })}</p>
    );
  return str(d.description) ? <p>{str(d.description)}</p> : null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="ws-subhead">
        {title}
      </h3>
      <ul className="ws-plain-list">{children}</ul>
    </section>
  );
}
