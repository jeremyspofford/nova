// Settings → General (docs/14 §1.1): which key sends, what a message sent during a reply does
// (FR-019), how long temporary chats are kept (FR-027), the default model for new chats (FR-023),
// follow-up suggestions (FR-028), the setup guide (FR-014), and M5's Work runs: default budgets
// (FR-182), autonomy (docs/09 §3) and turning chat requests into runs (FR-186).
import { useState } from 'react';
import { defineMessages } from '@nova/i18n';
import { Button, RadioGroup, SelectField, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { modelGroups } from '../providers/model-groups.ts';
import { bindingText } from '../keys.ts';
import { navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useModels } from '../stores.tsx';
import { AUTONOMY_TEXT } from '../work/format.ts';
import { SwitchField } from './controls.tsx';
import '../workspace.css';
import '../work/work.css';

export const GENERAL_TEXT = defineMessages('settings.general', {
  title: 'General',
  saveFailed: 'Could not save: {error}',
  sendWith: 'Send messages with',
  enter: 'Enter',
  enterHint: 'Shift+Enter adds a new line.',
  modEnterHint: 'Enter adds a new line.',
  followUp: 'While a reply is streaming, new messages',
  steer: 'Steer the reply',
  steerHint: 'Join the running reply and change its direction at its next step.',
  queue: 'Wait in a queue',
  queueHint: 'Are sent one by one after the current reply finishes.',
  defaultModel: 'Default model for new chats',
  firstAvailable: 'First available model',
  defaultModelHint: 'You can still pick another model in each chat.',
  noModels: 'No models yet. Connect a provider in Accounts.',
  suggestions: 'Suggest follow-ups',
  suggestionsHint: 'After a reply, offer a few short prompts to continue with.',
  setupGuide: 'Setup guide',
  setupGuideHint: 'Walk through connecting a provider and running a sample task again.',
  openSetupGuide: 'Open the setup guide',
  ttl: 'Delete temporary chats after (hours)',
  ttlHint:
    'Temporary chats and their files are deleted this long after their last activity. {min} to {max, plural, one {# hour} other {# hours}}.',
  wholeRange: 'Enter a whole number from {min} to {max}.',
  numberRange: 'Enter a number from {min} to {max}.',
  workRuns: 'Work runs',
  workRunsHint: 'Defaults for new runs. A run pauses at a budget and asks before going further.',
  timeBudget: 'Time budget (minutes)',
  tokenBudget: 'Token budget',
  costLimit: 'Cost limit (US dollars)',
  costLimitHint: 'Blank uses the provider spend cap.',
  autonomy: 'Autonomy of new runs',
  escalation: 'Turn multi-step chat requests into runs',
  propose: 'Propose a run',
  proposeHint: 'Show the plan and budget in the chat; the run starts when you accept it.',
  auto: 'Start the run',
  autoHint: 'Start at once in the chat, with Stop always visible.',
  never: 'Never',
  neverHint: 'Answer in the chat without a run.',
});
const S = GENERAL_TEXT;

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
    toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' });

  const groups = modelGroups(models);

  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
      <section className="settings-section">
        <RadioGroup
          legend={S.sendWith}
          name="enter-to-send"
          value={enter.value}
          locked={enter.locked}
          onChange={(v) =>
            void settings.set('general.enterToSend', v as 'enter' | 'mod+enter').catch(fail)
          }
          options={[
            { value: 'enter', label: S.enter, description: S.enterHint },
            {
              value: 'mod+enter',
              label: bindingText('mod+enter', mac),
              description: S.modEnterHint,
            },
          ]}
        />
      </section>
      <section className="settings-section">
        <RadioGroup
          legend={S.followUp}
          name="follow-up"
          value={followUp.value}
          locked={followUp.locked}
          onChange={(v) =>
            void settings.set('general.followUp', v as 'steer' | 'queue').catch(fail)
          }
          options={[
            {
              value: 'steer',
              label: S.steer,
              description: S.steerHint,
            },
            {
              value: 'queue',
              label: S.queue,
              description: S.queueHint,
            },
          ]}
        />
      </section>
      <section className="settings-section">
        <TemporaryRetention onError={fail} />
      </section>
      <section className="settings-section">
        <SelectField
          label={S.defaultModel}
          value={model.value ?? ''}
          locked={model.locked}
          onChange={(v) => void settings.set('chat.defaultModel', v || null).catch(fail)}
          options={[{ value: '', label: S.firstAvailable }]}
          groups={groups}
          hint={models.length ? S.defaultModelHint : S.noModels}
        />
      </section>
      <section className="settings-section">
        <SwitchField
          label={S.suggestions}
          description={S.suggestionsHint}
          checked={suggestions.value}
          locked={suggestions.locked}
          onChange={(v) => void settings.set('chat.suggestions', v).catch(fail)}
        />
      </section>
      <WorkRunsSection onError={fail} />
      <section className="settings-section">
        <h3>{S.setupGuide}</h3>
        <p className="muted">{S.setupGuideHint}</p>
        <Button onClick={() => navigate('/onboarding')}>{S.openSetupGuide}</Button>
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
      label={S.ttl}
      hint={S.ttlHint({ min: TTL_MIN, max: TTL_MAX })}
      locked={ttl.locked}
      setting="chat.temporaryTtlHours"
      type="number"
      className="ws-number"
      inputMode="numeric"
      min={TTL_MIN}
      max={TTL_MAX}
      step={1}
      value={text}
      disabled={ttl.locked}
      error={invalid ? S.wholeRange({ min: TTL_MIN, max: TTL_MAX }) : undefined}
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
      <h3 id="work-runs-heading">{S.workRuns}</h3>
      <p className="muted">{S.workRunsHint}</p>
      <div className="work-budget-fields">
        <NumberSetting
          label={S.timeBudget}
          value={Math.round(b.timeSeconds / 60)}
          min={1}
          max={MAX_MINUTES}
          locked={budgets.locked}
          onSave={(n) => save({ timeSeconds: n * 60 })}
        />
        <NumberSetting
          label={S.tokenBudget}
          value={b.tokens}
          min={1_000}
          max={100_000_000}
          locked={budgets.locked}
          onSave={(n) => save({ tokens: n })}
        />
        <NumberSetting
          label={S.costLimit}
          value={b.costUsd}
          min={0}
          max={100_000}
          decimals
          locked={budgets.locked}
          hint={S.costLimitHint}
          onSave={(n) => save({ costUsd: n })}
        />
      </div>
      <RadioGroup
        legend={S.autonomy}
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
        legend={S.escalation}
        name="chat-escalation"
        value={escalation.value}
        locked={escalation.locked}
        onChange={(v) =>
          void settings.set('chat.escalation', v as 'propose' | 'auto' | 'off').catch(onError)
        }
        options={[
          {
            value: 'propose',
            label: S.propose,
            description: S.proposeHint,
          },
          {
            value: 'auto',
            label: S.auto,
            description: S.autoHint,
          },
          { value: 'off', label: S.never, description: S.neverHint },
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
      locked={locked}
      hint={hint}
      error={
        !invalid ? undefined : decimals ? S.numberRange({ min, max }) : S.wholeRange({ min, max })
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
