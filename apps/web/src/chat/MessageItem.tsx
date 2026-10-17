// One message in a chat (FR-018, FR-020, FR-023, FR-025, FR-040): its text (Markdown for replies),
// the model that answered, a Steering badge, a version navigator, the sources it cited, and an
// actions toolbar (copy, edit, regenerate, branch, quote, delete). The toolbar is one tab stop
// whose buttons the arrow keys move between; actions that change history wait while a reply runs.
import { useEffect, useId, useRef, useState } from 'react';
import type { CitationView } from '@nova/shared';
import {
  Button,
  Icon,
  IconButton,
  Menu,
  Spinner,
  VisuallyHidden,
  rovingIndex,
  type IconName,
  type MenuItem,
} from '@nova/ui';
import { Highlighted } from './find.tsx';
import { Markdown } from './Markdown.tsx';
import { messageText, type ClientMessage } from './thread-state.ts';

export interface MessageActions {
  onCopy: (text: string) => void;
  onQuote: (text: string) => void;
  /** Saves an edited version; resolves to an error message, or null when it was sent. */
  onEdit?: (text: string) => Promise<string | null>;
  onRegenerate?: (model?: string) => void;
  /** Models offered by "Regenerate with" (enabled entries only). */
  regenerateModels?: { ref: string; label: string }[];
  onBranch?: () => void;
  onDelete?: () => void;
  onSelectVersion?: (messageId: string) => void;
}

export interface MessageItemProps {
  message: ClientMessage;
  streamed: string | undefined;
  reasoning: string | undefined;
  highlighted?: boolean;
  attachmentUrl: (id: string) => string;
  onRetry?: () => void;
  retryDisabled?: boolean;
  /** Display name of the model that answered (assistant messages). */
  modelName?: string | null;
  /** Find-in-chat query whose matches are marked. */
  find?: string;
  /** Null renders the message read-only (inherited, compared or side-chat messages). */
  actions: MessageActions | null;
  /** True while a reply streams: edit, regenerate, delete and version changes wait. */
  busy?: boolean;
  /** Id prefix for the article, so two views of one message do not share ids. */
  idPrefix?: string;
}

const BUSY_HINT = 'Wait for the reply to finish';

export function MessageItem({
  message: m,
  streamed,
  reasoning,
  highlighted,
  attachmentUrl,
  onRetry,
  retryDisabled,
  modelName,
  find = '',
  actions,
  busy = false,
  idPrefix = 'msg-',
}: MessageItemProps) {
  const [editing, setEditing] = useState(false);
  const text = messageText(m, streamed);
  const storedReasoning = m.parts
    .filter((p) => p.type === 'reasoning')
    .map((p) => (p.type === 'reasoning' ? p.text : ''))
    .join('');
  const thinking = reasoning ?? storedReasoning;
  const files = m.parts.filter((p) => p.type === 'file');
  const errors = m.parts.filter((p) => p.type === 'error');
  const who = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Assistant' : m.role;
  const steering = m.provenance === 'steer' || m.expect === 'steer';
  const siblings = m.siblingIds && m.siblingIds.length > 1 ? m.siblingIds : null;
  const settled = !m.id.startsWith('local-') && m.status !== 'streaming';

  return (
    <article
      id={`${idPrefix}${m.id}`}
      className="msg"
      data-role={m.role}
      data-status={m.status}
      data-highlight={highlighted || undefined}
      aria-label={`${who}${m.status === 'incomplete' ? ', stopped' : ''}${steering ? ', steering' : ''}`}
      tabIndex={-1}
    >
      <div className="msg-meta">
        <span className="msg-who">{who}</span>
        {m.role === 'assistant' && modelName ? (
          <span className="msg-model" title="Model that answered">
            {modelName}
          </span>
        ) : null}
        {steering ? (
          <span className="msg-badge" data-kind="steer">
            <Icon name="forward" /> Steering
          </span>
        ) : null}
        {m.status === 'incomplete' ? (
          <span className="msg-badge" data-kind="stopped">
            <Icon name="stop" /> Stopped
          </span>
        ) : null}
        {m.status === 'streaming' ? <Spinner label="Responding" /> : null}
        {siblings ? (
          <Versions
            ids={siblings}
            current={m.id}
            disabled={busy || !actions?.onSelectVersion}
            onSelect={(id) => actions?.onSelectVersion?.(id)}
          />
        ) : null}
      </div>
      {thinking ? (
        <details className="msg-reasoning">
          <summary>Reasoning</summary>
          <p>{thinking}</p>
        </details>
      ) : null}
      {editing && actions?.onEdit ? (
        <EditForm
          initial={text}
          onSave={actions.onEdit}
          onDone={() => setEditing(false)}
          busy={busy}
        />
      ) : text ? (
        m.role === 'assistant' ? (
          <Markdown text={text} find={find} />
        ) : (
          <p className="msg-text">
            <Highlighted text={text} query={find} />
          </p>
        )
      ) : null}
      {files.length ? (
        <ul className="chips" aria-label="Attached files">
          {files.map((f, i) =>
            f.type === 'file' ? (
              <li key={`${f.attachmentId}-${i}`} className="chip">
                <Icon name="file" />
                {f.attachmentId ? (
                  <a href={attachmentUrl(f.attachmentId)} target="_blank" rel="noopener noreferrer">
                    {f.name}
                  </a>
                ) : (
                  <span>{f.name}</span>
                )}
              </li>
            ) : null,
          )}
        </ul>
      ) : null}
      {m.citations?.length ? <Citations items={m.citations} /> : null}
      {errors.map((e, i) =>
        e.type === 'error' ? (
          <div key={i} className="msg-error" role="alert">
            <Icon name="alert" />
            <span>
              {e.message || 'The reply failed.'} <span className="muted">({e.code})</span>
            </span>
            {onRetry ? (
              <Button onClick={onRetry} disabled={retryDisabled}>
                Retry
              </Button>
            ) : null}
          </div>
        ) : null,
      )}
      {m.status === 'error' && errors.length === 0 ? (
        <div className="msg-error" role="alert">
          <Icon name="alert" />
          <span>The reply failed.</span>
          {onRetry ? (
            <Button onClick={onRetry} disabled={retryDisabled}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      {actions && settled && !editing ? (
        <ActionBar
          items={toolbarItems(m.role, text, actions, busy, () => setEditing(true))}
          label={`Actions for ${who === 'You' ? 'your message' : 'this reply'}`}
        />
      ) : null}
    </article>
  );
}

type ToolbarItem =
  | {
      kind: 'button';
      id: string;
      label: string;
      icon: IconName;
      onClick: () => void;
      disabled?: boolean;
    }
  | { kind: 'menu'; id: string; label: string; icon: IconName; items: MenuItem[] };

function toolbarItems(
  role: ClientMessage['role'],
  text: string,
  a: MessageActions,
  busy: boolean,
  startEdit: () => void,
): ToolbarItem[] {
  const items: ToolbarItem[] = [
    { kind: 'button', id: 'copy', label: 'Copy', icon: 'copy', onClick: () => a.onCopy(text) },
  ];
  if (role === 'user' && a.onEdit)
    items.push({
      kind: 'button',
      id: 'edit',
      label: 'Edit',
      icon: 'edit',
      onClick: startEdit,
      disabled: busy,
    });
  if (role === 'assistant' && a.onRegenerate) {
    const regen = a.onRegenerate;
    items.push({
      kind: 'button',
      id: 'regenerate',
      label: 'Regenerate',
      icon: 'refresh',
      onClick: () => regen(),
      disabled: busy,
    });
    if (a.regenerateModels?.length && !busy)
      items.push({
        kind: 'menu',
        id: 'regenerate-with',
        label: 'Regenerate with another model',
        icon: 'more',
        items: a.regenerateModels.map((mo) => ({
          id: mo.ref,
          label: `Regenerate with ${mo.label}`,
          onSelect: () => regen(mo.ref),
        })),
      });
  }
  if (a.onBranch) {
    const branch = a.onBranch;
    items.push({
      kind: 'button',
      id: 'branch',
      label: 'Branch from here',
      icon: 'branch',
      onClick: branch,
    });
  }
  items.push({
    kind: 'button',
    id: 'quote',
    label: 'Quote',
    icon: 'quote',
    onClick: () => a.onQuote(text),
  });
  if (a.onDelete) {
    const del = a.onDelete;
    items.push({
      kind: 'button',
      id: 'delete',
      label: 'Delete',
      icon: 'trash',
      onClick: del,
      disabled: busy,
    });
  }
  return items;
}

function ActionBar({ items, label }: { items: ToolbarItem[]; label: string }) {
  const [active, setActive] = useState(0);
  const bar = useRef<HTMLDivElement>(null);
  const current = Math.min(active, items.length - 1);
  const focusAt = (i: number) => {
    setActive(i);
    bar.current?.querySelectorAll<HTMLElement>('.msg-tool')[i]?.focus();
  };
  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label={label}
      className="msg-actions"
      onKeyDown={(e) => {
        // Keys inside an open menu belong to the menu.
        if (!(e.target instanceof HTMLElement) || !e.target.classList.contains('msg-tool')) return;
        const next = rovingIndex(e.key, current, items.length, 'horizontal');
        if (next === null) return;
        e.preventDefault();
        focusAt(next);
      }}
    >
      {items.map((it, i) =>
        it.kind === 'menu' ? (
          <Menu
            key={it.id}
            label={it.label}
            trigger={<Icon name={it.icon} />}
            items={it.items}
            triggerProps={{
              tabIndex: i === current ? 0 : -1,
              className: 'nv-btn msg-tool',
              onFocus: () => setActive(i),
            }}
          />
        ) : (
          <IconButton
            key={it.id}
            label={it.label}
            icon={<Icon name={it.icon} />}
            variant="ghost"
            className="msg-tool"
            tabIndex={i === current ? 0 : -1}
            aria-disabled={it.disabled || undefined}
            title={it.disabled ? `${it.label}: ${BUSY_HINT}` : it.label}
            onFocus={() => setActive(i)}
            onClick={() => {
              if (!it.disabled) it.onClick();
            }}
          />
        ),
      )}
    </div>
  );
}

function Versions({
  ids,
  current,
  disabled,
  onSelect,
}: {
  ids: string[];
  current: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const i = Math.max(0, ids.indexOf(current));
  const prev = ids[i - 1];
  const next = ids[i + 1];
  return (
    <span className="msg-versions" role="group" aria-label="Versions">
      <IconButton
        label="Previous version"
        icon={<Icon name="back" />}
        variant="ghost"
        disabled={disabled || !prev}
        onClick={() => prev && onSelect(prev)}
      />
      <span aria-hidden="true">
        {i + 1} / {ids.length}
      </span>
      <VisuallyHidden>
        Version {i + 1} of {ids.length}
      </VisuallyHidden>
      <IconButton
        label="Next version"
        icon={<Icon name="forward" />}
        variant="ghost"
        disabled={disabled || !next}
        onClick={() => next && onSelect(next)}
      />
    </span>
  );
}

function EditForm({
  initial,
  onSave,
  onDone,
  busy,
}: {
  initial: string;
  onSave: (text: string) => Promise<string | null>;
  onDone: () => void;
  busy: boolean;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  const save = async () => {
    if (!value.trim() || saving) return;
    setSaving(true);
    setError(null);
    const failure = await onSave(value);
    setSaving(false);
    if (failure) setError(failure);
    else onDone();
  };
  return (
    <form
      className="msg-edit"
      aria-label="Edit message"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onDone();
      }}
    >
      <label htmlFor={id} className="nv-vh">
        Edited message
      </label>
      <textarea
        id={id}
        ref={box}
        className="nv-input msg-edit-input"
        value={value}
        rows={Math.min(10, Math.max(2, value.split('\n').length))}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save();
          }
        }}
      />
      {error ? (
        <p className="composer-error" role="alert">
          <Icon name="alert" /> {error}
        </p>
      ) : null}
      <div className="row">
        <Button type="submit" variant="primary" disabled={saving || busy || !value.trim()}>
          {saving ? <Spinner /> : null}
          Save
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

const SAFE_URL = /^https?:\/\//i;

function Citations({ items }: { items: CitationView[] }) {
  const id = useId();
  const sorted = [...items].sort((a, b) => a.idx - b.idx);
  // A group, not a region: every cited reply has one, and landmarks must stay unique.
  return (
    <div className="msg-sources" role="group" aria-labelledby={id}>
      <span id={id} className="msg-sources-title">
        Sources
      </span>
      <ol>
        {sorted.map((c, i) => {
          const name = c.title?.trim() || c.url || `Source ${i + 1}`;
          return (
            <li key={c.id}>
              {c.url && SAFE_URL.test(c.url) ? (
                <a href={c.url} target="_blank" rel="noopener noreferrer">
                  {name}
                </a>
              ) : (
                <span className="msg-source-name">{name}</span>
              )}
              {c.snippet ? <p className="msg-source-snippet">{c.snippet}</p> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
