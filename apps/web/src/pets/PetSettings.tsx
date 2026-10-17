// Settings → Appearance → Companion (FR-012): off or one of two companions, which corner it sits
// in, and Keep still. Saved to the Hub like the rest of Appearance; managed values are locked.
import { RadioGroup, useToast } from '@nova/ui';
import type { SettingKey } from '@nova/shared';
import { errorMessage } from '../api.ts';
import { useSettings, type SettingValue } from '../settings.tsx';
import { SwitchField } from '../settings/controls.tsx';

const PETS = [
  { value: 'off', label: 'Off' },
  { value: 'sprout', label: 'Sprout', description: 'A round friend with a leaf.' },
  { value: 'spark', label: 'Spark', description: 'A small star.' },
] as const;

const POSITIONS = [
  { value: 'bottom-right', label: 'Bottom right' },
  { value: 'bottom-left', label: 'Bottom left' },
] as const;

export function PetSettings() {
  const settings = useSettings();
  const toast = useToast();
  const pet = settings.get('appearance.pet');
  const position = settings.get('appearance.petPosition');
  const muted = settings.get('appearance.petMuted');

  const save = <K extends SettingKey>(key: K, value: SettingValue<K>) => {
    settings.set(key, value).catch((err: unknown) => {
      toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' });
    });
  };

  return (
    <section className="settings-section" aria-labelledby="appearance-pet">
      <h3 id="appearance-pet">Companion</h3>
      <p className="muted">
        A small companion in a corner of the window that reacts to what Nova is doing. It never
        takes clicks or focus, and it holds still when motion is reduced.
      </p>
      <RadioGroup
        legend="Companion"
        name="pet"
        value={pet.value}
        locked={pet.locked}
        options={[...PETS]}
        onChange={(v) => {
          const next = PETS.find((p) => p.value === v);
          if (next) save('appearance.pet', next.value);
        }}
      />
      {pet.value === 'off' ? null : (
        <>
          <RadioGroup
            legend="Where it sits"
            name="pet-position"
            value={position.value}
            locked={position.locked}
            options={[...POSITIONS]}
            onChange={(v) => {
              const next = POSITIONS.find((p) => p.value === v);
              if (next) save('appearance.petPosition', next.value);
            }}
          />
          <SwitchField
            label="Keep still"
            description="It stays in its resting pose instead of reacting."
            checked={muted.value}
            locked={muted.locked}
            onChange={(v) => save('appearance.petMuted', v)}
          />
        </>
      )}
    </section>
  );
}
