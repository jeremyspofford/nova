// Settings → Keyboard (FR-004, docs/14 §3): every command with its binding; search by name or by
// pressing keys; rebind by capturing the next key combination; reset one or all; conflicts shown.
// Remappings are saved to `keyboard.bindings` on the Hub, written with `mod` so they carry across
// operating systems.
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Button, Dialog, Icon, Kbd, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import type { Command } from '../commands.ts';
import { bindingText, eventToBinding, formatBinding } from '../keys.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { MANAGED } from './common.ts';
import { GlobalShortcutsSection } from '../shellbridge/GlobalShortcuts.tsx';
import { ExtensionKeyOffers } from '../extensions/Offers.tsx';

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
      toast.show(`Could not save the shortcut: ${errorMessage(err)}`, { tone: 'error' });
    });
  };

  const assign = (cmd: Command, binding: string) => {
    const clash = registry.conflictsWith(cmd.id, binding);
    write({ ...bindings.value, [cmd.id]: binding });
    if (clash.length)
      toast.show(
        `${bindingText(binding, mac)} is also used by ${clash.map((c) => c.title).join(', ')}. Change one of them to resolve the conflict.`,
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
      <h2>Keyboard shortcuts</h2>
      {locked ? <p className="nv-field-hint nv-field-lock">{MANAGED}</p> : null}
      {registry.platform.browserTab ? (
        <p className="muted">
          In a browser tab some shortcuts use Alt, because the browser keeps keys like{' '}
          {bindingText('mod+n', mac)} and {bindingText('mod+1', mac)} for itself. The installed app
          uses the standard keys.
        </p>
      ) : null}
      <div className="keyboard-search">
        <label htmlFor="kb-search" className="nv-vh">
          {recording ? 'Press a shortcut to find it' : 'Search shortcuts by name'}
        </label>
        <input
          id="kb-search"
          className="nv-input"
          type="search"
          placeholder={recording ? 'Press keys…' : 'Search by name'}
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
          {recording ? 'Stop recording' : 'Record keys'}
        </Button>
        <Button
          onClick={() => setConfirmReset(true)}
          disabled={locked || Object.keys(bindings.value).length === 0}
        >
          Reset all
        </Button>
      </div>

      {conflicts.length ? (
        <div className="contrast-warning" role="status" aria-label="Shortcut conflicts">
          <Icon name="alert" />
          <ul>
            {conflicts.map((c) => (
              <li key={c.binding}>
                {bindingText(c.binding, mac)} is bound to {c.ids.map(nameOf).join(' and ')}.
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <table className="keyboard-table">
        <caption className="nv-vh">Commands and their shortcuts</caption>
        <thead>
          <tr>
            <th scope="col">Command</th>
            <th scope="col">Shortcut</th>
            <th scope="col">
              <span className="nv-vh">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => {
            const b = registry.bindingsFor(c.id);
            const custom = registry.isCustomized(c.id);
            const isCapturing = capturing === c.id;
            return (
              <tr key={c.id} data-command={c.id} data-conflict={conflictIds.has(c.id) || undefined}>
                <th scope="row">
                  <span className="muted">{c.category}: </span>
                  {c.title}
                  {custom ? <span className="muted"> (changed)</span> : null}
                </th>
                <td className="kb-shortcut">
                  {b[0] ? (
                    <Kbd keys={formatBinding(b[0], mac)} />
                  ) : (
                    <span className="muted">Not bound</span>
                  )}
                  {conflictIds.has(c.id) ? (
                    <span className="kb-conflict">
                      <Icon name="alert" /> Conflict
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
                        aria-label={`Press the new shortcut for ${c.title}, or Escape to cancel`}
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
                        Press keys… (Esc cancels)
                      </button>
                    ) : (
                      <Button
                        variant="ghost"
                        disabled={locked}
                        onClick={() => setCapturing(c.id)}
                        aria-label={`Change shortcut for ${c.title}`}
                      >
                        Change
                      </Button>
                    )}
                    {b.length ? (
                      <Button
                        variant="ghost"
                        disabled={locked}
                        onClick={() => write({ ...bindings.value, [c.id]: '' })}
                        aria-label={`Remove shortcut for ${c.title}`}
                      >
                        Remove
                      </Button>
                    ) : null}
                    {custom ? (
                      <Button
                        variant="ghost"
                        disabled={locked}
                        onClick={() => resetOne(c.id)}
                        aria-label={`Reset shortcut for ${c.title}`}
                      >
                        Reset
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {shown.length === 0 ? (
        <p className="muted">
          {keyFilter ? `No command uses ${bindingText(keyFilter, mac)}.` : 'No matching commands.'}
        </p>
      ) : null}
      {/* Shortcuts running extensions suggest, bound only when chosen (FR-117, M8). */}
      <ExtensionKeyOffers />
      {/* System-wide shortcuts of the desktop app (FR-008, FR-214, M7). */}
      <GlobalShortcutsSection />

      <Dialog
        open={confirmReset}
        title="Reset all shortcuts?"
        description="Every shortcut returns to its default. Your changes are removed."
        onClose={() => setConfirmReset(false)}
        footer={
          <>
            <Button onClick={() => setConfirmReset(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmReset(false);
                write({});
              }}
            >
              Reset all
            </Button>
          </>
        }
      />
    </div>
  );
}
