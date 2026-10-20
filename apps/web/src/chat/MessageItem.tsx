// One message in a chat (FR-018, FR-020, FR-023, FR-025, FR-040): its text (Markdown for replies),
// the model that answered, a Steering badge, a version navigator, the sources it cited, and an
// actions toolbar (copy, edit, regenerate, branch, quote, delete). The toolbar is one tab stop
// whose buttons the arrow keys move between; actions that change history wait while a reply runs.
// M3: a reply shows its tool calls as cards between the text written before and after them, with
// any approval inside the card (FR-099, FR-100), and its artifacts as cards that open the
// Inspector (FR-038). Web sources show their title and host and open in a new tab (FR-029).
// M4: a tool that declares a UI shows its MCP App under its card (FR-198).
// M8: a reply a spend cap stopped links to that provider's cap (FR-116).
// M8: what running extensions add to a message sits in a menu at the end of its actions (FR-117).
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { defineMessages, messageFor } from '@nova/i18n';
import type { CitationView, ToolCallStatus } from '@nova/shared';
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
import { CapReachedAction } from '../datactl/CapReached.tsx';
import { useMyAccountId } from '../team/role.tsx';
import { useExtensionMenuItems } from '../extensions/shell.tsx';
import { ArtifactCard } from './Artifacts.tsx';
import { Highlighted } from './find.tsx';
import { Markdown } from './Markdown.tsx';
import { isRunCall, RunCard } from './RunCard.tsx';
import { isAskCall, UserAskCard } from './UserAskCard.tsx';
import {
  messageSegments,
  messageText,
  type ClientMessage,
  type DisplayCall,
  type LiveCall,
} from './thread-state.ts';
import { ToolCallApp } from './tool-apps.tsx';
import { ToolCard } from './ToolCard.tsx';

/** What a tool call's card shows about its approval: the card or outcome, and its status. */
export interface CallApproval {
  node: ReactNode;
  /** Shown as the call's status while the approval waits for the user. */
  status?: ToolCallStatus;
}

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
  /** Tool calls of this reply seen on the stream (M3). */
  liveCalls?: LiveCall[];
  /** The approval to show inside a tool call's card, if any. */
  approvalFor?: (call: DisplayCall) => CallApproval | null;
  /** Opens an artifact in the Inspector; without it artifact cards are not interactive. */
  onOpenArtifact?: (artifactId: string) => void;
}

export const MESSAGE_TEXT = defineMessages('chat.message', {
  busyHint: '{action}: Wait for the reply to finish',
  /** The message toolbar's menu of what running extensions add (M8). */
  extensionActions: 'More actions from extensions',
  /** Who wrote a user-role message the user did not type (FR-197). */
  author: {
    hook: 'Hook',
    run: 'Run objective',
    schedule: 'Schedule',
    goal: 'Goal',
    subagent: 'Task',
    system: 'Nova',
  },
  role: '{role, select, user {You} assistant {Assistant} system {System} tool {Tool} summary {Summary} other {Message}}',
  /** In a shared chat (FR-217): a person who wrote a message and has no display name. */
  someone: 'Someone',
  /** The toolbar of another person's message in a shared chat; `name` is who wrote it. */
  actionsForTheirs: 'Actions for the message from {name}',
  label:
    '{who}{stopped, select, yes {, stopped} other {}}{steering, select, yes {, steering} other {}}',
  contextSummary: 'Context summary',
  compacted:
    '{n, plural, one {Earlier messages were summarized to save context (# message, {before} → {after} tokens)} other {Earlier messages were summarized to save context (# messages, {before} → {after} tokens)}}',
  modelThatAnswered: 'Model that answered',
  steering: 'Steering',
  writtenOffline: 'Written offline',
  offlineHint: 'A model on one of your devices answered while the Hub was unreachable',
  answeredOffline: 'Answered offline by a local model',
  stopped: 'Stopped',
  responding: 'Responding',
  reasoning: 'Reasoning',
  attachedFiles: 'Attached files',
  failed: 'The reply failed.',
  retry: 'Retry',
  actionsForYours: 'Actions for your message',
  actionsForReply: 'Actions for this reply',
  copy: 'Copy',
  edit: 'Edit',
  regenerate: 'Regenerate',
  regenerateWithAnother: 'Regenerate with another model',
  regenerateWith: 'Regenerate with {model}',
  branch: 'Branch from here',
  quote: 'Quote',
  delete: 'Delete',
  versions: 'Versions',
  previousVersion: 'Previous version',
  nextVersion: 'Next version',
  versionOf: 'Version {n} of {count}',
  editMessage: 'Edit message',
  editedMessage: 'Edited message',
  save: 'Save',
  cancel: 'Cancel',
  sources: 'Sources',
  source: 'Source {n}',
});

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
  liveCalls,
  approvalFor,
  onOpenArtifact,
}: MessageItemProps) {
  const [editing, setEditing] = useState(false);
  const me = useMyAccountId();
  const text = messageText(m, streamed);
  const segments = m.role === 'assistant' ? messageSegments(m, streamed, liveCalls ?? []) : null;
  const storedReasoning = m.parts
    .filter((p) => p.type === 'reasoning')
    .map((p) => (p.type === 'reasoning' ? p.text : ''))
    .join('');
  const thinking = reasoning ?? storedReasoning;
  const files = m.parts.filter((p) => p.type === 'file');
  const errors = m.parts.filter((p) => p.type === 'error');
  const notices = m.parts.filter((p) => p.type === 'notice');
  // A compaction item (FR-183) stands for earlier messages; it renders as a collapsed summary.
  const compaction = m.parts.find((p) => p.type === 'compaction');
  if (compaction?.type === 'compaction')
    return (
      <article
        id={`${idPrefix}${m.id}`}
        className="msg msg-compaction"
        aria-label={MESSAGE_TEXT.contextSummary}
      >
        <details>
          <summary>
            {MESSAGE_TEXT.compacted({
              n: compaction.covered,
              before: compaction.tokensBefore,
              after: compaction.tokensAfter,
            })}
          </summary>
          <p className="msg-compaction-text" dir="auto">
            {compaction.summary}
          </p>
        </details>
      </article>
    );
  // A user-role message the user did not type in the composer says who wrote it (FR-197, M5).
  const label =
    m.role === 'user' && m.provenance ? messageFor(MESSAGE_TEXT.author, m.provenance) : undefined;
  // In a shared chat (FR-217) another person's message is theirs, by name; yours say You.
  const theirs =
    m.role === 'user' && label === undefined && m.author && m.author.accountId !== me
      ? m.author.displayName?.trim() || MESSAGE_TEXT.someone
      : undefined;
  const who = label ?? theirs ?? MESSAGE_TEXT.role({ role: m.role });
  const yours = m.role === 'user' && label === undefined && theirs === undefined;
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
      aria-label={MESSAGE_TEXT.label({
        who,
        stopped: m.status === 'incomplete' ? 'yes' : 'no',
        steering: steering ? 'yes' : 'no',
      })}
      tabIndex={-1}
    >
      <div className="msg-meta">
        <span className="msg-who" dir={theirs ? 'auto' : undefined}>
          {who}
        </span>
        {m.role === 'assistant' && modelName ? (
          <span className="msg-model" title={MESSAGE_TEXT.modelThatAnswered}>
            {modelName}
          </span>
        ) : null}
        {steering ? (
          <span className="msg-badge" data-kind="steer">
            <Icon name="forward" /> {MESSAGE_TEXT.steering}
          </span>
        ) : null}
        {m.provenance === 'sync' ? (
          <span className="msg-badge" data-kind="sync">
            <Icon name="clock" /> {MESSAGE_TEXT.writtenOffline}
          </span>
        ) : null}
        {m.provenance === 'offline' ? (
          <span className="msg-badge" data-kind="offline" title={MESSAGE_TEXT.offlineHint}>
            <Icon name="server" /> {MESSAGE_TEXT.answeredOffline}
          </span>
        ) : null}
        {m.status === 'incomplete' ? (
          <span className="msg-badge" data-kind="stopped">
            <Icon name="stop" /> {MESSAGE_TEXT.stopped}
          </span>
        ) : null}
        {m.status === 'streaming' ? <Spinner label={MESSAGE_TEXT.responding} /> : null}
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
          <summary>{MESSAGE_TEXT.reasoning}</summary>
          <p dir="auto">{thinking}</p>
        </details>
      ) : null}
      {editing && actions?.onEdit ? (
        <EditForm
          initial={text}
          onSave={actions.onEdit}
          onDone={() => setEditing(false)}
          busy={busy}
        />
      ) : segments ? (
        segments.map((seg, i) => {
          if (seg.kind === 'text')
            return <Markdown key={`text-${i}`} text={seg.text} find={find} />;
          if (seg.kind === 'artifact')
            return (
              <ArtifactCard
                key={`artifact-${seg.part.artifactId}-${i}`}
                part={seg.part}
                onOpen={onOpenArtifact}
              />
            );
          const approval = approvalFor?.(seg.call) ?? null;
          // M5: a chat's inline Work run (FR-186) and a question to the user (FR-188) have their
          // own cards; while the call waits on an approval it keeps the tool card that holds it.
          if (!approval && isRunCall(seg.call))
            return (
              <RunCard key={`call-${seg.call.callId}`} call={seg.call} chatThreadId={m.threadId} />
            );
          if (!approval && isAskCall(seg.call))
            return <UserAskCard key={`call-${seg.call.callId}`} call={seg.call} />;
          return (
            <Fragment key={`call-${seg.call.callId}`}>
              <ToolCard call={seg.call} status={approval?.status} approval={approval?.node} />
              <ToolCallApp call={seg.call} threadId={m.threadId} />
            </Fragment>
          );
        })
      ) : text ? (
        <p className="msg-text" dir="auto">
          <Highlighted text={text} query={find} />
        </p>
      ) : null}
      {files.length ? (
        <ul className="chips" aria-label={MESSAGE_TEXT.attachedFiles}>
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
      {notices.map((n, i) =>
        n.type === 'notice' ? (
          <p key={`n${i}`} className="msg-notice muted" role="note">
            <Icon name="alert" /> <span dir="auto">{n.message}</span>
          </p>
        ) : null,
      )}
      {errors.map((e, i) =>
        e.type === 'error' ? (
          <div key={i} className="msg-error" role="alert">
            <Icon name="alert" />
            <span>
              {e.message || MESSAGE_TEXT.failed}{' '}
              <span className="muted" dir="ltr">
                ({e.code})
              </span>
            </span>
            <CapReachedAction code={e.code} message={e.message} details={e.details} />
            {onRetry ? (
              <Button onClick={onRetry} disabled={retryDisabled}>
                {MESSAGE_TEXT.retry}
              </Button>
            ) : null}
          </div>
        ) : null,
      )}
      {m.status === 'error' && errors.length === 0 ? (
        <div className="msg-error" role="alert">
          <Icon name="alert" />
          <span>{MESSAGE_TEXT.failed}</span>
          {onRetry ? (
            <Button onClick={onRetry} disabled={retryDisabled}>
              {MESSAGE_TEXT.retry}
            </Button>
          ) : null}
        </div>
      ) : null}
      {actions && settled && !editing ? (
        <MessageActionBar
          message={m}
          items={toolbarItems(m.role, text, actions, busy, () => setEditing(true))}
          label={
            theirs
              ? MESSAGE_TEXT.actionsForTheirs({ name: theirs })
              : yours
                ? MESSAGE_TEXT.actionsForYours
                : MESSAGE_TEXT.actionsForReply
          }
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
    {
      kind: 'button',
      id: 'copy',
      label: MESSAGE_TEXT.copy,
      icon: 'copy',
      onClick: () => a.onCopy(text),
    },
  ];
  if (role === 'user' && a.onEdit)
    items.push({
      kind: 'button',
      id: 'edit',
      label: MESSAGE_TEXT.edit,
      icon: 'edit',
      onClick: startEdit,
      disabled: busy,
    });
  if (role === 'assistant' && a.onRegenerate) {
    const regen = a.onRegenerate;
    items.push({
      kind: 'button',
      id: 'regenerate',
      label: MESSAGE_TEXT.regenerate,
      icon: 'refresh',
      onClick: () => regen(),
      disabled: busy,
    });
    if (a.regenerateModels?.length && !busy)
      items.push({
        kind: 'menu',
        id: 'regenerate-with',
        label: MESSAGE_TEXT.regenerateWithAnother,
        icon: 'more',
        items: a.regenerateModels.map((mo) => ({
          id: mo.ref,
          label: MESSAGE_TEXT.regenerateWith({ model: mo.label }),
          onSelect: () => regen(mo.ref),
        })),
      });
  }
  if (a.onBranch) {
    const branch = a.onBranch;
    items.push({
      kind: 'button',
      id: 'branch',
      label: MESSAGE_TEXT.branch,
      icon: 'branch',
      onClick: branch,
    });
  }
  items.push({
    kind: 'button',
    id: 'quote',
    label: MESSAGE_TEXT.quote,
    icon: 'quote',
    onClick: () => a.onQuote(text),
  });
  if (a.onDelete) {
    const del = a.onDelete;
    items.push({
      kind: 'button',
      id: 'delete',
      label: MESSAGE_TEXT.delete,
      icon: 'trash',
      onClick: del,
      disabled: busy,
    });
  }
  return items;
}

/** The action bar plus a menu of what running extensions add to a message (M8, FR-117). */
function MessageActionBar({
  message,
  items,
  label,
}: {
  message: ClientMessage;
  items: ToolbarItem[];
  label: string;
}) {
  const extensionItems = useExtensionMenuItems('message', {
    threadId: message.threadId,
    messageId: message.id,
  });
  return (
    <ActionBar
      items={
        extensionItems.length
          ? [
              ...items,
              {
                kind: 'menu',
                id: 'extensions',
                label: MESSAGE_TEXT.extensionActions,
                icon: 'more',
                items: extensionItems,
              },
            ]
          : items
      }
      label={label}
    />
  );
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
            title={it.disabled ? MESSAGE_TEXT.busyHint({ action: it.label }) : it.label}
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
    <span className="msg-versions" role="group" aria-label={MESSAGE_TEXT.versions}>
      <IconButton
        label={MESSAGE_TEXT.previousVersion}
        icon={<Icon name="back" />}
        variant="ghost"
        disabled={disabled || !prev}
        onClick={() => prev && onSelect(prev)}
      />
      <span aria-hidden="true">
        {i + 1} / {ids.length}
      </span>
      <VisuallyHidden>{MESSAGE_TEXT.versionOf({ n: i + 1, count: ids.length })}</VisuallyHidden>
      <IconButton
        label={MESSAGE_TEXT.nextVersion}
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
      aria-label={MESSAGE_TEXT.editMessage}
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
        {MESSAGE_TEXT.editedMessage}
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
          {MESSAGE_TEXT.save}
        </Button>
        <Button onClick={onDone}>{MESSAGE_TEXT.cancel}</Button>
      </div>
    </form>
  );
}

const SAFE_URL = /^https?:\/\//i;

/** The host of a web source, without `www.` (FR-029). */
export function sourceHost(url: string | null): string | null {
  if (!url || !SAFE_URL.test(url)) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function Citations({ items }: { items: CitationView[] }) {
  const id = useId();
  const sorted = [...items].sort((a, b) => a.idx - b.idx);
  // A group, not a region: every cited reply has one, and landmarks must stay unique.
  return (
    <div className="msg-sources" role="group" aria-labelledby={id}>
      <span id={id} className="msg-sources-title">
        {MESSAGE_TEXT.sources}
      </span>
      <ol>
        {sorted.map((c, i) => {
          const host = sourceHost(c.url);
          const name = c.title?.trim() || host || c.url || MESSAGE_TEXT.source({ n: i + 1 });
          return (
            <li key={c.id}>
              {c.url && host ? (
                <a href={c.url} target="_blank" rel="noopener noreferrer">
                  {name}
                </a>
              ) : (
                <span className="msg-source-name">{name}</span>
              )}
              {host && host !== name ? <span className="msg-source-host">{host}</span> : null}
              {c.snippet ? (
                <p className="msg-source-snippet" dir="auto">
                  {c.snippet}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
