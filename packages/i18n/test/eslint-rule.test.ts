import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import plugin, { TEXT_PROPS, noLiteralUiText } from '../src/eslint-rule.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const tsx = (code: string) => ({ code, filename: 'view.tsx' });

describe('nova-i18n/no-literal-ui-text', () => {
  it('exports the plugin and a sorted prop list', () => {
    if (plugin.rules['no-literal-ui-text'] !== noLiteralUiText) throw new Error('plugin rule');
    if ([...TEXT_PROPS].sort().join() !== TEXT_PROPS.join())
      throw new Error('keep TEXT_PROPS sorted');
  });

  tester.run('no-literal-ui-text', noLiteralUiText, {
    valid: [
      tsx(`const a = <p>{S.title}</p>;`),
      tsx(`const a = <p>{S.count({ n })} · {name}</p>;`),
      tsx(`const a = <span>· — / : ( ) 42 %</span>;`),
      tsx(`const a = <span className="brand">Nova</span>;`),
      tsx(`const a = <button aria-label={S.close} title={busy ? S.saving : S.save} />;`),
      tsx(`const a = <a href="/settings/general" className="mode-link" id="x" />;`),
      tsx(`const a = <Menu items={[{ id: 'split', label: S.split }]} />;`),
      tsx(
        `const S = defineMessages('area', { title: 'Area', label: 'Label', nested: { title: 'T' } });`,
      ),
      tsx(`const a = <input placeholder="…" />;`),
      { ...tsx(`const a = <p>Acme</p>;`), options: [{ allow: ['Acme'] }] },
      tsx(`const x = { kind: 'label', value: 'title' };`),
      tsx(`const caps = { ctrl: 'Ctrl', alt: 'Alt' };`),
    ],
    invalid: [
      { ...tsx(`const a = <p>Hello there</p>;`), errors: [{ messageId: 'text' }] },
      { ...tsx(`const a = <p>{'Hello'}</p>;`), errors: [{ messageId: 'text' }] },
      { ...tsx('const a = <p>{`${n} items`}</p>;'), errors: [{ messageId: 'text' }] },
      { ...tsx(`const a = <p>{busy ? 'Saving' : S.save}</p>;`), errors: [{ messageId: 'text' }] },
      { ...tsx(`const a = <p>{error && 'Failed'}</p>;`), errors: [{ messageId: 'text' }] },
      {
        ...tsx(`const a = <button aria-label="Close" />;`),
        errors: [{ messageId: 'prop', data: { prop: 'aria-label', text: 'Close' } }],
      },
      { ...tsx(`const a = <input placeholder={'Search'} />;`), errors: [{ messageId: 'prop' }] },
      { ...tsx('const a = <img alt={`Photo of ${who}`} />;'), errors: [{ messageId: 'prop' }] },
      { ...tsx(`const a = <Field hint={x ? S.a : 'Plain'} />;`), errors: [{ messageId: 'prop' }] },
      {
        ...tsx(`const a = <Menu items={[{ id: 'split', label: 'Split right' }]} />;`),
        errors: [{ messageId: 'prop', data: { prop: 'label', text: 'Split right' } }],
      },
      { ...tsx(`const c = { id: 'x', 'aria-label': 'Open' };`), errors: [{ messageId: 'prop' }] },
      { ...tsx(`const a = <p>العربية</p>;`), errors: [{ messageId: 'text' }] },
    ],
  });
});
