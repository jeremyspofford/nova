// Plugins per agent (FR-045, docs/04 §2.5), a section of an agent's page: by default an agent
// uses every plugin you turned on; connecting only some limits its threads to those plugins'
// tools (the policy gate enforces it). The choice lists your installed plugins; a plugin that was
// uninstalled since is named in the Hub's refusal.
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { PluginView } from '@nova/shared';
import { Button, EmptyState, RadioGroup, Spinner, useToast } from '@nova/ui';
import { rich } from '../i18n/rich.tsx';
import { useServices } from '../services.tsx';
import { followLink } from '../work/nav.tsx';
import { useTeamApi } from './api.ts';
import { TEAM_TEXT } from './format.ts';
import { FormError, LoadError, useLoad } from './parts.tsx';
import './team.css';

const PLUGINS_SETTINGS_PATH = '/settings/plugins';

const PLUGINS_TEXT = defineMessages('team.plugins', {
  usesAll: 'It uses every plugin you turned on.',
  usesSome: 'It uses {n, plural, one {# plugin} other {# plugins}}.',
  loadFailed: "Could not load this agent's plugins.",
  loading: 'Loading plugins',
  legend: 'Plugins it may use',
  all: 'Every plugin you turned on',
  allWhat: 'New plugins join it when you install them.',
  some: 'Only the plugins chosen here',
  someWhat: 'Its threads cannot use the tools of any other plugin.',
  yoursFailed: 'Could not load your plugins.',
  connected: 'Connected plugins',
  turnedOff: '(turned off)',
  none: 'With none chosen, it uses no plugin tools at all.',
  emptyTitle: 'No plugins installed',
  installIn: 'Install plugins in {link}.',
  settingsLink: 'Settings → Plugins & skills',
  discard: 'Discard',
  saveFailed: 'Could not save the plugins.',
  heading: 'Plugins',
  intro:
    'Choose which of your plugins this agent may use. Its skills catalog still lists every plugin’s skills; only connected plugins’ tools run.',
});

export function AgentPluginsSection({ agentId }: { agentId: string }) {
  const api = useTeamApi();
  const { api: hub } = useServices();
  const toast = useToast();
  const headingId = useId();
  const current = useLoad(() => api.getAgentPlugins(agentId), `agent-plugins-${agentId}`);
  const plugins = useLoad(() => hub.listPlugins().then((r) => r.items), 'agent-plugins-installed');
  const [draft, setDraft] = useState<string[] | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const saved = current.data?.pluginIds;
  const value = draft === undefined ? saved : draft;
  const dirty =
    draft !== undefined &&
    JSON.stringify(draft === null ? null : [...draft].sort()) !==
      JSON.stringify(saved === null || saved === undefined ? null : [...saved].sort());

  const save = async () => {
    if (value === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.setAgentPlugins(agentId, value);
      current.setData(() => out);
      setDraft(undefined);
      toast.show(
        out.pluginIds === null
          ? PLUGINS_TEXT.usesAll
          : PLUGINS_TEXT.usesSome({ n: out.pluginIds.length }),
        { tone: 'success' },
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (p: PluginView) => {
    const set = new Set(value ?? []);
    if (set.has(p.id)) set.delete(p.id);
    else set.add(p.id);
    setDraft([...set]);
  };

  let body;
  if (current.error && !current.data)
    body = (
      <LoadError
        error={current.error}
        fallback={PLUGINS_TEXT.loadFailed}
        onRetry={current.reload}
      />
    );
  else if (!current.data || (!plugins.data && !plugins.error))
    body = <Spinner label={PLUGINS_TEXT.loading} />;
  else
    body = (
      <div className="stack">
        <RadioGroup
          legend={PLUGINS_TEXT.legend}
          name={`agent-plugins-${agentId}`}
          value={value === null || value === undefined ? 'all' : 'some'}
          onChange={(v) => setDraft(v === 'all' ? null : (saved ?? []))}
          options={[
            { value: 'all', label: PLUGINS_TEXT.all, description: PLUGINS_TEXT.allWhat },
            { value: 'some', label: PLUGINS_TEXT.some, description: PLUGINS_TEXT.someWhat },
          ]}
        />
        {plugins.error ? (
          <LoadError
            error={plugins.error}
            fallback={PLUGINS_TEXT.yoursFailed}
            onRetry={plugins.reload}
          />
        ) : null}
        {value !== null && value !== undefined && plugins.data ? (
          plugins.data.length ? (
            <fieldset className="ws-fieldset">
              <legend>{PLUGINS_TEXT.connected}</legend>
              {plugins.data.map((p) => (
                <label key={p.id} className="ws-check">
                  <input
                    type="checkbox"
                    checked={value.includes(p.id)}
                    onChange={() => toggle(p)}
                  />
                  <span>
                    <span dir="auto">{p.name}</span>{' '}
                    <span className="muted" dir="ltr">
                      {p.version}
                    </span>
                    {!p.enabled ? <span className="muted"> {PLUGINS_TEXT.turnedOff}</span> : null}
                  </span>
                </label>
              ))}
              {value.length === 0 ? <p className="muted ws-flush">{PLUGINS_TEXT.none}</p> : null}
            </fieldset>
          ) : (
            <EmptyState
              level={3}
              icon="tool"
              title={PLUGINS_TEXT.emptyTitle}
              description={rich(PLUGINS_TEXT.installIn, {
                link: (
                  <a
                    href={PLUGINS_SETTINGS_PATH}
                    onClick={(e) => followLink(e, PLUGINS_SETTINGS_PATH)}
                  >
                    {PLUGINS_TEXT.settingsLink}
                  </a>
                ),
              })}
            />
          )
        ) : null}
        <div className="row">
          <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? <Spinner /> : null} {TEAM_TEXT.save}
          </Button>
          {dirty ? (
            <Button onClick={() => setDraft(undefined)}>{PLUGINS_TEXT.discard}</Button>
          ) : null}
        </div>
        <FormError error={error} fallback={PLUGINS_TEXT.saveFailed} />
      </div>
    );

  return (
    <section className="stack team-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{PLUGINS_TEXT.heading}</h2>
      <p className="muted ws-flush">{PLUGINS_TEXT.intro}</p>
      {body}
    </section>
  );
}
