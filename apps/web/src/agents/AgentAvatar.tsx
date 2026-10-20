// An agent's avatar (FR-079): the image the Hub serves for it, or its initial. A new image is
// picked here (PNG, JPEG or WebP up to 2 MB, as the account's) and previewed from the file the
// user chose before it is sent. The image only ever comes from the Hub's own route or that file.
import { useRef, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { AgentView } from '@nova/shared';
import { Button, useToast } from '@nova/ui';
import { readAsBase64 } from '../chat/attachments.ts';
import { useAgentsApi } from './api.ts';
import { initial } from './format.ts';

export const AVATAR_TEXT = defineMessages('agents.avatar', {
  wrongType: 'Choose a PNG, JPEG or WebP image.',
  tooBig: 'That image is {size}; the limit is {limit}.',
  unreadable: 'Could not read that image.',
  preview: 'New avatar preview',
  change: 'Change avatar',
  upload: 'Upload avatar',
  remove: 'Remove avatar',
  keep: 'Keep the current avatar',
  input: 'Avatar image',
  hint: 'PNG, JPEG or WebP, up to {limit}.',
});

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AvatarMime = (typeof AVATAR_TYPES)[number];
export interface AvatarUpload {
  mime: AvatarMime;
  data: string;
}

export function AgentAvatar({
  agent,
  size = 'md',
}: {
  agent: Pick<AgentView, 'id' | 'name' | 'hasAvatar' | 'updatedAt'>;
  size?: 'sm' | 'md' | 'lg';
}) {
  const api = useAgentsApi();
  // Decorative: the agent's name is always shown beside it.
  if (agent.hasAvatar)
    return (
      <img
        className="agent-avatar"
        data-size={size}
        src={`${api.agentAvatarUrl(agent.id)}?v=${encodeURIComponent(agent.updatedAt)}`}
        alt=""
      />
    );
  return (
    <span className="agent-avatar agent-avatar-empty" data-size={size} aria-hidden="true">
      {initial(agent.name)}
    </span>
  );
}

/**
 * Choose, replace or remove an avatar. `value` is the image waiting to be sent: undefined keeps
 * the current one, null removes it.
 */
export function AvatarPicker({
  name,
  current,
  value,
  onChange,
  disabled,
}: {
  name: string;
  /** The agent's saved avatar, when there is one. */
  current: Pick<AgentView, 'id' | 'name' | 'hasAvatar' | 'updatedAt'> | null;
  value: AvatarUpload | null | undefined;
  onChange: (next: AvatarUpload | null | undefined) => void;
  disabled?: boolean;
}) {
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);

  const pick = async (f: File) => {
    if (!(AVATAR_TYPES as readonly string[]).includes(f.type)) {
      toast.show(AVATAR_TEXT.wrongType, { tone: 'error' });
      return;
    }
    if (f.size > AVATAR_MAX_BYTES) {
      toast.show(
        AVATAR_TEXT.tooBig({ size: fmt.bytes(f.size), limit: fmt.bytes(AVATAR_MAX_BYTES) }),
        { tone: 'error' },
      );
      return;
    }
    setReading(true);
    try {
      onChange({ mime: f.type as AvatarMime, data: await readAsBase64(f) });
    } catch {
      toast.show(AVATAR_TEXT.unreadable, { tone: 'error' });
    } finally {
      setReading(false);
    }
  };

  const showsSaved = value === undefined && current?.hasAvatar === true;
  const has = value ? true : showsSaved;
  return (
    <div className="ws-avatar-row agent-avatar-picker">
      {value ? (
        <img
          className="agent-avatar"
          data-size="lg"
          src={`data:${value.mime};base64,${value.data}`}
          alt={AVATAR_TEXT.preview}
        />
      ) : showsSaved && current ? (
        <AgentAvatar agent={current} size="lg" />
      ) : (
        <span className="agent-avatar agent-avatar-empty" data-size="lg" aria-hidden="true">
          {initial(name)}
        </span>
      )}
      <div className="ws-toolbar">
        <Button onClick={() => file.current?.click()} disabled={disabled || reading}>
          {has ? AVATAR_TEXT.change : AVATAR_TEXT.upload}
        </Button>
        {has ? (
          <Button
            variant="ghost"
            disabled={disabled || reading}
            onClick={() => onChange(current?.hasAvatar ? null : undefined)}
          >
            {AVATAR_TEXT.remove}
          </Button>
        ) : null}
        {value !== undefined && current?.hasAvatar ? (
          <Button variant="ghost" disabled={disabled} onClick={() => onChange(undefined)}>
            {AVATAR_TEXT.keep}
          </Button>
        ) : null}
      </div>
      <input
        ref={file}
        type="file"
        accept={AVATAR_TYPES.join(',')}
        hidden
        aria-label={AVATAR_TEXT.input}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void pick(f);
        }}
      />
      <span className="nv-field-hint">
        {AVATAR_TEXT.hint({ limit: fmt.bytes(AVATAR_MAX_BYTES) })}
      </span>
    </div>
  );
}
