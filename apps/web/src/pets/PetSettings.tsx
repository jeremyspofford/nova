// Settings → Appearance → Companion (FR-012): off, one of Nova's two companions or a pet installed
// from the marketplace (M8, `market:<id>`), which corner it sits in, and Keep still. Saved to the
// Hub like the rest of Appearance; managed values are locked. More pets are a link away, in the
// marketplace's Pets tab.
import { RadioGroup, useToast } from '@nova/ui';
import type { SettingKey } from '@nova/shared';
import { errorMessage } from '../api.ts';
import { marketTabPath } from '../market/format.ts';
import { useInstalledPets } from '../market/MarketPet.tsx';
import { useMarketApi } from '../market/api-m8.ts';
import { navigate } from '../router.ts';
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

export const PET_TEXT = {
  installed: 'Installed from the marketplace',
  gone: 'A pet that is no longer installed',
  more: 'Get more pets in the Marketplace',
} as const;

export function PetSettings() {
  const settings = useSettings();
  const toast = useToast();
  const market = useMarketApi();
  const installed = useInstalledPets() ?? [];
  const pet = settings.get('appearance.pet');
  const position = settings.get('appearance.petPosition');
  const muted = settings.get('appearance.petMuted');

  const save = <K extends SettingKey>(key: K, value: SettingValue<K>) => {
    settings.set(key, value).catch((err: unknown) => {
      toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' });
    });
  };

  const options: { value: string; label: string; description?: string }[] = [
    ...PETS,
    ...installed.map((p) => ({
      value: `market:${p.id}`,
      label: p.name,
      description: PET_TEXT.installed,
    })),
  ];
  // The chosen pet was removed: keep it visible (and choosable away from).
  if (!options.some((o) => o.value === pet.value))
    options.push({ value: pet.value, label: PET_TEXT.gone });

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
        options={options}
        onChange={(v) => {
          if (options.some((o) => o.value === v)) save('appearance.pet', v);
        }}
      />
      {market ? (
        <p>
          <a
            href={marketTabPath('pets')}
            className="link"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigate(marketTabPath('pets'));
            }}
          >
            {PET_TEXT.more}
          </a>
        </p>
      ) : null}
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
