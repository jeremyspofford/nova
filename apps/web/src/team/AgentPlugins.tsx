// Plugins per agent (FR-045, docs/04 §2.5), a section of an agent's page: by default an agent
// uses every plugin you turned on; connecting only some limits its threads to those plugins'
// tools (the policy gate enforces it). The choice lists your installed plugins; a plugin that was
// uninstalled since is named in the Hub's refusal.
import { useId, useState } from 'react';
import type { PluginView } from '@nova/shared';
import { Button, EmptyState, RadioGroup, Spinner, useToast } from '@nova/ui';
import { useServices } from '../services.tsx';
import { followLink } from '../work/nav.tsx';
import { useTeamApi } from './api.ts';
import { FormError, LoadError, useLoad } from './parts.tsx';
import './team.css';

const PLUGINS_SETTINGS_PATH = '/settings/plugins';

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
          ? 'It uses every plugin you turned on.'
          : `It uses ${out.pluginIds.length === 1 ? '1 plugin' : `${out.pluginIds.length} plugins`}.`,
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
        fallback="Could not load this agent's plugins."
        onRetry={current.reload}
      />
    );
  else if (!current.data || (!plugins.data && !plugins.error))
    body = <Spinner label="Loading plugins" />;
  else
    body = (
      <div className="stack">
        <RadioGroup
          legend="Plugins it may use"
          name={`agent-plugins-${agentId}`}
          value={value === null || value === undefined ? 'all' : 'some'}
          onChange={(v) => setDraft(v === 'all' ? null : (saved ?? []))}
          options={[
            {
              value: 'all',
              label: 'Every plugin you turned on',
              description: 'New plugins join it when you install them.',
            },
            {
              value: 'some',
              label: 'Only the plugins chosen here',
              description: 'Its threads cannot use the tools of any other plugin.',
            },
          ]}
        />
        {plugins.error ? (
          <LoadError
            error={plugins.error}
            fallback="Could not load your plugins."
            onRetry={plugins.reload}
          />
        ) : null}
        {value !== null && value !== undefined && plugins.data ? (
          plugins.data.length ? (
            <fieldset className="ws-fieldset">
              <legend>Connected plugins</legend>
              {plugins.data.map((p) => (
                <label key={p.id} className="ws-check">
                  <input
                    type="checkbox"
                    checked={value.includes(p.id)}
                    onChange={() => toggle(p)}
                  />
                  <span>
                    {p.name} <span className="muted">{p.version}</span>
                    {!p.enabled ? <span className="muted"> (turned off)</span> : null}
                  </span>
                </label>
              ))}
              {value.length === 0 ? (
                <p className="muted ws-flush">With none chosen, it uses no plugin tools at all.</p>
              ) : null}
            </fieldset>
          ) : (
            <EmptyState
              level={3}
              icon="tool"
              title="No plugins installed"
              description={
                <>
                  Install plugins in{' '}
                  <a
                    href={PLUGINS_SETTINGS_PATH}
                    onClick={(e) => followLink(e, PLUGINS_SETTINGS_PATH)}
                  >
                    Settings → Plugins & skills
                  </a>
                  .
                </>
              }
            />
          )
        ) : null}
        <div className="row">
          <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? <Spinner /> : null} Save
          </Button>
          {dirty ? <Button onClick={() => setDraft(undefined)}>Discard</Button> : null}
        </div>
        <FormError error={error} fallback="Could not save the plugins." />
      </div>
    );

  return (
    <section className="stack team-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Plugins</h2>
      <p className="muted ws-flush">
        Choose which of your plugins this agent may use. Its skills catalog still lists every
        plugin’s skills; only connected plugins’ tools run.
      </p>
      {body}
    </section>
  );
}
