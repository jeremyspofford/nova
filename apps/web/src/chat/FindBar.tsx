// Find bar over a chat (FR-025): type to mark matches, "3 of 12", Enter and Shift+Enter (or the
// buttons) step through them, Escape closes and hands focus back.
import type { RefObject } from 'react';
import { defineMessages } from '@nova/i18n';
import { Icon, IconButton } from '@nova/ui';

export const FIND_TEXT = defineMessages('chat.find', {
  find: 'Find in chat',
  position: '{current} of {count}',
  none: 'No matches',
  previous: 'Previous match',
  next: 'Next match',
  close: 'Close find',
});

export interface FindBarProps {
  query: string;
  onQuery: (q: string) => void;
  /** Matches found, and the 0-based current one. */
  count: number;
  index: number;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

export function FindBar({
  query,
  onQuery,
  count,
  index,
  onNext,
  onPrevious,
  onClose,
  inputRef,
}: FindBarProps) {
  const status = !query.trim()
    ? ''
    : count
      ? FIND_TEXT.position({ current: index + 1, count })
      : FIND_TEXT.none;
  return (
    <div
      className="find-bar"
      role="search"
      aria-label={FIND_TEXT.find}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <label htmlFor="find-in-chat" className="nv-vh">
        {FIND_TEXT.find}
      </label>
      <input
        id="find-in-chat"
        ref={inputRef}
        type="search"
        className="nv-input find-input"
        placeholder={FIND_TEXT.find}
        autoComplete="off"
        value={query}
        aria-describedby="find-status"
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (e.shiftKey) onPrevious();
          else onNext();
        }}
      />
      <span id="find-status" className="find-status muted" aria-live="polite">
        {status}
      </span>
      <IconButton
        label={FIND_TEXT.previous}
        icon={<Icon name="back" />}
        variant="ghost"
        disabled={count === 0}
        onClick={onPrevious}
      />
      <IconButton
        label={FIND_TEXT.next}
        icon={<Icon name="forward" />}
        variant="ghost"
        disabled={count === 0}
        onClick={onNext}
      />
      <IconButton
        label={FIND_TEXT.close}
        icon={<Icon name="close" />}
        variant="ghost"
        onClick={onClose}
      />
    </div>
  );
}
