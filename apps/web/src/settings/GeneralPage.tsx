// Settings → General (docs/14 §1.1): which key sends, what a message sent during a reply does
// (FR-019), how long temporary chats are kept (FR-027), the default model for new chats (FR-023),
// follow-up suggestions (FR-028), the setup guide (FR-014), and M5's Work runs: default budgets
// (FR-182), autonomy (docs/09 §3) and turning chat requests into runs (FR-186).
import { useState } from 'react';
import { Button, RadioGroup, SelectField, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { modelGroups } from '../providers/model-groups.ts';
import { bindingText } from '../keys.ts';
import { navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useModels } from '../stores.tsx';
import { AUTONOMY_TEXT } from '../work/format.ts';
import { MANAGED } from './common.ts';
import { SwitchField } from './controls.tsx';
import '../workspace.css';
import '../work/work.css';

export function GeneralPage() {
  const { registry } = useServices();
  const settings = useSettings();
  const toast = useToast();
  const { models } = useModels();
  const enter = settings.get('general.enterToSend');
  const model = settings.get('chat.defaultModel');
  const followUp = settings.get('general.followUp');
  const suggestions = settings.get('chat.suggestions');
  const mac = registry.platform.mac;

  const fail = (err: unknown) =>
    toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' });

  const groups = modelGroups(models);

  return (
    <div className="settings-page">
      <h2>General</h2>
      <section className="settings-section">
        <RadioGroup
          legend="Send messages with"
          name="enter-to-send"
          value={enter.value}
          locked={enter.locked}
          onChange={(v) =>
            void settings.set('general.enterToSend', v as 'enter' | 'mod+enter').catch(fail)
          }
          options={[
            { value: 'enter', label: 'Enter', description: 'Shift+Enter adds a new line.' },
            {
              value: 'mod+enter',
              label: bindingText('mod+enter', mac),
              description: 'Enter adds a new line.',
            },
          ]}
        />
      </section>
      <section className="settings-section">
        <RadioGroup
          legend="While a reply is streaming, new messages"
          name="follow-up"
          value={followUp.value}
          locked={followUp.locked}
          onChange={(v) =>
            void settings.set('general.followUp', v as 'steer' | 'queue').catch(fail)
          }
          options={[
            {
              value: 'steer',
              label: 'Steer the reply',
              description: 'Join the running reply and change its direction at its next step.',
            },
            {
              value: 'queue',
              label: 'Wait in a queue',
              description: 'Are sent one by one after the current reply finishes.',
            },
          ]}
        />
      </section>
      <section className="settings-section">
        <TemporaryRetention onError={fail} />
      </section>
      <section className="settings-section">
        <SelectField
          label="Default model for new chats"
          value={model.value ?? ''}
          locked={model.locked}
          onChange={(v) => void settings.set('chat.defaultModel', v || null).catch(fail)}
          options={[{ value: '', label: 'First available model' }]}
          groups={groups}
          hint={
            models.length
              ? 'You can still pick another model in each chat.'
              : 'No models yet. Connect a provider in Accounts.'
          }
        />
      </section>
      <section className="settings-section">
        <SwitchField
          label="Suggest follow-ups"
          description="After a reply, offer a few short prompts to continue with."
          checked={suggestions.value}
          locked={suggestions.locked}
          onChange={(v) => void settings.set('chat.suggestions', v).catch(fail)}
        />
      </section>
      <WorkRunsSection onError={fail} />
      <section className="settings-section">
        <h3>Setup guide</h3>
        <p className="muted">Walk through connecting a provider and running a sample task again.</p>
        <Button onClick={() => navigate('/onboarding')}>Open the setup guide</Button>
      </section>
    </div>
  );
}

const TTL_MIN = 1;
const TTL_MAX = 720;

/** Hours a temporary chat is kept after its last activity (FR-027); saved on Enter or blur. */
function TemporaryRetention({ onError }: { onError: (err: unknown) => void }) {
  const settings = useSettings();
  const ttl = settings.get('chat.temporaryTtlHours');
  const [draft, setDraft] = useState<{ base: number; text: string } | null>(null);
  // A draft belongs to the value it was typed against; a new value from the Hub discards it.
  const text = draft && draft.base === ttl.value ? draft.text : String(ttl.value);
  const n = Number(text);
  const invalid = !/^\d+$/.test(text.trim()) || n < TTL_MIN || n > TTL_MAX;

  const commit = () => {
    if (invalid || n === ttl.value) return;
    setDraft(null);
    void settings.set('chat.temporaryTtlHours', n).catch(onError);
  };

  return (
    <TextField
      label="Delete temporary chats after (hours)"
      hint={`${ttl.locked ? `${MANAGED}. ` : ''}Temporary chats and their files are deleted this long after their last activity. ${TTL_MIN} to ${TTL_MAX} hours.`}
      type="number"
      className="ws-number"
      inputMode="numeric"
      min={TTL_MIN}
      max={TTL_MAX}
      step={1}
      value={text}
      disabled={ttl.locked}
      error={invalid ? `Enter a whole number from ${TTL_MIN} to ${TTL_MAX}.` : undefined}
      onChange={(e) => setDraft({ base: ttl.value, text: e.target.value })}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

const MAX_MINUTES = 7 * 24 * 60;

/** Work runs (FR-182, FR-186, docs/09 §3): defaults for new runs and chat escalation. */
function WorkRunsSection({ onError }: { onError: (err: unknown) => void }) {
  const settings = useSettings();
  const budgets = settings.get('runs.defaultBudgets');
  const autonomy = settings.get('runs.autonomy');
  const escalation = settings.get('chat.escalation');
  const b = budgets.value;
  const save = (patch: Partial<typeof b>) =>
    void settings.set('runs.defaultBudgets', { ...b, ...patch }).catch(onError);
  return (
    <section className="settings-section" aria-labelledby="work-runs-heading">
      <h3 id="work-runs-heading">Work runs</h3>
      <p className="muted">
        Defaults for new runs. A run pauses at a budget and asks before going further.
      </p>
      <div className="work-budget-fields">
        <NumberSetting
          label="Time budget (minutes)"
          value={Math.round(b.timeSeconds / 60)}
          min={1}
          max={MAX_MINUTES}
          locked={budgets.locked}
          onSave={(n) => save({ timeSeconds: n * 60 })}
        />
        <NumberSetting
          label="Token budget"
          value={b.tokens}
          min={1_000}
          max={100_000_000}
          locked={budgets.locked}
          onSave={(n) => save({ tokens: n })}
        />
        <NumberSetting
          label="Cost limit (US dollars)"
          value={b.costUsd}
          min={0}
          max={100_000}
          decimals
          locked={budgets.locked}
          hint="Blank uses the provider spend cap."
          onSave={(n) => save({ costUsd: n })}
        />
      </div>
      <RadioGroup
        legend="Autonomy of new runs"
        name="runs-autonomy"
        value={autonomy.value}
        locked={autonomy.locked}
        onChange={(v) =>
          void settings
            .set('runs.autonomy', v as 'ask_first' | 'standard' | 'autonomous')
            .catch(onError)
        }
        options={(['ask_first', 'standard', 'autonomous'] as const).map((a) => ({
          value: a,
          label: AUTONOMY_TEXT[a].label,
          description: AUTONOMY_TEXT[a].description,
        }))}
      />
      <RadioGroup
        legend="Turn multi-step chat requests into runs"
        name="chat-escalation"
        value={escalation.value}
        locked={escalation.locked}
        onChange={(v) =>
          void settings.set('chat.escalation', v as 'propose' | 'auto' | 'off').catch(onError)
        }
        options={[
          {
            value: 'propose',
            label: 'Propose a run',
            description: 'Show the plan and budget in the chat; the run starts when you accept it.',
          },
          {
            value: 'auto',
            label: 'Start the run',
            description: 'Start at once in the chat, with Stop always visible.',
          },
          { value: 'off', label: 'Never', description: 'Answer in the chat without a run.' },
        ]}
      />
    </section>
  );
}

/**
 * A number saved on Enter or blur. With `decimals`, blank saves null (the cost limit falls back to
 * the provider spend cap); otherwise whole numbers only.
 */
function NumberSetting<N extends number | null>({
  label,
  value,
  min,
  max,
  decimals,
  locked,
  hint,
  onSave,
}: {
  label: string;
  value: N;
  min: number;
  max: number;
  decimals?: boolean;
  locked: boolean;
  hint?: string;
  onSave: (n: N) => void;
}) {
  const shown = value === null ? '' : String(value);
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  // A draft belongs to the value it was typed against; a new value from the Hub discards it.
  const text = draft && draft.base === shown ? draft.text : shown;
  const blank = text.trim() === '';
  const n = Number(text);
  const invalid = blank
    ? !decimals
    : !Number.isFinite(n) || n < min || n > max || (!decimals && !Number.isInteger(n));
  const commit = () => {
    if (invalid || text === shown) return;
    setDraft(null);
    onSave((blank ? null : n) as N);
  };
  return (
    <TextField
      label={label}
      type="number"
      inputMode={decimals ? 'decimal' : 'numeric'}
      className="ws-number"
      min={min}
      max={max}
      step={decimals ? 0.01 : 1}
      value={text}
      disabled={locked}
      hint={`${locked ? `${MANAGED}. ` : ''}${hint ?? ''}` || undefined}
      error={
        invalid
          ? `Enter ${decimals ? 'a number' : 'a whole number'} from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.`
          : undefined
      }
      onChange={(e) => setDraft({ base: shown, text: e.target.value })}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}
