// Composer (docs/04 §3, FR-018, FR-021, FR-023, FR-024): auto-growing input, Enter or Mod+Enter
// sends per `general.enterToSend`, Shift+Enter adds a line, attachments by button, drag-drop and
// paste with inline errors, the model and reasoning pickers, and Send/Stop.
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { REASONING_LEVELS, type ModelView } from '@nova/shared';
import { Button, Icon, IconButton, SelectField, Spinner } from '@nova/ui';
import type { Draft } from '../services.tsx';
import { bindingText } from '../keys.ts';
import { checkFiles, formatBytes, toPending, type Rejection } from './attachments.ts';

/** Reads accepted files into the draft and collects per-file errors. */
export function useAttachmentIntake(draft: Draft, setDraft: (d: Draft) => void) {
  const [errors, setErrors] = useState<Rejection[]>([]);
  const latest = useRef(draft);
  useLayoutEffect(() => {
    latest.current = draft;
  });

  const addFiles = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return;
      const { accepted, rejected } = checkFiles(files, latest.current.attachments.length);
      const read = await Promise.allSettled(accepted.map((a) => toPending(a.file, a.mime)));
      const failed: Rejection[] = [];
      const added = read.flatMap((r, i) => {
        if (r.status === 'fulfilled') return [r.value];
        const name = accepted[i]?.file.name ?? 'A file';
        failed.push({ name, reason: `${name} could not be read.` });
        return [];
      });
      setErrors([...rejected, ...failed]);
      if (added.length) {
        const d = latest.current;
        setDraft({ ...d, attachments: [...d.attachments, ...added] });
      }
    },
    [setDraft],
  );

  return { errors, addFiles, clearErrors: () => setErrors([]) };
}

export interface ComposerProps {
  draft: Draft;
  onDraftChange: (d: Draft) => void;
  onSend: (d: Draft) => void;
  onStop: () => void;
  streaming: boolean;
  stopping: boolean;
  enterToSend: 'enter' | 'mod+enter';
  mac: boolean;
  /** Why the last send failed; the text is back in the box. */
  sendError: string | null;
  attachmentErrors: Rejection[];
  onAddFiles: (files: readonly File[]) => void;
  onDismissAttachmentErrors: () => void;
  models: ModelView[];
  model: string | null;
  onModelChange: (ref: string) => void;
  reasoningLevel: string | null;
  onReasoningChange: (level: (typeof REASONING_LEVELS)[number]) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Shown instead of the input's placeholder while no model is available. */
  noModelHint?: string;
}

export function Composer({
  draft,
  onDraftChange,
  onSend,
  onStop,
  streaming,
  stopping,
  enterToSend,
  mac,
  sendError,
  attachmentErrors,
  onAddFiles,
  onDismissAttachmentErrors,
  models,
  model,
  onModelChange,
  reasoningLevel,
  onReasoningChange,
  inputRef,
  noModelHint,
}: ComposerProps) {
  const own = useRef<HTMLTextAreaElement>(null);
  const textarea = inputRef ?? own;
  const fileInput = useRef<HTMLInputElement>(null);
  const canSend =
    !streaming && (draft.text.trim().length > 0 || draft.attachments.length > 0) && !!model;

  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [draft.text, textarea]);

  const send = () => {
    if (canSend) onSend(draft);
  };

  const sendKey = enterToSend === 'enter' ? 'Enter' : bindingText('mod+enter', mac);
  const selected = models.find((m) => m.ref === model);
  const groups = groupModels(models);

  return (
    <form
      className="composer"
      aria-label="Message composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {sendError ? (
        <p className="composer-error" role="alert">
          <Icon name="alert" /> {sendError}
        </p>
      ) : null}
      {attachmentErrors.length ? (
        <div className="composer-error" role="alert">
          <ul>
            {attachmentErrors.map((r, i) => (
              <li key={`${r.name}-${i}`}>{r.reason}</li>
            ))}
          </ul>
          <Button variant="ghost" onClick={onDismissAttachmentErrors}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {draft.attachments.length ? (
        <ul className="chips" aria-label="Attachments">
          {draft.attachments.map((a) => (
            <li key={a.id} className="chip">
              <Icon name="file" />
              <span className="chip-name">{a.name}</span>
              <span className="muted">{formatBytes(a.size)}</span>
              <IconButton
                label={`Remove ${a.name}`}
                icon={<Icon name="close" />}
                variant="ghost"
                onClick={() =>
                  onDraftChange({
                    ...draft,
                    attachments: draft.attachments.filter((x) => x.id !== a.id),
                  })
                }
              />
            </li>
          ))}
        </ul>
      ) : null}
      <label htmlFor="composer-input" className="nv-vh">
        Message
      </label>
      <textarea
        id="composer-input"
        ref={textarea}
        className="composer-input"
        rows={1}
        value={draft.text}
        placeholder={noModelHint ?? 'Message Nova'}
        aria-describedby="composer-help"
        onChange={(e) => onDraftChange({ ...draft, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
          const mod = mac ? e.metaKey : e.ctrlKey;
          const sends = enterToSend === 'enter' ? !e.shiftKey && !mod : mod;
          if (sends) {
            e.preventDefault();
            send();
          }
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length) {
            e.preventDefault();
            onAddFiles(files);
          }
        }}
      />
      <span id="composer-help" className="nv-vh">
        {enterToSend === 'enter'
          ? 'Enter sends, Shift+Enter adds a line.'
          : `${sendKey} sends, Enter adds a line.`}{' '}
        Escape stops a reply.
      </span>
      <div className="composer-bar">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="file-input"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            onAddFiles(files);
          }}
        />
        <IconButton
          label="Attach files"
          icon={<Icon name="attach" />}
          variant="ghost"
          onClick={() => fileInput.current?.click()}
        />
        <span className="composer-spacer" />
        {models.length ? (
          <SelectField
            className="composer-model"
            label="Model"
            hideLabel
            value={model ?? ''}
            onChange={onModelChange}
            groups={groups}
          />
        ) : null}
        {selected?.reasoning ? (
          <SelectField
            className="composer-reasoning"
            label="Reasoning level"
            hideLabel
            value={reasoningLevel ?? 'medium'}
            onChange={(v) => onReasoningChange(v as (typeof REASONING_LEVELS)[number])}
            options={REASONING_LEVELS.map((l) => ({ value: l, label: `Reasoning: ${l}` }))}
          />
        ) : null}
        {streaming ? (
          <Button
            variant="default"
            onClick={onStop}
            disabled={stopping}
            aria-keyshortcuts="Escape"
            className="composer-stop"
          >
            {stopping ? <Spinner /> : <Icon name="stop" />}
            {stopping ? 'Stopping…' : 'Stop'}
          </Button>
        ) : (
          <Button type="submit" variant="primary" disabled={!canSend} className="composer-send">
            <Icon name="send" />
            Send
          </Button>
        )}
      </div>
    </form>
  );
}

function groupModels(models: ModelView[]) {
  const groups = new Map<string, { label: string; options: { value: string; label: string }[] }>();
  for (const m of models) {
    const key = m.providerAccountId;
    const g = groups.get(key) ?? { label: PROVIDER_NAMES[m.provider] ?? m.provider, options: [] };
    g.options.push({ value: m.ref, label: m.label });
    groups.set(key, g);
  }
  return [...groups.values()];
}

export const PROVIDER_NAMES: Record<string, string> = {
  mock: 'Mock',
  openai_compatible: 'OpenAI-compatible',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
};
