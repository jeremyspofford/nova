// Settings → Appearance → Language (FR-016): System (the device's language when Nova has it),
// each language by its own name (Arabic marked partly translated), and the pseudo-locales under
// "For testing". Radios, not a select: the choice is short and every option stays visible. The
// change applies at once: the shell remounts in the new language, so this picker is a new one;
// focus comes back to the option chosen and the change is said in the new language (WCAG 3.2.2).
import { useEffect, useRef } from 'react';
import { getLocale } from '@nova/i18n';
import { RadioGroup, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { useSettings, type SettingValue } from '../settings.tsx';
import {
  LANGUAGE_TEXT,
  LOCALES,
  deviceLanguages,
  localeInfo,
  resolveLocale,
  type LocaleInfo,
} from './locales.ts';

const optionLabel = (l: LocaleInfo) =>
  l.partial ? LANGUAGE_TEXT.partial({ name: l.name }) : l.name;

/**
 * One shot, set just before a change of language and read by the picker the remounted shell
 * shows: the option to focus, the locale the shell is then in, and what to say there once the Hub
 * has answered (the change, or why it refused it). A marker older than this is dropped (the switch
 * never happened, e.g. a pinned locale).
 */
interface Refocus {
  value: string;
  locale: string;
  at: number;
  /** The Hub saved the change. */
  saved: boolean;
  /** The Hub's reason for refusing it, or null. */
  failed: string | null;
}
let refocus: Refocus | null = null;
const REFOCUS_MS = 10_000;

/** The radio of `value` in `root` (the two fieldsets share one name). */
const radioOf = (root: ParentNode | null | undefined, value: string) =>
  [...(root?.querySelectorAll<HTMLInputElement>('input[type="radio"][name="locale"]') ?? [])].find(
    (i) => i.value === value,
  );

export function LanguageSection() {
  const settings = useSettings();
  const toast = useToast();
  const announce = useAnnounce();
  const section = useRef<HTMLElement>(null);
  const entry = settings.get('appearance.locale');
  const system = localeInfo(resolveLocale('system', deviceLanguages())) ?? LOCALES[0]!;

  // Read when said, so in the language the shell is in by then (the live region and the toasts
  // sit outside the shell, so they outlive its remount).
  const sayChanged = (locale: string) =>
    announce(LANGUAGE_TEXT.changed({ name: localeInfo(locale)?.name ?? locale }));
  const sayFailed = (reason: string) =>
    toast.show(LANGUAGE_TEXT.saveFailed({ reason }), { tone: 'error' });

  useEffect(() => {
    const r = refocus;
    if (!r || r.locale !== getLocale()) return;
    refocus = null;
    if (Date.now() - r.at > REFOCUS_MS) return;
    radioOf(section.current, r.value)?.focus();
    // While the Hub has not answered yet, its answer says it (in `choose`).
    if (r.failed !== null) sayFailed(r.failed);
    else if (r.saved) sayChanged(r.locale);
    // Once, on mount: the marker is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = (value: string) => {
    // Only a change of language remounts the shell (System may resolve to the one in use).
    const before = { value: entry.value as string, locale: getLocale() };
    const locale = resolveLocale(value, deviceLanguages());
    const mark: Refocus | null =
      locale !== before.locale
        ? { value, locale, at: Date.now(), saved: false, failed: null }
        : null;
    refocus = mark;
    settings.set('appearance.locale', value as SettingValue<'appearance.locale'>).then(
      () => {
        if (!mark) return;
        // The new picker already took focus: say the change now; else it says it on mount.
        if (refocus === mark) mark.saved = true;
        else sayChanged(locale);
      },
      (err: unknown) => {
        // The Hub kept the old language: the shell goes back to it when it had switched, and
        // focus and the refusal follow there; otherwise both happen here and now.
        const reason = errorMessage(err);
        if (getLocale() !== before.locale) {
          refocus = { ...before, at: Date.now(), saved: false, failed: reason };
          return;
        }
        refocus = null;
        radioOf(document, before.value)?.focus();
        sayFailed(reason);
      },
    );
  };

  // Two radio fieldsets sharing one name: the languages, then the pseudo-locales for testing.
  return (
    <section ref={section} className="settings-section" aria-labelledby="appearance-language">
      <h3 id="appearance-language" className="nv-vh">
        {LANGUAGE_TEXT.label}
      </h3>
      <RadioGroup
        legend={LANGUAGE_TEXT.label}
        name="locale"
        hint={LANGUAGE_TEXT.hint}
        value={entry.value}
        locked={entry.locked}
        onChange={choose}
        options={[
          { value: 'system', label: LANGUAGE_TEXT.system({ name: optionLabel(system) }) },
          ...LOCALES.filter((l) => !l.testing).map((l) => ({
            value: l.tag,
            label: optionLabel(l),
          })),
        ]}
      />
      <RadioGroup
        legend={LANGUAGE_TEXT.testing}
        name="locale"
        value={entry.value}
        locked={entry.locked}
        onChange={choose}
        options={LOCALES.filter((l) => l.testing).map((l) => ({ value: l.tag, label: l.name }))}
      />
    </section>
  );
}
