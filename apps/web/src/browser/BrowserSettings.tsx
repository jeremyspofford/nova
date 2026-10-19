// Settings → Browser (FR-094, FR-086, FR-096; docs/11 §4, §4.4, §9, docs/12 §8): whether the agent
// browser can run on this Hub, sign-in requests waiting for the user (a notification's
// `/settings/browser?signin=<id>` lands here), the sites the agent may open with a permission level
// each, its own levels for projects and agents (M7: the narrower scope wins) and an optional
// developer-protocol mode, the allow and block lists as plain lists, the saved logins (passwords
// are never shown), and the browser settings. Allowed and blocked sites are one list on the Hub:
// the domain lists edit the same entries.
import { useEffect, useId, useState } from 'react';
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
import { useLocation } from '../router.ts';
import { sentence } from '../screen/format.ts';
import { useAnnounce } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { MANAGED, formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useBrowserApi } from './api.ts';
import { LEVEL_HINT, LEVEL_TEXT } from './format.ts';
import { PendingSignins } from './PendingSignins.tsx';
import { SiteScopeLevels, useScopeChoices } from './SiteLevels.tsx';
import '../workspace.css';
import './browser.css';

/** Why a site pattern is not usable, or null when it is. */
export function patternProblem(raw: string): string | null {
  const r = browserSitePatternSchema.safeParse(raw);
  return r.success ? null : 'Enter a host such as example.com or *.example.com';
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
      (err: unknown) => alive && setStatusError(errorMessage(err, 'Could not check the browser.')),
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  return (
    <div className="settings-page brw-settings">
      <h2>Browser</h2>
      <section className="settings-section" aria-labelledby="brw-status">
        <h3 id="brw-status">Agent browser</h3>
        <p className="muted">
          Agents use their own browser with a clean profile, separate from yours. Its traffic goes
          through the network proxy, and it never gets your browser’s cookies or passwords.
        </p>
        {statusError ? (
          <div className="ws-error" role="alert">
            <p>{statusError}</p>
            <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
          </div>
        ) : status === null ? (
          <Spinner label="Checking the agent browser" />
        ) : status.available ? (
          <p className="ws-ok">
            <Icon name="check" /> Ready on this Hub.
          </p>
        ) : (
          <p className="ws-warning" role="note">
            <Icon name="alert" /> Not available: {sentence(status.detail)}
          </p>
        )}
      </section>
      <section className="settings-section" aria-labelledby="brw-signins">
        <h3 id="brw-signins">Sign-in requests</h3>
        <PendingSignins focusId={focusId} empty="No sign-in requests are waiting." />
      </section>
      <SitesSection />
      <LoginsSection />
      <BehaviorSection />
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the sites.')),
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

  const problem = pattern.trim() ? patternProblem(pattern) : 'Enter a host';
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
      announce(access === 'allow' ? `${v.pattern} allowed.` : `${v.pattern} blocked.`);
    } catch (err) {
      toast.show(`Could not save ${pattern.trim()}: ${sentence(errorMessage(err))}`, {
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
        announce(
          body.devProtocol
            ? `Developer protocol on for ${s.pattern}.`
            : `Developer protocol off for ${s.pattern}.`,
        );
    } catch (err) {
      toast.show(`Could not change ${s.pattern}: ${sentence(errorMessage(err))}`, {
        tone: 'error',
      });
      setAttempt((n) => n + 1);
    }
  };

  const remove = async (s: BrowserSiteView) => {
    setRemoving(null);
    try {
      await api.deleteBrowserSite(s.pattern);
      setSites((list) => (list ?? []).filter((x) => x.pattern !== s.pattern));
      toast.show(
        s.access === 'block'
          ? `${s.pattern} is no longer blocked.`
          : `${s.pattern} removed. The agent asks again before opening it.`,
        { tone: 'success' },
      );
    } catch (err) {
      toast.show(`Could not remove ${s.pattern}: ${sentence(errorMessage(err))}`, {
        tone: 'error',
      });
      setAttempt((n) => n + 1);
    }
  };

  const allowed = (sites ?? []).filter((s) => s.access === 'allow');
  const blocked = (sites ?? []).filter((s) => s.access === 'block');
  const devOff = !devSetting.value;

  return (
    <section className="settings-section" aria-labelledby="brw-sites">
      <h3 id="brw-sites">Sites</h3>
      <p className="muted">
        The agent opens only sites on this list or on the network allow list; a new site asks you
        first (Allow once, Always allow or Deny). Each allowed site has a level for changes such as
        clicking a button or sending a form. Blocked sites never open.
      </p>
      <form
        className="ws-toolbar brw-add-site"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <TextField
          label="Site"
          value={pattern}
          placeholder="example.com or *.example.com"
          autoComplete="off"
          spellCheck={false}
          maxLength={253}
          onChange={(e) => setPattern(e.target.value)}
          error={touched && problem ? problem : undefined}
        />
        <SelectField
          label="Access"
          value={access}
          onChange={(v) => setAccess(v === 'block' ? 'block' : 'allow')}
          options={[
            { value: 'allow', label: 'Allow' },
            { value: 'block', label: 'Block' },
          ]}
        />
        {access === 'allow' ? (
          <SelectField
            label="Level"
            value={level}
            onChange={(v) => setLevel(v as BrowserSiteLevel)}
            options={BROWSER_SITE_LEVELS.map((l) => ({ value: l, label: LEVEL_TEXT[l] }))}
          />
        ) : null}
        <Button type="submit" variant="primary">
          <Icon name="plus" /> Add site
        </Button>
      </form>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : null}
      {sites === null && !error ? <Spinner label="Loading sites" /> : null}
      {sites ? (
        <>
          <h4 className="ws-subhead">Allowed</h4>
          {allowed.length === 0 ? (
            <p className="muted">No sites allowed yet. Add one above, or allow one when asked.</p>
          ) : (
            <ul className="ws-list" aria-label="Allowed sites">
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
                        label={`Level for ${s.pattern}`}
                        hideLabel
                        value={lvl}
                        onChange={(v) => void patch(s, { level: v as BrowserSiteLevel })}
                        options={BROWSER_SITE_LEVELS.map((l) => ({
                          value: l,
                          label: LEVEL_TEXT[l],
                        }))}
                      />
                      <span className="brw-dev">
                        <Switch
                          label={`Developer protocol for ${s.pattern}`}
                          checked={s.devProtocol}
                          disabled={(devOff || devSetting.locked) && !s.devProtocol}
                          onChange={(next) =>
                            next ? setDevAsk(s) : void patch(s, { devProtocol: false })
                          }
                        />
                        <span aria-hidden="true">Developer protocol</span>
                      </span>
                      <Button
                        variant="ghost"
                        onClick={() => setRemoving(s)}
                        aria-label={`Remove ${s.pattern}`}
                      >
                        Remove
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
            <p className="muted">
              Developer protocol is turned off for every site
              {devSetting.locked ? ` (${MANAGED.toLowerCase()})` : ' (see Behavior below)'}.
            </p>
          ) : null}
          <h4 className="ws-subhead">Blocked</h4>
          {blocked.length === 0 ? (
            <p className="muted">No sites blocked.</p>
          ) : (
            <ul className="ws-list" aria-label="Blocked sites">
              {blocked.map((s) => (
                <li key={s.pattern} className="ws-list-row" aria-label={s.pattern}>
                  <code className="ws-code-inline">{s.pattern}</code>
                  <Button
                    variant="ghost"
                    onClick={() => setRemoving(s)}
                    aria-label={`Unblock ${s.pattern}`}
                  >
                    Unblock
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="row">
            <Button aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
              {editing ? 'Close the list editor' : 'Edit as lists'}
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
            ? `Unblock ${removing.pattern}?`
            : `Remove ${removing?.pattern ?? 'this site'}?`
        }
        description={
          removing?.access === 'block'
            ? 'The agent may then ask to open it again.'
            : 'Its level, its levels for projects and agents, and any “Always allow” answers go too; the agent asks before opening it again.'
        }
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => removing && void remove(removing)}>
              {removing?.access === 'block' ? 'Unblock' : 'Remove'}
            </Button>
          </>
        }
      />
      <Dialog
        open={devAsk !== null}
        onClose={() => setDevAsk(null)}
        title={`Turn on developer protocol for ${devAsk?.pattern ?? 'this site'}?`}
        description="The agent gets full developer-tools access to this site’s pages: it can run scripts in them and read what they hold. Each use is still checked and recorded, and you can turn it off at any time."
        footer={
          <>
            <Button onClick={() => setDevAsk(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const s = devAsk;
                setDevAsk(null);
                if (s) void patch(s, { devProtocol: true });
              }}
            >
              Turn on
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the lists.')),
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const a = parseList(allow ?? '');
  const d = parseList(deny);
  const invalid = [...a.invalid, ...d.invalid];

  const save = async () => {
    if (invalid.length) return;
    setSaving(true);
    try {
      await api.setBrowserDomains({ allow: a.patterns, deny: d.patterns });
      toast.show('Site lists saved.', { tone: 'success' });
      onSaved();
    } catch (err) {
      toast.show(`Could not save the lists: ${sentence(errorMessage(err))}`, { tone: 'error' });
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
  if (allow === null) return <Spinner label="Loading the lists" />;
  return (
    <form
      className="brw-lists"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="muted ws-flush">
        One host per line, such as example.com or *.example.com. A host on both lists is blocked.
        Sites that stay allowed keep their level.
      </p>
      <div className="brw-lists-grid">
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={allowId}>
            Allowed, one per line
          </label>
          <textarea
            id={allowId}
            className="nv-input ws-textarea"
            value={allow}
            spellCheck={false}
            onChange={(e) => setAllow(e.target.value)}
          />
        </div>
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={denyId}>
            Blocked, one per line
          </label>
          <textarea
            id={denyId}
            className="nv-input ws-textarea"
            value={deny}
            spellCheck={false}
            onChange={(e) => setDeny(e.target.value)}
          />
        </div>
      </div>
      {invalid.length ? (
        <p className="ws-warning" role="alert">
          <Icon name="alert" /> Not a host: {invalid.join(', ')}
        </p>
      ) : null}
      <div className="row">
        <Button type="submit" variant="primary" disabled={saving || invalid.length > 0}>
          Save lists
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load saved logins.')),
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  const remove = async (l: BrowserLoginView) => {
    setDeleting(null);
    try {
      await api.deleteBrowserLogin(l.id);
      setLogins((list) => (list ?? []).filter((x) => x.id !== l.id));
      toast.show(`Deleted the login for ${l.username} on ${l.host}.`, { tone: 'success' });
    } catch (err) {
      toast.show(`Could not delete the login: ${sentence(errorMessage(err))}`, { tone: 'error' });
      setAttempt((n) => n + 1);
    }
  };

  return (
    <section className="settings-section" aria-labelledby="brw-logins">
      <h3 id="brw-logins">Saved logins</h3>
      <p className="muted">
        Logins you chose to save when the agent asked you to sign in. Passwords stay in the vault
        and are never shown; using one again always asks you first.
      </p>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : null}
      {logins === null && !error ? <Spinner label="Loading saved logins" /> : null}
      {logins?.length === 0 ? <p className="muted">No saved logins.</p> : null}
      {logins?.length ? (
        <ul className="ws-list" aria-label="Saved logins">
          {logins.map((l) => (
            <li key={l.id} className="ws-list-row" aria-label={`${l.username} on ${l.host}`}>
              <div className="ws-source-main">
                <strong>{l.username}</strong>
                <span className="muted ws-row-meta">
                  <code className="ws-code-inline">{l.host}</code>
                  <span>Password saved</span>
                  <span>Saved {formatWhen(l.createdAt)}</span>
                  <span>Last used {formatWhen(l.lastUsedAt)}</span>
                </span>
              </div>
              <Button
                variant="ghost"
                onClick={() => setDeleting(l)}
                aria-label={`Delete the login for ${l.username} on ${l.host}`}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={deleting ? `Delete the login for ${deleting.username}?` : 'Delete this login?'}
        description="The password is removed from the vault. Sessions already signed in stay signed in until they end."
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)}>
              Delete
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
  const fail = (err: unknown) =>
    toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' });

  const dayText = days ?? String(keep.value);
  const dayNum = Number(dayText);
  const daysOk = Number.isInteger(dayNum) && dayNum >= 1 && dayNum <= 3_650;

  return (
    <section className="settings-section" aria-labelledby="brw-behavior">
      <h3 id="brw-behavior">Behavior</h3>
      <SwitchField
        label="Keep the agent browser’s cookies"
        description="Sign-ins then last between browser sessions. Off: every session starts signed out."
        checked={cookies.value}
        locked={cookies.locked}
        onChange={(v) => void settings.set('browser.persistCookies', v).catch(fail)}
      />
      <SwitchField
        label="Allow local and private-network sites"
        description="Lets the agent browser open addresses on your network, such as a dev server. Off keeps it to the public web."
        checked={local.value}
        locked={local.locked}
        onChange={(v) => void settings.set('browser.allowLocalSites', v).catch(fail)}
      />
      <SwitchField
        label="Allow developer protocol per site"
        description="When off, no site can use developer-protocol mode, even one you turned it on for."
        checked={dev.value}
        locked={dev.locked}
        onChange={(v) => void settings.set('browser.devProtocol', v).catch(fail)}
      />
      <SelectField
        label="Browsers open at once"
        value={String(max.value)}
        locked={max.locked}
        onChange={(v) => void settings.set('browser.maxConcurrent', Number(v)).catch(fail)}
        options={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: String(n) }))}
        hint="More open browsers use more memory on the Hub."
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
          label="Keep action screenshots for (days)"
          inputMode="numeric"
          value={dayText}
          disabled={keep.locked}
          onChange={(e) => setDays(e.target.value.trim())}
          hint={keep.locked ? MANAGED : 'Older screenshots are deleted; the actions stay listed.'}
          error={daysOk ? undefined : 'From 1 to 3650 days'}
        />
        <Button type="submit" disabled={!daysOk || days === null || keep.locked}>
          Save
        </Button>
      </form>
    </section>
  );
}
