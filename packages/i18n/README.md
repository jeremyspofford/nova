# @nova/i18n

Localization for Nova's UI (FR-016, ADR-097 D9), on the platform's `Intl` only: typed messages,
an ICU MessageFormat subset, the active locale, translation catalogs, the pseudo-locales `en-XA`
and `ar-XB`, and formatting helpers. Used by `apps/web`, `packages/ui` and `apps/desktop`.

## API

```ts
import { defineMessages, fmt, getLocale, setLocale, subscribe, localeDirection } from '@nova/i18n';

const S = defineMessages('market', {
  title: 'Marketplace', //                      S.title             → string
  resets: 'Resets {date}', //                   S.resets({ date })  → string
  items: '{n, plural, =0 {No items} one {# item} other {# items}}', // S.items({ n: 3 })
  kind: '{k, select, theme {Theme} other {Extension}}', //            S.kind({ k: 'theme' })
  install: { title: 'Install {name}?', confirm: 'Install' }, //        S.install.title({ name })
});
```

- `messageFor(group, key)`: the message under a runtime key (an error code), or undefined.
- `richMessage(S.msg, values)`: a message whose placeholders are elements (a link, a key cap,
  emphasis): the translated pieces with each value where the translation puts it. In the web,
  `rich(S.msg, { link: <a …>{S.linkText}</a> })` from `apps/web/src/i18n/rich.tsx` renders it.
- `defineMessages(namespace, literal)`: ids are `<namespace>.<key>` (nested keys joined by dots).
  Namespaces are lower camel case segments joined by dots (`market`, `shell.modes`) and unique
  in the repo. A message without placeholders reads as a string; one with placeholders is a
  function taking exactly those: plural arguments are numbers, select arguments strings, plain
  `{name}` arguments strings or numbers (numbers format in the locale). `S.resets()` and
  `S.items({ n: 'x' })` do not type-check. Every read translates in the active locale.
- Message syntax: `{name}`, `{n, plural, =0 {…} one {…} other {…}}` with `#`, `{x, select, a {…}
other {…}}`, nested freely; `other` is required. Quote syntax characters with apostrophes:
  `'{'` is a literal brace, `''` an apostrophe; any other apostrophe is plain text (`Don't`).
- `setLocale(tag)`, `getLocale()`, `subscribe(fn)`; `localeDirection(tag)` is `rtl` for Arabic,
  Hebrew, Thaana, Syriac, N'Ko, Adlam and Hanifi Rohingya scripts and for `ar-XB`.
- `registerCatalog(locale, namespace, entries)`, `setCatalogLoader(fn)`, `loadLocale(tag)`:
  translations; a missing or broken translation falls back to the English source (with English
  plural rules). `ar-EG` also uses `ar`.
- `pseudoLocalize(message, 'en-XA' | 'ar-XB')`: `en-XA` accents every letter, brackets the
  message and makes it about 35 % longer; `ar-XB` wraps every word in right-to-left override
  marks. Placeholders and plural/select syntax stay intact.
- `fmt.number`, `percent`, `bytes`, `date`, `time`, `dateTime`, `relative`, `list`, `duration`:
  formatting in the active locale. English keeps the compact forms the UI used ("1.5 MB",
  "2 min 5 s"); under a pseudo-locale the output is transformed too, so a value formatted any
  other way stands out in tests.
- `@nova/i18n/check` (Node only) is the logic behind `npm run i18n:check`,
  `@nova/i18n/eslint` the `nova-i18n` ESLint plugin, and `@nova/i18n/testing` the DOM check
  (`findUnlocalized`) the web and `packages/ui` tests share.

## The guards

- `npm run i18n:check` (part of `npm run lint`): collects every `defineMessages` call in
  `apps/web/src`, `packages/ui/src` and `apps/desktop/src`; fails on a non-literal argument, a
  message that does not parse, a duplicate namespace or id, a stale
  `apps/web/src/i18n/catalog.en.json`, and on translations
  (`apps/web/src/i18n/locales/<locale>/<namespace>.json`, `{ "key.nested": "…" }`) whose key no
  longer exists or whose placeholders, plural or select arguments differ from the English, or
  that use a plural form the locale lacks. It prints the coverage per locale.
  `npm run i18n:write` rewrites the English catalog: run it after changing messages.
- ESLint `nova-i18n/no-literal-ui-text` is an error in the files listed in `I18N_CONVERTED` at
  the top of `eslint.config.js` (one glob per line, sorted): JSX text with letters, and literal
  strings for `aria-label`, `title`, `placeholder`, `alt`, `label`, `hint`, `description`,
  `empty`, `what` and the other text props (`TEXT_PROPS` in `src/eslint-rule.ts`), as attributes
  or as object properties (menu items, tabs, options). Punctuation, symbols and `Nova` pass.
- `apps/web/test/i18n.ts`: `renderInLocale(locale, ui)` and
  `expectFullyLocalized(container, { data, skip })`.

## How to extract an area

1. **Messages live in the area's existing strings object.** Convert `X_TEXT = { … }` objects in
   `format.ts` (or the component's `strings` object) in place to `defineMessages` with a
   namespace named after the area. Keep the export name, so call sites barely change.

   Before:

   ```ts
   export const SWEEP_TEXT = {
     kept: 'Kept forever',
     due: (date: string, what: string) => `${what} older than ${date} are removed next`,
     removed: (n: number) => (n === 1 ? '1 item removed' : `${n} items removed`),
     sweptAt: (when: string) => `Last swept ${when}`,
   };
   // <span>{SWEEP_TEXT.removed(count)}</span> <span>{SWEEP_TEXT.sweptAt(formatWhen(at))}</span>
   ```

   After:

   ```ts
   export const SWEEP_TEXT = defineMessages('datactl.sweep', {
     kept: 'Kept forever',
     due: '{what} older than {date} are removed next',
     removed: '{n, plural, one {# item removed} other {# items removed}}',
     sweptAt: 'Last swept {when}',
   });
   // <span>{SWEEP_TEXT.removed({ n: count })}</span>
   // <span>{SWEEP_TEXT.sweptAt({ when: fmt.relative(at) })}</span>
   ```

2. **Functions that build text become placeholder messages** with named params. Never build a
   sentence from fragments (`'Add ' + kind + ' pane'`): one message per sentence or label. A
   placeholder carries data (a name, a date, a count) or a separately translated noun label; when
   the words around it change with the value, use `select` with one branch per value.
3. **Plurals use ICU plural**, never `n === 1 ? … : …`; Arabic has six forms and translators
   need the whole message.
4. **Dates, numbers, sizes, durations and lists use `fmt`**, never `toLocaleString()` without a
   locale or hand-built units.
5. **Read messages at render time.** A message read at module load (`const LABEL = S.title`)
   freezes in English. Maps keyed by enum values become nested messages
   (`defineMessages('agents.autonomy', { ask: { label: 'Ask', description: '…' } })`), and a
   lookup by a key from elsewhere keeps its fallback: `messageFor(S.reason, code) ?? S.other`.
   Command titles are read when the command registers; the shell remounts on a language change,
   so register commands in an effect inside it. Use `CATEGORY` from `apps/web/src/commands.ts`
   for command categories.
6. **Hub text stays English in M8** (error `message`s, notification bodies the Hub writes):
   keep mapping error codes to the area's own words (those are messages), and pass Hub text in a
   test's `data`.
7. **Turn the guard on:** add the area's folder to `I18N_CONVERTED` in `eslint.config.js` (keep
   the list sorted, one glob per line), run `npx eslint <folder>` and `npm run i18n:write`, then
   `npm run i18n:check`.
8. **Write the area's pseudo-locale test** (`apps/web/test/<area>-i18n.test.tsx`):

   ```tsx
   import { renderInLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
   afterEach(() => {
     resetDom();
     resetTestLocale();
   });

   it('shows the area fully localized in en-XA', async () => {
     const hub = createHub({ m8market: { items: [item({ name: 'Solar theme' })] } });
     await renderInLocale('en-XA', <App api={hub.api} {...defaults} />); // or the bare component
     const page = await screen.findByRole('region', { name: MARKET_TEXT.title });
     expectFullyLocalized(page, { data: ['Solar theme'], skip: ['.not-yet-converted'] });
   });
   ```

   Query by the message itself (`MARKET_TEXT.title`): under `en-XA` it returns the pseudo text.
   `data` lists fixture strings (names, titles, Hub messages); numbers, URLs, `ext:`/`mcp:` ids,
   `<kbd>`, `<code>`, `<pre>`, `translate="no"` and the word Nova are always allowed. Existing
   tests stay in English and keep passing unchanged.

Gotchas:

- A sentence with an element inside (`Press <Kbd/> to stop`) is one rich message
  (`'Press {key} to stop.'` with `rich()`), never text pieces around the element.
- Key caps stay as printed on the keyboard (`Ctrl`, `Shift`, `⌘`, from `keys.ts`); `Kbd` reads
  their spoken names from `KEY_TEXT` in `@nova/ui` ("Ctrl plus K" becomes the locale's words).
  A binding written into a sentence (`bindingText`) is a placeholder value; pass it in a test's
  `data`, or show it with `Kbd`.
- `MANAGED_TEXT` from `@nova/ui` follows the locale only when read at render time; prefer
  `UI_TEXT.managed`. Copying it into a module-level constant freezes English.
- `as const` or `satisfies` around the literal object is fine; spreads and variables are not.

- Call `defineMessages` with a literal object (no spreads, computed keys or variables); keys may
  not contain dots. A message with placeholders must stay one string literal (joining literals
  with `+` makes its type a plain `string`, so it loses its typed params and `tsc` fails); only a
  message without placeholders may be split with `+`.
- Do not start a message key with `use` (`S.useTheme(...)`): React's hooks lint rule reads the call
  as a hook.
- `richMessage` / `rich()` put elements (links, key caps) into a sentence; pass strings and numbers
  among the values as they are, so a plural or select placeholder still picks its branch.
- `import.meta.glob` must stay without a type argument (`import.meta.glob(…) as …`): Vitest's
  module cache only skips files containing the exact text `import.meta.glob(`.
- Object properties named like text props (`label: 'Edit'`) are flagged in converted folders even
  outside JSX; data that is not UI text can use another key or an `eslint-disable-next-line`
  with the reason.
