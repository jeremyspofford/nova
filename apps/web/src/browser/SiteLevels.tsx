// Site levels per project or agent (FR-094, docs/11 §4.4, M7): an allowed site can have its own
// level for one project or one agent, and the narrower scope wins (the agent's level, then the
// project's, then the level for everything else). Settings → Browser edits them per site
// (`SiteScopeLevels`); a project's or an agent's page edits that scope's levels for every allowed
// site (`ScopedSiteLevels`). Blocking or removing a site removes its scoped levels on the Hub.
import { useEffect, useId, useState } from 'react';
import {
  BROWSER_SITE_LEVELS,
  type BrowserSiteLevel,
  type BrowserSiteScopeKind,
  type BrowserSiteScopedLevelView,
  type BrowserSiteView,
} from '@nova/shared';
import { Button, Icon, SelectField, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { navigate } from '../router.ts';
import { sentence } from '../screen/format.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { useBrowserM7Api } from './api-m7.ts';
import { LEVEL_TEXT, SCOPE_TEXT } from './format.ts';

export const BROWSER_SETTINGS_PATH = '/settings/browser';

/** A project or agent a level can be set for. */
export interface ScopeChoice {
  kind: BrowserSiteScopeKind;
  id: string;
  name: string;
}

const LEVEL_OPTIONS = BROWSER_SITE_LEVELS.map((l) => ({ value: l, label: LEVEL_TEXT[l] }));

const isLevel = (v: string): v is BrowserSiteLevel =>
  (BROWSER_SITE_LEVELS as readonly string[]).includes(v);

/**
 * The projects and agents of this account, for naming scopes and choosing one; null while loading,
 * and an empty list for a kind that could not be listed.
 */
export function useScopeChoices(): ScopeChoice[] | null {
  const { api } = useServices();
  const [choices, setChoices] = useState<ScopeChoice[] | null>(null);
  useEffect(() => {
    let alive = true;
    const projects = Promise.resolve()
      .then(() => api.listProjects())
      .then(
        ({ items }) => items.map((p): ScopeChoice => ({ kind: 'project', id: p.id, name: p.name })),
        () => [] as ScopeChoice[],
      );
    const agents = Promise.resolve()
      .then(() => api.listAgents())
      .then(
        ({ items }) => items.map((a): ScopeChoice => ({ kind: 'agent', id: a.id, name: a.name })),
        () => [] as ScopeChoice[],
      );
    void Promise.all([projects, agents]).then(([p, a]) => {
      if (alive) setChoices([...p, ...a]);
    });
    return () => {
      alive = false;
    };
  }, [api]);
  return choices;
}

function scopeName(choices: ScopeChoice[] | null, kind: BrowserSiteScopeKind, ref: string): string {
  return choices?.find((c) => c.kind === kind && c.id === ref)?.name ?? SCOPE_TEXT[kind].none;
}

/** `list` with `v` in place of the entry for the same scope (or added). */
export function withScoped(
  list: readonly BrowserSiteScopedLevelView[],
  v: BrowserSiteScopedLevelView,
): BrowserSiteScopedLevelView[] {
  const rest = list.filter((x) => !(x.scopeKind === v.scopeKind && x.scopeRef === v.scopeRef));
  return [...rest, v];
}

/**
 * One allowed site's levels for projects and agents, under its row in Settings → Browser: each
 * with its level and Remove, and a form to set one for another project or agent.
 */
export function SiteScopeLevels({
  site,
  choices,
  onChanged,
}: {
  site: BrowserSiteView;
  choices: ScopeChoice[] | null;
  onChanged: (pattern: string, scoped: BrowserSiteScopedLevelView[]) => void;
}) {
  const api = useBrowserM7Api();
  const toast = useToast();
  const announce = useAnnounce();
  const [target, setTarget] = useState('');
  const [level, setLevel] = useState<BrowserSiteLevel>('always_allow');
  const [busy, setBusy] = useState(false);
  const scoped = [...site.scopedLevels].sort(
    (a, b) =>
      a.scopeKind.localeCompare(b.scopeKind) ||
      scopeName(choices, a.scopeKind, a.scopeRef).localeCompare(
        scopeName(choices, b.scopeKind, b.scopeRef),
      ),
  );
  const free = (choices ?? []).filter(
    (c) => !site.scopedLevels.some((s) => s.scopeKind === c.kind && s.scopeRef === c.id),
  );

  const put = async (kind: BrowserSiteScopeKind, ref: string, next: BrowserSiteLevel) => {
    setBusy(true);
    try {
      const v = await api.putBrowserSiteLevel(site.pattern, kind, ref, next);
      onChanged(site.pattern, withScoped(site.scopedLevels, v));
      announce(`${site.pattern} for ${scopeName(choices, kind, ref)}: ${LEVEL_TEXT[v.level]}.`);
      return true;
    } catch (err) {
      toast.show(`Could not set the level: ${sentence(errorMessage(err))}`, { tone: 'error' });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: BrowserSiteScopedLevelView) => {
    setBusy(true);
    try {
      await api.deleteBrowserSiteLevel(site.pattern, s.scopeKind, s.scopeRef);
      onChanged(
        site.pattern,
        site.scopedLevels.filter(
          (x) => !(x.scopeKind === s.scopeKind && x.scopeRef === s.scopeRef),
        ),
      );
      announce(
        `${site.pattern} for ${scopeName(choices, s.scopeKind, s.scopeRef)} uses the level for everything else again.`,
      );
    } catch (err) {
      toast.show(`Could not remove the level: ${sentence(errorMessage(err))}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const [kind, ref] = target.split(':', 2) as [BrowserSiteScopeKind | '', string | undefined];
  return (
    <details className="ws-advanced brw-scoped">
      <summary>For projects and agents{scoped.length ? ` (${scoped.length})` : ''}</summary>
      <p className="muted ws-flush">
        A level here wins over the one above for that project or agent. An agent’s level wins over
        its project’s.
      </p>
      {scoped.length ? (
        <ul className="ws-list" aria-label={`Levels of ${site.pattern} for projects and agents`}>
          {scoped.map((s) => {
            const name = scopeName(choices, s.scopeKind, s.scopeRef);
            const what = `${SCOPE_TEXT[s.scopeKind].one} ${name}`;
            return (
              <li
                key={`${s.scopeKind}:${s.scopeRef}`}
                className="ws-list-row brw-scoped-row"
                aria-label={`${s.scopeKind === 'project' ? 'Project' : 'Agent'}: ${name}`}
              >
                <div className="ws-source-main">
                  <strong>{name}</strong>
                  <span className="muted ws-row-meta">
                    {s.scopeKind === 'project' ? 'Project' : 'Agent'}
                  </span>
                </div>
                <div className="brw-site-controls">
                  <SelectField
                    label={`Level of ${site.pattern} for the ${what}`}
                    hideLabel
                    value={s.level}
                    disabled={busy}
                    onChange={(v) => {
                      if (isLevel(v)) void put(s.scopeKind, s.scopeRef, v);
                    }}
                    options={LEVEL_OPTIONS}
                  />
                  <Button
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Remove the level of ${site.pattern} for the ${what}`}
                    onClick={() => void remove(s)}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted ws-flush">Every project and agent uses the level above.</p>
      )}
      {choices === null ? (
        <Spinner label="Loading projects and agents" />
      ) : free.length === 0 ? (
        <p className="muted ws-flush">
          {choices.length === 0
            ? 'There are no projects or agents yet.'
            : 'Every project and agent has its own level for this site.'}
        </p>
      ) : (
        <form
          className="ws-toolbar brw-scoped-add"
          aria-label={`Set a level of ${site.pattern} for a project or agent`}
          onSubmit={(e) => {
            e.preventDefault();
            if (!kind || !ref) return;
            void put(kind, ref, level).then((ok) => {
              if (ok) setTarget('');
            });
          }}
        >
          <SelectField
            label="Project or agent"
            value={target}
            onChange={setTarget}
            options={[{ value: '', label: 'Choose…' }]}
            groups={(['project', 'agent'] as const)
              .map((k) => ({
                label: k === 'project' ? 'Projects' : 'Agents',
                options: free
                  .filter((c) => c.kind === k)
                  .map((c) => ({ value: `${c.kind}:${c.id}`, label: c.name })),
              }))
              .filter((g) => g.options.length > 0)}
          />
          <SelectField
            label="Level"
            value={level}
            onChange={(v) => {
              if (isLevel(v)) setLevel(v);
            }}
            options={LEVEL_OPTIONS}
          />
          <Button type="submit" disabled={busy || !target}>
            <Icon name="plus" /> Set level
          </Button>
        </form>
      )}
    </details>
  );
}

/**
 * The browser site levels of one project or agent, for its page: every allowed site with the
 * level for everything else and this scope's own level, if any ("Same as everywhere" removes it).
 */
export function ScopedSiteLevels({
  scopeKind,
  scopeRef,
  scopeName: name,
  headingLevel = 2,
}: {
  scopeKind: BrowserSiteScopeKind;
  scopeRef: string;
  /** The project's or agent's name, for labels. */
  scopeName: string;
  headingLevel?: 2 | 3;
}) {
  const api = useBrowserM7Api();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const [sites, setSites] = useState<BrowserSiteView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => api.listBrowserSites())
      .then(
        ({ items }) => {
          if (!alive) return;
          setSites(items.filter((s) => s.access === 'allow'));
          setError(null);
        },
        (err: unknown) => alive && setError(errorMessage(err, 'Could not load the browser sites.')),
      );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  const own = (s: BrowserSiteView) =>
    s.scopedLevels.find((x) => x.scopeKind === scopeKind && x.scopeRef === scopeRef) ?? null;

  const change = async (s: BrowserSiteView, value: string) => {
    setBusy(s.pattern);
    try {
      let scoped: BrowserSiteScopedLevelView[];
      if (value === '') {
        await api.deleteBrowserSiteLevel(s.pattern, scopeKind, scopeRef);
        scoped = s.scopedLevels.filter(
          (x) => !(x.scopeKind === scopeKind && x.scopeRef === scopeRef),
        );
        announce(`${s.pattern} uses the level for everything else again.`);
      } else if (isLevel(value)) {
        const v = await api.putBrowserSiteLevel(s.pattern, scopeKind, scopeRef, value);
        scoped = withScoped(s.scopedLevels, v);
        announce(`${s.pattern} for ${name}: ${LEVEL_TEXT[v.level]}.`);
      } else return;
      setSites(
        (list) =>
          list?.map((x) => (x.pattern === s.pattern ? { ...x, scopedLevels: scoped } : x)) ?? null,
      );
    } catch (err) {
      toast.show(`Could not change ${s.pattern}: ${sentence(errorMessage(err))}`, {
        tone: 'error',
      });
    } finally {
      setBusy(null);
    }
  };

  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const settingsLink = (
    <a
      href={BROWSER_SETTINGS_PATH}
      onClick={(e) => {
        e.preventDefault();
        navigate(BROWSER_SETTINGS_PATH);
      }}
    >
      Settings → Browser
    </a>
  );
  return (
    <section className="ws-section brw-scope-levels" aria-labelledby={headingId}>
      <Heading id={headingId}>Browser site levels</Heading>
      <p className="muted ws-flush">
        How the agent browser treats changes on allowed sites (clicking a button, sending a form)
        {scopeKind === 'project' ? ' in this project' : ' for this agent'}. A level here wins over
        the one for everything else
        {scopeKind === 'project' ? ', and an agent’s own level wins over it' : ''}. Sites are added
        in {settingsLink}.
      </p>
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : null}
      {sites === null && !error ? <Spinner label="Loading browser sites" /> : null}
      {sites?.length === 0 ? (
        <p className="muted ws-flush">
          No sites are allowed yet. Allow one in {settingsLink}, then set its level here.
        </p>
      ) : null}
      {sites?.length ? (
        <ul className="ws-list" aria-label={`Browser site levels for ${name}`}>
          {sites.map((s) => {
            const mine = own(s);
            const everywhere = LEVEL_TEXT[s.level ?? 'always_ask'];
            return (
              <li key={s.pattern} className="ws-list-row brw-site" aria-label={s.pattern}>
                <div className="ws-source-main">
                  <code className="ws-code-inline">{s.pattern}</code>
                  <span className="muted ws-row-meta">
                    {mine
                      ? `Own level here; everywhere else: ${everywhere}`
                      : `Same as everywhere: ${everywhere}`}
                  </span>
                </div>
                <SelectField
                  label={`Level of ${s.pattern} for ${name}`}
                  hideLabel
                  value={mine?.level ?? ''}
                  disabled={busy === s.pattern}
                  onChange={(v) => void change(s, v)}
                  options={[{ value: '', label: 'Same as everywhere' }, ...LEVEL_OPTIONS]}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
