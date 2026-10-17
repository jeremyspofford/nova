// Settings → General (docs/14 §1.1): which key sends, the default model for new chats (FR-023),
// and the setup guide (FR-014).
import { Button, RadioGroup, SelectField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { PROVIDER_NAMES } from '../providers/names.ts';
import { bindingText } from '../keys.ts';
import { navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { useModels } from '../stores.tsx';

export function GeneralPage() {
  const { registry } = useServices();
  const settings = useSettings();
  const toast = useToast();
  const { models } = useModels();
  const enter = settings.get('general.enterToSend');
  const model = settings.get('chat.defaultModel');
  const mac = registry.platform.mac;

  const fail = (err: unknown) =>
    toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' });

  const groups = new Map<string, { label: string; options: { value: string; label: string }[] }>();
  for (const m of models) {
    const g = groups.get(m.providerAccountId) ?? {
      label: PROVIDER_NAMES[m.provider] ?? m.provider,
      options: [],
    };
    g.options.push({ value: m.ref, label: m.label });
    groups.set(m.providerAccountId, g);
  }

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
        <SelectField
          label="Default model for new chats"
          value={model.value ?? ''}
          locked={model.locked}
          onChange={(v) => void settings.set('chat.defaultModel', v || null).catch(fail)}
          options={[{ value: '', label: 'First available model' }]}
          groups={[...groups.values()]}
          hint={
            models.length
              ? 'You can still pick another model in each chat.'
              : 'No models yet. Connect a provider in Accounts.'
          }
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
