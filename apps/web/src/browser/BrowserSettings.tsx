// Settings → Browser (FR-094, FR-086, FR-096; docs/11 §4, §4.4, §9, docs/12 §8): whether the agent
// browser can run on this Hub, sign-in requests waiting for the user (a notification's
// `/settings/browser?signin=<id>` lands here), the sites the agent may open with a permission level
// each, its own levels for projects and agents (M7: the narrower scope wins) and an optional
// developer-protocol mode, the allow and block lists as plain lists, the saved logins (passwords
// are never shown), and the browser settings. Allowed and blocked sites are one list on the Hub:
// the domain lists edit the same entries. M7.5 (FR-209, FR-096): continuing a blocked site on the
// agent's computer (the switch and the consents, each revocable) and the extension bridge's
// switches (src/browserdevice/FallbackSettings.tsx).
import { useEffect, useId, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import {
  BROWSER_SITE_LEVELS,
  browserSitePatternSchema,
  type BrowserLoginView,
  type BrowserSiteLevel,
  type BrowserSiteView,
  type BrowserStatusView,
} from '@nova/shared';
import { Button, Dialog, Icon, SelectField, Spinner, Switch, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { BrowserDeviceSettings } from '../browserdevice/FallbackSettings.tsx';
import { useLocation } from '../router.ts';
import { sentence } from '../screen/format.ts';
import { useAnnounce } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useBrowserApi } from './api.ts';
import { BROWSER_TEXT, LEVEL_HINT, levelOptions } from './format.ts';
import { PendingSignins } from './PendingSignins.tsx';
import { SiteScopeLevels, useScopeChoices } from './SiteLevels.tsx';
import '../workspace.css';
import './browser.css';

/**
 * Settings → Browser. {site} is a site pattern, {user} a saved username; {reason} is the Hub's
 * own words (English, D9).
 */
export const BROWSER_SETTINGS_TEXT = defineMessages('browser.settings', {
  badPattern: 'Enter a host such as example.com or *.example.com',
  enterHost: 'Enter a host',
  checkFailed: 'Could not check the browser.',
  heading: 'Browser',
  agentBrowser: 'Agent browser',
  intro:
    'Agents use their own browser with a clean profile, separate from yours. Its traffic goes through the network proxy, and it never gets your browser’s cookies or passwords.',
  checking: 'Checking the agent browser',
  ready: 'Ready on this Hub.',
  notAvailable: 'Not available: {reason}',
  signins: 'Sign-in requests',
  noSignins: 'No sign-in requests are waiting.',
  sites: {
    loadFailed: 'Could not load the sites.',
    allowed: '{site} allowed.',
    blocked: '{site} blocked.',
    saveFailed: 'Could not save {site}: {reason}',
    devOn: 'Developer protocol on for {site}.',
    devOff: 'Developer protocol off for {site}.',
    unblocked: '{site} is no longer blocked.',
    removed: '{site} removed. The agent asks again before opening it.',
    removeFailed: 'Could not remove {site}: {reason}',
    heading: 'Sites',
    intro:
      'The agent opens only sites on this list or on the network allow list; a new site asks you first (Allow once, Always allow or Deny). Each allowed site has a level for changes such as clicking a button or sending a form. Blocked sites never open.',
    site: 'Site',
    access: 'Access',
    allow: 'Allow',
    block: 'Block',
    level: 'Level',
    add: 'Add site',
    loading: 'Loading sites',
    allowedHeading: 'Allowed',
    noneAllowed: 'No sites allowed yet. Add one above, or allow one when asked.',
    allowedList: 'Allowed sites',
    levelFor: 'Level for {site}',
    devFor: 'Developer protocol for {site}',
    dev: 'Developer protocol',
    removeOf: 'Remove {site}',
    devOffManaged:
      'Developer protocol is turned off for every site (managed by your organization).',
    devOffBelow: 'Developer protocol is turned off for every site (see Behavior below).',
    blockedHeading: 'Blocked',
    noneBlocked: 'No sites blocked.',
    blockedList: 'Blocked sites',
    unblockOf: 'Unblock {site}',
    unblock: 'Unblock',
    closeLists: 'Close the list editor',
    editLists: 'Edit as lists',
    unblockTitle: 'Unblock {site}?',
    removeTitle: 'Remove {site}?',
    unblockBody: 'The agent may then ask to open it again.',
    removeBody:
      'Its level, its levels for projects and agents, and any “Always allow” answers go too; the agent asks before opening it again.',
    devTitle: 'Turn on developer protocol for {site}?',
    devBody:
      'The agent gets full developer-tools access to this site’s pages: it can run scripts in them and read what they hold. Each use is still checked and recorded, and you can turn it off at any time.',
    turnOn: 'Turn on',
  },
  lists: {
    loadFailed: 'Could not load the lists.',
    saved: 'Site lists saved.',
    saveFailed: 'Could not save the lists: {reason}',
    loading: 'Loading the lists',
    intro:
      'One host per line, such as example.com or *.example.com. A host on both lists is blocked. Sites that stay allowed keep their level.',
    allowed: 'Allowed, one per line',
    blocked: 'Blocked, one per line',
    /** {hosts} lists the lines that are not hosts, as typed. */
    notHost: 'Not a host: {hosts}',
    save: 'Save lists',
  },
  logins: {
    loadFailed: 'Could not load saved logins.',
    deleted: 'Deleted the login for {user} on {site}.',
    deleteFailed: 'Could not delete the login: {reason}',
    heading: 'Saved logins',
    intro:
      'Logins you chose to save when the agent asked you to sign in. Passwords stay in the vault and are never shown; using one again always asks you first.',
    loading: 'Loading saved logins',
    none: 'No saved logins.',
    list: 'Saved logins',
    /** A saved login's name: "sam@example.com on shop.example.com". */
    login: '{user} on {site}',
    passwordSaved: 'Password saved',
    savedAt: 'Saved {when}',
    lastUsed: 'Last used {when}',
    deleteOf: 'Delete the login for {user} on {site}',
    delete: 'Delete',
    deleteTitle: 'Delete the login for {user}?',
    deleteThis: 'Delete this login?',
    deleteBody:
      'The password is removed from the vault. Sessions already signed in stay signed in until they end.',
  },
  behavior: {
    saveFailed: 'Could not save: {reason}',
    heading: 'Behavior',
    cookies: 'Keep the agent browser’s cookies',
    cookiesHint:
      'Sign-ins then last between browser sessions. Off: every session starts signed out.',
    local: 'Allow local and private-network sites',
    localHint:
      'Lets the agent browser open addresses on your network, such as a dev server. Off keeps it to the public web.',
    dev: 'Allow developer protocol per site',
    devHint: 'When off, no site can use developer-protocol mode, even one you turned it on for.',
    max: 'Browsers open at once',
    maxHint: 'More open browsers use more memory on the Hub.',
    keep: 'Keep action screenshots for (days)',
    keepHint: 'Older screenshots are deleted; the actions stay listed.',
    keepRange: 'From {min} to {max} days',
    save: 'Save',
  },
});

/** Why a site pattern is not usable, or null when it is. */
export function patternProblem(raw: string): string | null {
  const r = browserSitePatternSchema.safeParse(raw);
  return r.success ? null : BROWSER_SETTINGS_TEXT.badPattern;
}

/** Lines of a list editor as patterns; the invalid ones are named. */
export function parseList(text: string): { patterns: string[]; invalid: string[] } {
  const patterns: string[] = [];
  const invalid: string[] = [];
  for (const line of text.split(/[\n,]/)) {
    const t = line.trim();
    if (!t) continue;
    const r = browserSitePatternSchema.safeParse(t);
    if (r.success) {
      if (!patterns.includes(r.data)) patterns.push(r.data);
    } else invalid.push(t);
  }
  return { patterns, invalid };
}

function useSignInFocus(): string | null {
  const loc = useLocation();
  const q = loc.indexOf('?');
  return q < 0 ? null : new URLSearchParams(loc.slice(q + 1)).get('signin');
}

export function BrowserSettings() {
  const api = useBrowserApi();
  const focusId = useSignInFocus();
  const [status, setStatus] = useState<BrowserStatusView | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    api.browserStatus().then(
      (s) => {
        if (!alive) return;
        setStatus(s);
        setStatusError(null);
      },
      (err: unknown) =>
        alive && setStatusError(errorMessage(err, BROWSER_SETTINGS_TEXT.checkFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);
  const S = BROWSER_SETTINGS_TEXT;

  return (
    <div className="settings-page brw-settings">
      <h2>{S.heading}</h2>
      <section className="settings-section" aria-labelledby="brw-status">
        <h3 id="brw-status">{S.agentBrowser}</h3>
        <p className="muted">{S.intro}</p>
        {statusError ? (
          <div className="ws-error" role="alert">
            <p>{statusError}</p>
            <Button onClick={() => setAttempt((n) => n + 1)}>{BROWSER_TEXT.retry}</Button>
          </div>
        ) : status === null ? (
          <Spinner label={S.checking} />
        ) : status.available ? (
          <p className="ws-ok">
            <Icon name="check" /> {S.ready}
          </p>
        ) : (
          <p className="ws-warning" role="note">
            <Icon name="alert" /> {S.notAvailable({ reason: sentence(status.detail) })}
          </p>
        )}
      </section>
      <section className="settings-section" aria-labelledby="brw-signins">
        <h3 id="brw-signins">{S.signins}</h3>
        <PendingSignins focusId={focusId} empty={S.noSignins} />
      </section>
      <SitesSection />
      <LoginsSection />
      <BehaviorSection />
      <BrowserDeviceSettings />
    </div>
  );
}

// ---- sites (FR-094) ---------------------------------------------------------------------------

function SitesSection() {
  const api = useBrowserApi();
  const toast = useToast();
  const announce = useAnnounce();
  const settings = useSettings();
  const devSetting = settings.get('browser.devProtocol');
  const [sites, setSites] = useState<BrowserSiteView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pattern, setPattern] = useState('');
  const [access, setAccess] = useState<'allow' | 'block'>('allow');
  const [level, setLevel] = useState<BrowserSiteLevel>('always_ask');
  const [touched, setTouched] = useState(false);
  const [removing, setRemoving] = useState<BrowserSiteView | null>(null);
  const [devAsk, setDevAsk] = useState<BrowserSiteView | null>(null);
  const [editing, setEditing] = useState(false);
  const choices = useScopeChoices();

  useEffect(() => {
    let alive = true;
    api.listBrowserSites().then(
      ({ items }) => {
        if (!alive) return;
        setSites(items);
        setError(null);
      },
      (err: unknown) =>
        alive && setError(errorMessage(err, BROWSER_SETTINGS_TEXT.sites.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  const replace = (v: BrowserSiteView) =>
    setSites((list) => {
      const rest = (list ?? []).filter((s) => s.pattern !== v.pattern);
      return [...rest, v].sort(
        (a, b) => a.access.localeCompare(b.access) || a.pattern.localeCompare(b.pattern),
      );
    });

  const S = BROWSER_SETTINGS_TEXT.sites;
  const problem = pattern.trim() ? patternProblem(pattern) : BROWSER_SETTINGS_TEXT.enterHost;
  const add = async () => {
    setTouched(true);
    if (problem) return;
    try {
      const v = await api.putBrowserSite({
        pattern: pattern.trim(),
        access,
        ...(access === 'allow' ? { level } : {}),
      });
      replace(v);
      setPattern('');
      setTouched(false);
      announce(
        access === 'allow' ? S.allowed({ site: v.pattern }) : S.blocked({ site: v.pattern }),
      );
    } catch (err) {
      toast.show(S.saveFailed({ site: pattern.trim(), reason: sentence(errorMessage(err)) }), {
        tone: 'error',
      });
    }
  };

  const patch = async (
    s: BrowserSiteView,
    body: { level?: BrowserSiteLevel; devProtocol?: boolean },
  ) => {
    try {
      replace(await api.patchBrowserSite(s.pattern, body));
      if (body.devProtocol !== undefined)
        announce(body.devProtocol ? S.devOn({ site: s.pattern }) : S.devOff({ site: s.pattern }));
    } catch (err) {
      toast.show(
        BROWSER_TEXT.changeFailed({ site: s.pattern, reason: sentence(errorMessage(err)) }),
        { tone: 'error' },
      );
      setAttempt((n) => n + 1);
    }
  };

  const remove = async (s: BrowserSiteView) => {
    setRemoving(null);
    try {
      await api.deleteBrowserSite(s.pattern);
      setSites((list) => (list ?? []).filter((x) => x.pattern !== s.pattern));
      toast.show(
        s.access === 'block' ? S.unblocked({ site: s.pattern }) : S.removed({ site: s.pattern }),
        { tone: 'success' },
      );
    } catch (err) {
      toast.show(S.removeFailed({ site: s.pattern, reason: sentence(errorMessage(err)) }), {
        tone: 'error',
      });
      setAttempt((n) => n + 1);
    }
  };

  const allowed = (sites ?? []).filter((s) => s.access === 'allow');
  const blocked = (sites ?? []).filter((s) => s.access === 'block');
  const devOff = !devSetting.value;
  const options = levelOptions(BROWSER_SITE_LEVELS);

  return (
    <section className="settings-section" aria-labelledby="brw-sites">
      <h3 id="brw-sites">{S.heading}</h3>
      <p className="muted">{S.intro}</p>
      <form
        className="ws-toolbar brw-add-site"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <TextField
          label={S.site}
          value={pattern}
          dir="ltr"
          // eslint-disable-next-line nova-i18n/no-literal-ui-text -- example host patterns, not text
          placeholder="example.com, *.example.com"
          autoComplete="off"
          spellCheck={false}
          maxLength={253}
          onChange={(e) => setPattern(e.target.value)}
          error={touched && problem ? problem : undefined}
        />
        <SelectField
          label={S.access}
          value={access}
          onChange={(v) => setAccess(v === 'block' ? 'block' : 'allow')}
          options={[
            { value: 'allow', label: S.allow },
            { value: 'block', label: S.block },
          ]}
        />
        {access === 'allow' ? (
          <SelectField
            label={S.level}
            value={level}
            onChange={(v) => setLevel(v as BrowserSiteLevel)}
            options={options}
          />
        ) : null}
        <Button type="submit" variant="primary">
          <Icon name="plus" /> {S.add}
        </Button>
      </form>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>{BROWSER_TEXT.retry}</Button>
        </div>
      ) : null}
      {sites === null && !error ? <Spinner label={S.loading} /> : null}
      {sites ? (
        <>
          <h4 className="ws-subhead">{S.allowedHeading}</h4>
          {allowed.length === 0 ? (
            <p className="muted">{S.noneAllowed}</p>
          ) : (
            <ul className="ws-list" aria-label={S.allowedList}>
              {allowed.map((s) => {
                const lvl = s.level ?? 'always_ask';
                return (
                  <li key={s.pattern} className="ws-list-row brw-site" aria-label={s.pattern}>
                    <div className="ws-source-main">
                      <code className="ws-code-inline">{s.pattern}</code>
                      <span className="muted ws-row-meta">{LEVEL_HINT[lvl]}</span>
                    </div>
                    <div className="brw-site-controls">
                      <SelectField
                        label={S.levelFor({ site: s.pattern })}
                        hideLabel
                        value={lvl}
                        onChange={(v) => void patch(s, { level: v as BrowserSiteLevel })}
                        options={options}
                      />
                      <span className="brw-dev">
                        <Switch
                          label={S.devFor({ site: s.pattern })}
                          checked={s.devProtocol}
                          disabled={(devOff || devSetting.locked) && !s.devProtocol}
                          onChange={(next) =>
                            next ? setDevAsk(s) : void patch(s, { devProtocol: false })
                          }
                        />
                        <span aria-hidden="true">{S.dev}</span>
                      </span>
                      <Button
                        variant="ghost"
                        onClick={() => setRemoving(s)}
                        aria-label={S.removeOf({ site: s.pattern })}
                      >
                        {BROWSER_TEXT.remove}
                      </Button>
                    </div>
                    <SiteScopeLevels
                      site={s}
                      choices={choices}
                      onChanged={(p, scoped) =>
                        setSites(
                          (list) =>
                            list?.map((x) =>
                              x.pattern === p ? { ...x, scopedLevels: scoped } : x,
                            ) ?? null,
                        )
                      }
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {devOff ? (
            <p className="muted">{devSetting.locked ? S.devOffManaged : S.devOffBelow}</p>
          ) : null}
          <h4 className="ws-subhead">{S.blockedHeading}</h4>
          {blocked.length === 0 ? (
            <p className="muted">{S.noneBlocked}</p>
          ) : (
            <ul className="ws-list" aria-label={S.blockedList}>
              {blocked.map((s) => (
                <li key={s.pattern} className="ws-list-row" aria-label={s.pattern}>
                  <code className="ws-code-inline">{s.pattern}</code>
                  <Button
                    variant="ghost"
                    onClick={() => setRemoving(s)}
                    aria-label={S.unblockOf({ site: s.pattern })}
                  >
                    {S.unblock}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="row">
            <Button aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
              {editing ? S.closeLists : S.editLists}
            </Button>
          </div>
          {editing ? (
            <DomainLists
              onSaved={() => {
                setEditing(false);
                setAttempt((n) => n + 1);
              }}
            />
          ) : null}
        </>
      ) : null}
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={
          removing?.access === 'block'
            ? S.unblockTitle({ site: removing.pattern })
            : S.removeTitle({ site: removing?.pattern ?? '' })
        }
        description={removing?.access === 'block' ? S.unblockBody : S.removeBody}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{BROWSER_TEXT.cancel}</Button>
            <Button variant="danger" onClick={() => removing && void remove(removing)}>
              {removing?.access === 'block' ? S.unblock : BROWSER_TEXT.remove}
            </Button>
          </>
        }
      />
      <Dialog
        open={devAsk !== null}
        onClose={() => setDevAsk(null)}
        title={S.devTitle({ site: devAsk?.pattern ?? '' })}
        description={S.devBody}
        footer={
          <>
            <Button onClick={() => setDevAsk(null)}>{BROWSER_TEXT.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const s = devAsk;
                setDevAsk(null);
                if (s) void patch(s, { devProtocol: true });
              }}
            >
              {S.turnOn}
            </Button>
          </>
        }
      />
    </section>
  );
}

/** The allow and block lists as plain text, one host per line (PUT /browser/domains). */
function DomainLists({ onSaved }: { onSaved: () => void }) {
  const api = useBrowserApi();
  const toast = useToast();
  const allowId = useId();
  const denyId = useId();
  const [allow, setAllow] = useState<string | null>(null);
  const [deny, setDeny] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api.browserDomains().then(
      (d) => {
        if (!alive) return;
        setAllow(d.allow.join('\n'));
        setDeny(d.deny.join('\n'));
      },
      (err: unknown) =>
        alive && setError(errorMessage(err, BROWSER_SETTINGS_TEXT.lists.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const a = parseList(allow ?? '');
  const d = parseList(deny);
  const invalid = [...a.invalid, ...d.invalid];
  const S = BROWSER_SETTINGS_TEXT.lists;

  const save = async () => {
    if (invalid.length) return;
    setSaving(true);
    try {
      await api.setBrowserDomains({ allow: a.patterns, deny: d.patterns });
      toast.show(S.saved, { tone: 'success' });
      onSaved();
    } catch (err) {
      toast.show(S.saveFailed({ reason: sentence(errorMessage(err)) }), { tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (error)
    return (
      <div className="ws-error" role="alert">
        <p>{error}</p>
      </div>
    );
  if (allow === null) return <Spinner label={S.loading} />;
  return (
    <form
      className="brw-lists"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="muted ws-flush">{S.intro}</p>
      <div className="brw-lists-grid">
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={allowId}>
            {S.allowed}
          </label>
          <textarea
            id={allowId}
            className="nv-input ws-textarea"
            dir="ltr"
            value={allow}
            spellCheck={false}
            onChange={(e) => setAllow(e.target.value)}
          />
        </div>
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={denyId}>
            {S.blocked}
          </label>
          <textarea
            id={denyId}
            className="nv-input ws-textarea"
            dir="ltr"
            value={deny}
            spellCheck={false}
            onChange={(e) => setDeny(e.target.value)}
          />
        </div>
      </div>
      {invalid.length ? (
        <p className="ws-warning" role="alert">
          <Icon name="alert" />{' '}
          {S.notHost({ hosts: fmt.list(invalid, { type: 'unit', style: 'short' }) })}
        </p>
      ) : null}
      <div className="row">
        <Button type="submit" variant="primary" disabled={saving || invalid.length > 0}>
          {S.save}
        </Button>
      </div>
    </form>
  );
}

// ---- saved logins (FR-086) --------------------------------------------------------------------

function LoginsSection() {
  const api = useBrowserApi();
  const toast = useToast();
  const [logins, setLogins] = useState<BrowserLoginView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [deleting, setDeleting] = useState<BrowserLoginView | null>(null);

  useEffect(() => {
    let alive = true;
    api.listBrowserLogins().then(
      ({ items }) => {
        if (!alive) return;
        setLogins(items);
        setError(null);
      },
      (err: unknown) =>
        alive && setError(errorMessage(err, BROWSER_SETTINGS_TEXT.logins.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  const S = BROWSER_SETTINGS_TEXT.logins;
  const remove = async (l: BrowserLoginView) => {
    setDeleting(null);
    try {
      await api.deleteBrowserLogin(l.id);
      setLogins((list) => (list ?? []).filter((x) => x.id !== l.id));
      toast.show(S.deleted({ user: l.username, site: l.host }), { tone: 'success' });
    } catch (err) {
      toast.show(S.deleteFailed({ reason: sentence(errorMessage(err)) }), { tone: 'error' });
      setAttempt((n) => n + 1);
    }
  };

  return (
    <section className="settings-section" aria-labelledby="brw-logins">
      <h3 id="brw-logins">{S.heading}</h3>
      <p className="muted">{S.intro}</p>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>{BROWSER_TEXT.retry}</Button>
        </div>
      ) : null}
      {logins === null && !error ? <Spinner label={S.loading} /> : null}
      {logins?.length === 0 ? <p className="muted">{S.none}</p> : null}
      {logins?.length ? (
        <ul className="ws-list" aria-label={S.list}>
          {logins.map((l) => (
            <li
              key={l.id}
              className="ws-list-row"
              aria-label={S.login({ user: l.username, site: l.host })}
            >
              <div className="ws-source-main">
                <strong dir="auto">{l.username}</strong>
                <span className="muted ws-row-meta">
                  <code className="ws-code-inline">{l.host}</code>
                  <span>{S.passwordSaved}</span>
                  <span>{S.savedAt({ when: formatWhen(l.createdAt) })}</span>
                  <span>{S.lastUsed({ when: formatWhen(l.lastUsedAt) })}</span>
                </span>
              </div>
              <Button
                variant="ghost"
                onClick={() => setDeleting(l)}
                aria-label={S.deleteOf({ user: l.username, site: l.host })}
              >
                {S.delete}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={deleting ? S.deleteTitle({ user: deleting.username }) : S.deleteThis}
        description={S.deleteBody}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{BROWSER_TEXT.cancel}</Button>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)}>
              {S.delete}
            </Button>
          </>
        }
      />
    </section>
  );
}

// ---- settings (docs/11 §8-§9) -----------------------------------------------------------------

function BehaviorSection() {
  const settings = useSettings();
  const toast = useToast();
  const cookies = settings.get('browser.persistCookies');
  const local = settings.get('browser.allowLocalSites');
  const dev = settings.get('browser.devProtocol');
  const max = settings.get('browser.maxConcurrent');
  const keep = settings.get('browser.screenshotRetentionDays');
  const [days, setDays] = useState<string | null>(null);
  const S = BROWSER_SETTINGS_TEXT.behavior;
  const fail = (err: unknown) =>
    toast.show(S.saveFailed({ reason: errorMessage(err) }), { tone: 'error' });

  const dayText = days ?? String(keep.value);
  const dayNum = Number(dayText);
  const daysOk = Number.isInteger(dayNum) && dayNum >= 1 && dayNum <= 3_650;

  return (
    <section className="settings-section" aria-labelledby="brw-behavior">
      <h3 id="brw-behavior">{S.heading}</h3>
      <SwitchField
        label={S.cookies}
        description={S.cookiesHint}
        checked={cookies.value}
        locked={cookies.locked}
        onChange={(v) => void settings.set('browser.persistCookies', v).catch(fail)}
      />
      <SwitchField
        label={S.local}
        description={S.localHint}
        checked={local.value}
        locked={local.locked}
        onChange={(v) => void settings.set('browser.allowLocalSites', v).catch(fail)}
      />
      <SwitchField
        label={S.dev}
        description={S.devHint}
        checked={dev.value}
        locked={dev.locked}
        onChange={(v) => void settings.set('browser.devProtocol', v).catch(fail)}
      />
      <SelectField
        label={S.max}
        value={String(max.value)}
        locked={max.locked}
        onChange={(v) => void settings.set('browser.maxConcurrent', Number(v)).catch(fail)}
        options={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: fmt.number(n) }))}
        hint={S.maxHint}
      />
      <form
        className="ws-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (!daysOk) return;
          settings.set('browser.screenshotRetentionDays', dayNum).then(
            () => setDays(null),
            (err: unknown) => fail(err),
          );
        }}
      >
        <TextField
          label={S.keep}
          inputMode="numeric"
          value={dayText}
          locked={keep.locked}
          setting="browser.screenshotRetentionDays"
          onChange={(e) => setDays(e.target.value.trim())}
          hint={S.keepHint}
          error={daysOk ? undefined : S.keepRange({ min: 1, max: 3_650 })}
        />
        <Button type="submit" disabled={!daysOk || days === null || keep.locked}>
          {S.save}
        </Button>
      </form>
    </section>
  );
}
