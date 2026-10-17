import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry, filterCommands, fuzzyScore } from '../src/commands.ts';
import {
  ariaKeyShortcut,
  bindingText,
  browserAlternate,
  detectPlatform,
  evaluateWhen,
  eventToBinding,
  formatBinding,
  matchesBinding,
  normalizeBinding,
  typesCharacter,
  type KeyLike,
} from '../src/keys.ts';

const ev = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code: '',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('binding grammar (FR-004)', () => {
  it('normalizes order, aliases and platform modifiers', () => {
    expect(normalizeBinding('Shift+Mod+P', false)).toBe('mod+shift+p');
    expect(normalizeBinding('ctrl+k', false)).toBe('mod+k');
    expect(normalizeBinding('ctrl+`', true)).toBe('ctrl+`');
    expect(normalizeBinding('cmd+k', true)).toBe('mod+k');
    expect(normalizeBinding('meta+k', true)).toBe('mod+k');
    expect(normalizeBinding('Esc', false)).toBe('escape');
    expect(normalizeBinding('option+shift+n', true)).toBe('alt+shift+n');
    expect(normalizeBinding('mod++', false)).toBe('mod++');
    expect(normalizeBinding('mod+plus', false)).toBe('mod++');
  });

  it('rejects invalid bindings', () => {
    expect(normalizeBinding('', false)).toBeNull();
    expect(normalizeBinding('hyper+k', false)).toBeNull();
    expect(normalizeBinding('mod+shift', false)).toBeNull();
    expect(normalizeBinding('mod+', false)).toBeNull();
  });

  it('turns key events into bindings, ignoring lone modifiers', () => {
    expect(eventToBinding(ev('k', { ctrlKey: true }), false)).toBe('mod+k');
    expect(eventToBinding(ev('k', { metaKey: true }), true)).toBe('mod+k');
    expect(eventToBinding(ev('k', { ctrlKey: true }), true)).toBe('ctrl+k');
    expect(eventToBinding(ev('P', { ctrlKey: true, shiftKey: true }), false)).toBe('mod+shift+p');
    expect(eventToBinding(ev('Shift', { shiftKey: true }), false)).toBeNull();
    expect(eventToBinding(ev('Escape'), false)).toBe('escape');
    expect(eventToBinding(ev(' '), false)).toBe('space');
    expect(eventToBinding(ev('Unidentified', { code: 'KeyQ' }), false)).toBe('q');
    // Option changes the character on macOS; the physical key still matches.
    expect(eventToBinding(ev('˜', { altKey: true, code: 'KeyN' }), true)).toBe('alt+n');
    expect(eventToBinding(ev('!', { ctrlKey: true, shiftKey: true, code: 'Digit1' }), false)).toBe(
      'mod+shift+1',
    );
    expect(eventToBinding(ev('?', { shiftKey: true, code: 'Slash' }), false)).toBe('shift+/');
    expect(eventToBinding(ev('k', { metaKey: true }), false)).toBe('meta+k');
    expect(eventToBinding(ev(',', { ctrlKey: true }), false)).toBe('mod+,');
  });

  it('matches per platform', () => {
    expect(matchesBinding(ev('k', { ctrlKey: true }), 'mod+k', false)).toBe(true);
    expect(matchesBinding(ev('k', { metaKey: true }), 'mod+k', true)).toBe(true);
    expect(matchesBinding(ev('k', { metaKey: true }), 'mod+k', false)).toBe(false);
    expect(matchesBinding(ev('k', { ctrlKey: true }), 'k', false)).toBe(false);
    expect(matchesBinding(ev('k'), 'nonsense+k', false)).toBe(false);
  });

  it('formats for display and ARIA', () => {
    expect(formatBinding('mod+shift+p', false)).toEqual(['Ctrl', 'Shift', 'P']);
    expect(formatBinding('mod+shift+p', true)).toEqual(['⌘', '⇧', 'P']);
    expect(formatBinding('escape', false)).toEqual(['Esc']);
    expect(formatBinding('alt+arrowup', false)).toEqual(['Alt', '↑']);
    expect(formatBinding('mod++', false)).toEqual(['Ctrl', '+']);
    expect(bindingText('mod+,', false)).toBe('Ctrl+,');
    expect(bindingText('mod+k', true)).toBe('⌘K');
    expect(ariaKeyShortcut('mod+k', false)).toBe('Control+K');
    expect(ariaKeyShortcut('mod+k', true)).toBe('Meta+K');
    expect(ariaKeyShortcut('escape', false)).toBe('Escape');
  });

  it('offers Alt variants for keys a browser tab cannot capture', () => {
    expect(browserAlternate('mod+n', false)).toBe('alt+n');
    expect(browserAlternate('mod+shift+n', true)).toBe('alt+shift+n');
    expect(typesCharacter('k')).toBe(true);
    expect(typesCharacter('shift+k')).toBe(true);
    expect(typesCharacter('escape')).toBe(false);
    expect(typesCharacter('mod+k')).toBe(false);
  });

  it('detects the platform from the browser', () => {
    expect(detectPlatform()).toEqual({ mac: false, browserTab: true });
  });
});

describe('when-clauses', () => {
  it('evaluates identifiers, negation, comparisons, && and ||', () => {
    const ctx = { mode: 'chat', streaming: true, dialogOpen: false, empty: '' };
    expect(evaluateWhen(undefined, ctx)).toBe(true);
    expect(evaluateWhen('  ', ctx)).toBe(true);
    expect(evaluateWhen('streaming', ctx)).toBe(true);
    expect(evaluateWhen('!dialogOpen', ctx)).toBe(true);
    expect(evaluateWhen('empty', ctx)).toBe(false);
    expect(evaluateWhen('missing', ctx)).toBe(false);
    expect(evaluateWhen('mode == chat && streaming', ctx)).toBe(true);
    expect(evaluateWhen('mode != chat', ctx)).toBe(false);
    expect(evaluateWhen('mode == code || streaming', ctx)).toBe(true);
    expect(evaluateWhen('mode == code || dialogOpen', ctx)).toBe(false);
    expect(evaluateWhen('missing == ', ctx)).toBe(false);
  });
});

describe('CommandRegistry', () => {
  const noop = () => undefined;

  it('registers, lists, runs and unregisters commands', () => {
    const r = new CommandRegistry({ mac: false, browserTab: false });
    const run = vi.fn();
    const off = r.register({ id: 'x', title: 'X', category: 'C', run });
    expect(() => r.register({ id: 'x', title: 'X', category: 'C', run })).toThrow(
      /already registered/,
    );
    expect(r.run('x')).toBe(true);
    expect(r.run('missing')).toBe(false);
    expect(r.get('x')?.title).toBe('X');
    const v = r.version();
    off();
    expect(r.list()).toEqual([]);
    expect(r.version()).toBeGreaterThan(v);
  });

  it('applies user remappings, unbinding and resets', () => {
    const r = new CommandRegistry({ mac: false, browserTab: false });
    r.register({
      id: 'a',
      title: 'A',
      category: 'C',
      binding: ['mod+k', 'mod+shift+p'],
      run: noop,
    });
    expect(r.bindingsFor('a')).toEqual(['mod+k', 'mod+shift+p']);
    expect(r.isCustomized('a')).toBe(false);
    r.setUserBindings({ a: 'ctrl+j' });
    expect(r.bindingsFor('a')).toEqual(['mod+j']);
    expect(r.isCustomized('a')).toBe(true);
    r.setUserBindings({ a: '' });
    expect(r.bindingsFor('a')).toEqual([]);
    const v = r.version();
    r.setUserBindings({ a: '' });
    expect(r.version()).toBe(v);
    r.setUserBindings({});
    expect(r.primaryBinding('a')).toBe('mod+k');
    expect(r.userBindings()).toEqual({});
  });

  it('looks up by keystroke and prefers scoped commands in context', () => {
    const r = new CommandRegistry({ mac: false, browserTab: false });
    const stop = vi.fn();
    const close = vi.fn();
    r.register({ id: 'close', title: 'Close', category: 'C', binding: 'escape', run: close });
    r.register({
      id: 'stop',
      title: 'Stop',
      category: 'C',
      binding: 'escape',
      when: 'streaming',
      run: stop,
    });
    expect(r.match(ev('Escape'), { streaming: true })?.id).toBe('stop');
    expect(r.match(ev('Escape'), { streaming: false })?.id).toBe('close');
    expect(r.match(ev('Shift', { shiftKey: true }), {})).toBeUndefined();
    expect(
      r
        .commandsFor('esc')
        .map((c) => c.id)
        .sort(),
    ).toEqual(['close', 'stop']);
    expect(r.commandsFor('bogus+x')).toEqual([]);
  });

  it('detects conflicts between overlapping scopes only', () => {
    const r = new CommandRegistry({ mac: false, browserTab: false });
    r.register({ id: 'a', title: 'A', category: 'C', binding: 'mod+j', run: noop });
    r.register({ id: 'b', title: 'B', category: 'C', binding: 'mod+j', run: noop });
    r.register({
      id: 'c',
      title: 'C',
      category: 'C',
      binding: 'escape',
      when: 'streaming',
      run: noop,
    });
    r.register({
      id: 'd',
      title: 'D',
      category: 'C',
      binding: 'escape',
      when: 'dialogOpen',
      run: noop,
    });
    expect(r.conflicts()).toEqual([{ binding: 'mod+j', ids: ['a', 'b'] }]);
    expect(r.conflictsWith('c', 'mod+j').map((c) => c.id)).toEqual(['a', 'b']);
    expect(r.conflictsWith('c', 'escape')).toEqual([]);
    r.setUserBindings({ b: 'mod+u' });
    expect(r.conflicts()).toEqual([]);
  });

  it('shows the Alt variant of browser-reserved keys in a browser tab and matches both', () => {
    const r = new CommandRegistry({ mac: false, browserTab: true });
    const run = vi.fn();
    r.register({ id: 'n', title: 'New chat', category: 'Chat', binding: 'mod+n', run });
    expect(r.bindingsFor('n')).toEqual(['alt+n', 'mod+n']);
    expect(r.match(ev('n', { altKey: true, code: 'KeyN' }), {})?.id).toBe('n');
    expect(r.match(ev('n', { ctrlKey: true }), {})?.id).toBe('n');
    r.setUserBindings({ n: 'mod+n' });
    expect(r.bindingsFor('n')).toEqual(['mod+n']);
  });

  it('notifies subscribers and keeps a stable snapshot', () => {
    const r = new CommandRegistry({ mac: true, browserTab: false });
    const fn = vi.fn();
    const off = r.subscribe(fn);
    r.register({ id: 'b', title: 'B', category: 'Z', run: noop });
    r.register({ id: 'a', title: 'A', category: 'Z', run: noop });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(r.list()).toBe(r.list());
    expect(r.list().map((c) => c.id)).toEqual(['a', 'b']);
    off();
    expect(r.defaultBindings('missing')).toEqual([]);
  });
});

describe('fuzzy filter', () => {
  it('scores fuzzy matches and rejects non-matches', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('tt', 'Toggle theme')).not.toBeNull();
    expect(fuzzyScore('xyz', 'Toggle theme')).toBeNull();
    expect(fuzzyScore('theme', 'Toggle theme')! > fuzzyScore('tme', 'Toggle theme')!).toBe(true);
  });

  it('filters and sorts commands', () => {
    const noop = () => undefined;
    const cmds = [
      { id: 'a', title: 'Open settings', category: 'App', run: noop },
      { id: 'b', title: 'Toggle theme', category: 'View', run: noop },
    ];
    expect(filterCommands(cmds, 'theme').map((c) => c.id)).toEqual(['b']);
    expect(filterCommands(cmds, '').map((c) => c.id)).toEqual(['a', 'b']);
  });
});
