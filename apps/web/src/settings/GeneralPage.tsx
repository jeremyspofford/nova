// Settings → General (docs/14 §1.1): which key sends, what a message sent during a reply does
// (FR-019), how long temporary chats are kept (FR-027), the default model for new chats (FR-023),
// follow-up suggestions (FR-028) and the setup guide (FR-014).
import { useState } from 'react';
import { Button, RadioGroup, SelectField, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { modelGroups } from '../providers/model-groups.ts';
import { bindingText } from '../keys.ts';
import { navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useModels } from '../stores.tsx';
import { MANAGED } from './common.ts';
import { SwitchField } from './controls.tsx';
import '../workspace.css';

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
