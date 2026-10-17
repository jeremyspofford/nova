// Settings → Code (FR-063, FR-085, FR-195; docs/10 §3, docs/12 §2.1): the permission mode new
// Code sessions start in, whether Bypass may be used at all, and the reviewer model that Auto
// mode and auto-review need. Bypass and the reviewer are security settings: global only, and
// managed policy can lock them.
import { Icon, SelectField, useToast } from '@nova/ui';
import type { PermissionMode } from '@nova/shared';
import { errorMessage } from '../api.ts';
import { MODE_DESCRIPTION, MODE_LABEL } from '../code/modes.ts';
import { modelGroups } from '../providers/model-groups.ts';
import { useSettings } from '../settings.tsx';
import { useModels } from '../stores.tsx';
import { SwitchField } from './controls.tsx';
import '../workspace.css';

/** Modes a new session can start in; Plan is chosen per session (docs/10 §3). */
const DEFAULT_MODES = ['manual', 'accept_edits', 'auto', 'bypass'] as const;
type DefaultMode = (typeof DEFAULT_MODES)[number];

export function CodePage() {
  const settings = useSettings();
  const toast = useToast();
  const { models } = useModels();
  const mode = settings.get('code.permissionMode');
  const bypass = settings.get('code.allowBypass');
  const reviewer = settings.get('review.model');

  const fail = (err: unknown) =>
    toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' });

  // The default is chosen before any environment exists, so Bypass is judged on the setting.
  const why = (m: PermissionMode): string | null => {
    if (m === 'auto' && !reviewer.value) return 'needs a reviewer model, chosen below';
    if (m === 'bypass' && !bypass.value) return 'needs Allow Bypass, below';
    return null;
  };
  const modeProblem = why(mode.value);

  return (
    <div className="settings-page">
      <h2>Code</h2>
      <section className="settings-section">
        <SelectField
          label="Permission mode for new sessions"
          value={mode.value}
          locked={mode.locked}
          onChange={(v) => void settings.set('code.permissionMode', v as DefaultMode).catch(fail)}
          options={DEFAULT_MODES.map((m) => {
            const reason = why(m);
            return {
              value: m,
              label: reason ? `${MODE_LABEL[m]} (${reason})` : MODE_LABEL[m],
              disabled: reason !== null && m !== mode.value,
            };
          })}
          hint={`${MODE_DESCRIPTION[mode.value]} A folder keeps the mode you last used in it. Plan is picked per session.`}
        />
        {modeProblem ? (
          <p className="ws-warning" role="note">
            <Icon name="alert" /> {MODE_LABEL[mode.value]} {modeProblem}. Until then new sessions
            start in Manual.
          </p>
        ) : null}
      </section>
      <section className="settings-section">
        <SelectField
          label="Reviewer model"
          value={reviewer.value ?? ''}
          locked={reviewer.locked}
          onChange={(v) => void settings.set('review.model', v || null).catch(fail)}
          options={[{ value: '', label: 'None (Auto mode is unavailable)' }]}
          groups={modelGroups(models)}
          hint="Auto mode sends every consequential action to this model, which can only make the decision stricter. Pick a different model than the one doing the work."
        />
      </section>
      <section className="settings-section">
        <SwitchField
          label="Allow Bypass mode"
          description="Lets a session stop asking where a tool default would ask. Your own rules, managed policy and confirmation steps (purchases, credentials, deleting outside the project) still ask. Only sessions on a VM or container environment can use it."
          checked={bypass.value}
          locked={bypass.locked}
          onChange={(v) => void settings.set('code.allowBypass', v).catch(fail)}
        />
        {bypass.value ? (
          <p className="ws-warning" role="note">
            <Icon name="alert" /> With Bypass, the agent can change and run things without asking
            you first. Use it only in an isolated environment you can throw away.
          </p>
        ) : null}
      </section>
    </div>
  );
}
