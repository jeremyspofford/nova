// Settings → Keyboard (FR-004, docs/14 §3): every command with its binding; search by name or by
// pressing keys; rebind by capturing the next key combination; reset one or all; conflicts shown.
// Remappings are saved to `keyboard.bindings` on the Hub, written with `mod` so they carry across
// operating systems.
import { useMemo, useState, useSyncExternalStore } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import { Button, Dialog, Icon, Kbd, TableScroll, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import type { Command } from '../commands.ts';
import { bindingText, eventToBinding, formatBinding } from '../keys.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { GlobalShortcutsSection } from '../shellbridge/GlobalShortcuts.tsx';
import { ExtensionKeyOffers } from '../extensions/Offers.tsx';

export const KEYBOARD_TEXT = defineMessages('settings.keyboard', {
  saveFailed: 'Could not save the shortcut: {error}',
  clash: '{keys} is also used by {commands}. Change one of them to resolve the conflict.',
  title: 'Keyboard shortcuts',
  browserTab:
    'In a browser tab some shortcuts use Alt, because the browser keeps keys like {first} and {second} for itself. The installed app uses the standard keys.',
  pressToFind: 'Press a shortcut to find it',
  searchByName: 'Search shortcuts by name',
  pressKeys: 'Press keys…',
  searchPlaceholder: 'Search by name',
  stopRecording: 'Stop recording',
  recordKeys: 'Record keys',
  resetAll: 'Reset all',
  conflicts: 'Shortcut conflicts',
  boundTo: '{keys} is bound to {commands}.',
  table: 'Commands and their shortcuts',
  command: 'Command',
  shortcut: 'Shortcut',
  actions: 'Actions',
  category: '{category}:',
  changed: '(changed)',
  notBound: 'Not bound',
  conflict: 'Conflict',
  pressNew: 'Press the new shortcut for {command}, or Escape to cancel',
  capturing: 'Press keys… (Esc cancels)',
  changeFor: 'Change shortcut for {command}',
  change: 'Change',
  removeFor: 'Remove shortcut for {command}',
  remove: 'Remove',
  resetFor: 'Reset shortcut for {command}',
  reset: 'Reset',
  noCommandUses: 'No command uses {keys}.',
  noMatches: 'No matching commands.',
  resetTitle: 'Reset all shortcuts?',
  resetBody: 'Every shortcut returns to its default. Your changes are removed.',
  cancel: 'Cancel',
});
const S = KEYBOARD_TEXT;

export function KeyboardPage() {
  const { registry } = useServices();
  const settings = useSettings();
  const toast = useToast();
  const bindings = settings.get('keyboard.bindings');
  const locked = bindings.locked;
  const mac = registry.platform.mac;
  const commands = useSyncExternalStore(
    (fn) => registry.subscribe(fn),
    () => registry.list(),
  );
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState(false);
  const [keyFilter, setKeyFilter] = useState<string | null>(null);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const conflicts = useMemo(() => {
    void commands; // recompute when commands or bindings change
    return registry.conflicts();
  }, [registry, commands]);
  const conflictIds = new Set(conflicts.flatMap((c) => c.ids));

  const shown = commands.filter((c) => {
    if (keyFilter) return registry.bindingsFor(c.id).includes(keyFilter);
    const q = query.trim().toLowerCase();
    return !q || `${c.category} ${c.title} ${c.id}`.toLowerCase().includes(q);
  });

  const write = (next: Record<string, string>) => {
    settings.set('keyboard.bindings', next).catch((err: unknown) => {
      toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' });
    });
  };

  const assign = (cmd: Command, binding: string) => {
    const clash = registry.conflictsWith(cmd.id, binding);
    write({ ...bindings.value, [cmd.id]: binding });
    if (clash.length)
      toast.show(
        S.clash({
          keys: bindingText(binding, mac),
          commands: fmt.list(clash.map((c) => c.title)),
        }),
        { tone: 'error', duration: 8000 },
      );
  };

  const resetOne = (id: string) => {
    const next = { ...bindings.value };
    delete next[id];
    write(next);
  };

  const nameOf = (id: string) => registry.get(id)?.title ?? id;

  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
      {locked ? <ManagedNote as="p" id="keyboard-lock" setting="keyboard.bindings" /> : null}
      {registry.platform.browserTab ? (
        <p className="muted">
          {S.browserTab({ first: bindingText('mod+n', mac), second: bindingText('mod+1', mac) })}
        </p>
      ) : null}
      <div className="keyboard-search">
        <label htmlFor="kb-search" className="nv-vh">
          {recording ? S.pressToFind : S.searchByName}
        </label>
        <input
          id="kb-search"
          className="nv-input"
          type="search"
          placeholder={recording ? S.pressKeys : S.searchPlaceholder}
          value={recording ? (keyFilter ? bindingText(keyFilter, mac) : '') : query}
          readOnly={recording}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (!recording) return;
            if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) return;
            e.preventDefault();
            e.stopPropagation();
            const combo = eventToBinding(e, mac);
            if (combo) setKeyFilter(combo);
          }}
        />
        <Button
          aria-pressed={recording}
          onClick={() => {
            setRecording(!recording);
            setKeyFilter(null);
            document.getElementById('kb-search')?.focus();
          }}
        >
          {recording ? S.stopRecording : S.recordKeys}
        </Button>
        <Button
          onClick={() => setConfirmReset(true)}
          disabled={locked || Object.keys(bindings.value).length === 0}
        >
          {S.resetAll}
        </Button>
      </div>

      {conflicts.length ? (
        <div className="contrast-warning" role="status" aria-label={S.conflicts}>
          <Icon name="alert" />
          <ul>
            {conflicts.map((c) => (
              <li key={c.binding}>
                {S.boundTo({
                  keys: bindingText(c.binding, mac),
                  commands: fmt.list(c.ids.map(nameOf)),
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <TableScroll label={S.table}>
        <table className="keyboard-table" aria-describedby={locked ? 'keyboard-lock' : undefined}>
          <caption className="nv-vh">{S.table}</caption>
          <thead>
            <tr>
              <th scope="col">{S.command}</th>
              <th scope="col">{S.shortcut}</th>
              <th scope="col">
                <span className="nv-vh">{S.actions}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => {
              const b = registry.bindingsFor(c.id);
              const custom = registry.isCustomized(c.id);
              const isCapturing = capturing === c.id;
              return (
                <tr
                  key={c.id}
                  data-command={c.id}
                  data-conflict={conflictIds.has(c.id) || undefined}
                >
                  <th scope="row">
                    <span className="muted">{S.category({ category: c.category })} </span>
                    {c.title}
                    {custom ? <span className="muted"> {S.changed}</span> : null}
                  </th>
                  <td className="kb-shortcut">
                    {b[0] ? (
                      <Kbd keys={formatBinding(b[0], mac)} />
                    ) : (
                      <span className="muted">{S.notBound}</span>
                    )}
                    {conflictIds.has(c.id) ? (
                      <span className="kb-conflict">
                        <Icon name="alert" /> {S.conflict}
                      </span>
                    ) : null}
                  </td>
                  <td className="kb-actions">
                    <div>
                      {isCapturing ? (
                        <button
                          type="button"
                          className="nv-btn kb-capture"
                          data-variant="primary"
                          autoFocus
                          aria-label={S.pressNew({ command: c.title })}
                          onBlur={() => setCapturing(null)}
                          onKeyDown={(e) => {
                            // Plain Tab leaves capture, so the keyboard is never trapped here.
                            if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                              setCapturing(null);
                              return;
                            }
                            e.preventDefault();
                            e.stopPropagation();
                            if (e.key === 'Escape') {
                              setCapturing(null);
                              return;
                            }
                            const combo = eventToBinding(e, mac);
                            if (!combo) return;
                            setCapturing(null);
                            assign(c, combo);
                          }}
                        >
                          {S.capturing}
                        </button>
                      ) : (
                        <Button
                          variant="ghost"
                          disabled={locked}
                          onClick={() => setCapturing(c.id)}
                          aria-label={S.changeFor({ command: c.title })}
                        >
                          {S.change}
                        </Button>
                      )}
                      {b.length ? (
                        <Button
                          variant="ghost"
                          disabled={locked}
                          onClick={() => write({ ...bindings.value, [c.id]: '' })}
                          aria-label={S.removeFor({ command: c.title })}
                        >
                          {S.remove}
                        </Button>
                      ) : null}
                      {custom ? (
                        <Button
                          variant="ghost"
                          disabled={locked}
                          onClick={() => resetOne(c.id)}
                          aria-label={S.resetFor({ command: c.title })}
                        >
                          {S.reset}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
      {shown.length === 0 ? (
        <p className="muted">
          {keyFilter ? S.noCommandUses({ keys: bindingText(keyFilter, mac) }) : S.noMatches}
        </p>
      ) : null}
      {/* Shortcuts running extensions suggest, bound only when chosen (FR-117, M8). */}
      <ExtensionKeyOffers />
      {/* System-wide shortcuts of the desktop app (FR-008, FR-214, M7). */}
      <GlobalShortcutsSection />

      <Dialog
        open={confirmReset}
        title={S.resetTitle}
        description={S.resetBody}
        onClose={() => setConfirmReset(false)}
        footer={
          <>
            <Button onClick={() => setConfirmReset(false)}>{S.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmReset(false);
                write({});
              }}
            >
              {S.resetAll}
            </Button>
          </>
        }
      />
    </div>
  );
}
