// Settings → Appearance → Companion (FR-012): off, one of Nova's two companions or a pet installed
// from the marketplace (M8, `market:<id>`), which corner it sits in, and Keep still. Saved to the
// Hub like the rest of Appearance; managed values are locked. More pets are a link away, in the
// marketplace's Pets tab.
import { defineMessages } from '@nova/i18n';
import { RadioGroup, useToast } from '@nova/ui';
import type { SettingKey } from '@nova/shared';
import { errorMessage } from '../api.ts';
import { marketTabPath } from '../market/format.ts';
import { useInstalledPets } from '../market/MarketPet.tsx';
import { useMarketApi } from '../market/api-m8.ts';
import { navigate } from '../router.ts';
import { useSettings, type SettingValue } from '../settings.tsx';
import { SwitchField } from '../settings/controls.tsx';

export const PET_TEXT = defineMessages('pets', {
  off: 'Off',
  sprout: { name: 'Sprout', description: 'A round friend with a leaf.' },
  spark: { name: 'Spark', description: 'A small star.' },
  position: { bottomRight: 'Bottom right', bottomLeft: 'Bottom left' },
  installed: 'Installed from the marketplace',
  gone: 'A pet that is no longer installed',
  more: 'Get more pets in the Marketplace',
  saveFailed: 'Could not save: {reason}',
  title: 'Companion',
  intro:
    'A small companion in a corner of the window that reacts to what Nova is doing. It never takes clicks or focus, and it holds still when motion is reduced.',
  where: 'Where it sits',
  keepStill: 'Keep still',
  keepStillHint: 'It stays in its resting pose instead of reacting.',
});

const POSITIONS = ['bottom-right', 'bottom-left'] as const;

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
      toast.show(PET_TEXT.saveFailed({ reason: errorMessage(err) }), { tone: 'error' });
    });
  };

  const options: { value: string; label: string; description?: string }[] = [
    { value: 'off', label: PET_TEXT.off },
    { value: 'sprout', label: PET_TEXT.sprout.name, description: PET_TEXT.sprout.description },
    { value: 'spark', label: PET_TEXT.spark.name, description: PET_TEXT.spark.description },
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
      <h3 id="appearance-pet">{PET_TEXT.title}</h3>
      <p className="muted">{PET_TEXT.intro}</p>
      <RadioGroup
        legend={PET_TEXT.title}
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
            legend={PET_TEXT.where}
            name="pet-position"
            value={position.value}
            locked={position.locked}
            options={[
              { value: 'bottom-right', label: PET_TEXT.position.bottomRight },
              { value: 'bottom-left', label: PET_TEXT.position.bottomLeft },
            ]}
            onChange={(v) => {
              const next = POSITIONS.find((p) => p === v);
              if (next) save('appearance.petPosition', next);
            }}
          />
          <SwitchField
            label={PET_TEXT.keepStill}
            description={PET_TEXT.keepStillHint}
            checked={muted.value}
            locked={muted.locked}
            onChange={(v) => save('appearance.petMuted', v)}
          />
        </>
      )}
    </section>
  );
}
