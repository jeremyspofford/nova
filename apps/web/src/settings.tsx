// Client view of Hub settings (docs/14 §1). The Hub owns the values (FR-125); this store mirrors
// GET /settings, applies writes optimistically, and rolls back if the Hub rejects them. A setting
// another page or device changes through its own route (the Relay, the network panel) arrives as
// `settings.changed`, and the store reloads. Turning on a consent switch (M7.5: low-level boot,
// network boot) carries `confirm: true` after its dialog; the Hub refuses it otherwise.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { SETTINGS, type SettingKey, type SettingValue as SharedValue } from '@nova/shared';
import type { ThemeChoice } from '@nova/ui';
import type { Api, ResolvedSetting } from './api.ts';
import { useHubStream } from './hub-events.ts';
import { STORE_TEXT } from './strings.ts';

export type OnboardingStep = 'provider' | 'model' | 'profile' | 'tool' | 'sample' | 'done';

/**
 * Precise types for enum-valued settings. @nova/shared widens their defaults to `string`; values
 * are still checked against the shared schemas at runtime in `get`.
 */
interface NarrowTypes {
  'appearance.theme': ThemeChoice;
  'appearance.reducedMotion': 'system' | 'on' | 'off';
  'general.enterToSend': 'enter' | 'mod+enter';
  'general.followUp': 'steer' | 'queue';
  'onboarding.state': { step: OnboardingStep; completed: boolean; skipped: boolean };
}

export type SettingValue<K extends SettingKey> = K extends keyof NarrowTypes
  ? NarrowTypes[K]
  : SharedValue<K>;

export interface SettingEntry<K extends SettingKey> {
  value: SettingValue<K>;
  locked: boolean;
  source: ResolvedSetting['source'];
}

/** A write's options: `confirm` once the owner confirmed what a consent switch allows. */
export interface SetSettingOptions {
  confirm?: boolean;
}

export interface SettingsStore {
  get<K extends SettingKey>(key: K): SettingEntry<K>;
  set<K extends SettingKey>(
    key: K,
    value: SettingValue<K>,
    opts?: SetSettingOptions,
  ): Promise<void>;
}

/** The client the store writes through: `PATCH /api/v1/settings` (`confirm` in its body). */
export type SettingsClient = Pick<Api, 'settings'> & {
  setSetting: (
    key: string,
    value: unknown,
    opts?: SetSettingOptions,
  ) => Promise<{ settings: ResolvedSetting[] }>;
};

const Ctx = createContext<SettingsStore | null>(null);

function toMap(list: ResolvedSetting[]): Map<string, ResolvedSetting> {
  return new Map(list.map((s) => [s.key, s]));
}

export function SettingsProvider({
  api,
  initial,
  children,
}: {
  api: SettingsClient;
  initial: ResolvedSetting[];
  children: ReactNode;
}) {
  const [values, setValues] = useState(() => toMap(initial));
  const latest = useRef(values);
  useEffect(() => {
    latest.current = values;
  });
  // One reload at a time; a change during a reload asks for one more.
  const reload = useRef<{ running: boolean; again: boolean }>({ running: false, again: false });
  const refresh = useCallback(() => {
    const r = reload.current;
    if (r.running) {
      r.again = true;
      return;
    }
    r.running = true;
    void (async () => {
      do {
        r.again = false;
        try {
          const { settings } = await api.settings();
          setValues(toMap(settings));
        } catch {
          // The next change or a page reload catches up; the values shown stay the last known.
        }
      } while (r.again);
      r.running = false;
    })();
  }, [api]);
  useHubStream(['settings.changed'], refresh);

  const get = useCallback(
    <K extends SettingKey>(key: K): SettingEntry<K> => {
      const def = SETTINGS[key];
      const row = values.get(key);
      // A value the client cannot parse falls back to the default rather than breaking the UI.
      const parsed = row ? def.schema.safeParse(row.value) : null;
      return {
        value: (parsed?.success ? parsed.data : def.default) as SettingValue<K>,
        locked: row?.locked ?? false,
        source: row?.source ?? 'default',
      };
    },
    [values],
  );

  const set = useCallback(
    async <K extends SettingKey>(
      key: K,
      value: SettingValue<K>,
      opts: SetSettingOptions = {},
    ): Promise<void> => {
      const before = latest.current.get(key);
      if (before?.locked) throw new Error(STORE_TEXT.locked({ key }));
      setValues((m) => {
        const next = new Map(m);
        next.set(key, { key, value, source: 'global', locked: false });
        return next;
      });
      try {
        const { settings } = await (opts.confirm
          ? api.setSetting(key, value, { confirm: true })
          : api.setSetting(key, value));
        if (settings.length) setValues(toMap(settings));
      } catch (err) {
        setValues((m) => {
          const next = new Map(m);
          if (before) next.set(key, before);
          else next.delete(key);
          return next;
        });
        throw err;
      }
    },
    [api],
  );

  const store = useMemo<SettingsStore>(() => ({ get, set }), [get, set]);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsStore {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSettings must be used inside <SettingsProvider>');
  return s;
}

export function useSetting<K extends SettingKey>(key: K): SettingEntry<K> {
  return useSettings().get(key);
}
