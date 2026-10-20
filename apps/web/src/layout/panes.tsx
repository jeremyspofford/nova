// What each pane kind shows (FR-005): the mode's own view, an editor or preview for a file
// (FR-039), terminals (FR-006), and placeholders for the diff (M5) and browser (M6) panes. A new
// pane starts empty and offers the kinds to choose from.
import type { ReactNode } from 'react';
import { Button, EmptyState, Icon, type IconName } from '@nova/ui';
import { EditorPane } from '../files/EditorPane.tsx';
import { PreviewPane } from '../files/PreviewPane.tsx';
import { baseName } from '../files/types.ts';
import { TerminalPanel } from '../terminal/TerminalPanel.tsx';
import { ADDABLE_KINDS, type AddableKind, type FileRef, type PaneLeaf } from './model.ts';
import type { PaneInfo } from './PaneWorkspace.tsx';
import { LAYOUT_TEXT } from './strings.ts';

export const KIND_ICON: Record<AddableKind, IconName> = {
  editor: 'edit',
  preview: 'eye',
  terminal: 'terminal',
  diff: 'compare',
  browser: 'external',
};

export function paneInfo(pane: PaneLeaf, main: { title: string; icon: IconName }): PaneInfo {
  switch (pane.kind) {
    case 'main':
      return main;
    case 'empty':
      return { title: LAYOUT_TEXT.newPane, icon: 'plus' };
    case 'editor':
    case 'preview':
      return {
        title: pane.file
          ? LAYOUT_TEXT.fileTitle({
              kind: LAYOUT_TEXT.kind[pane.kind],
              file: baseName(pane.file.path),
            })
          : LAYOUT_TEXT.kind[pane.kind],
        icon: KIND_ICON[pane.kind],
      };
    case 'terminal':
    case 'diff':
    case 'browser':
      return { title: LAYOUT_TEXT.kind[pane.kind], icon: KIND_ICON[pane.kind] };
  }
}

export interface PaneContentProps {
  pane: PaneLeaf;
  shown: boolean;
  /** Identifies the pane for terminals, e.g. "chat:p2". */
  viewKey: string;
  main: ReactNode;
  threadId: string | null;
  mac: boolean;
  onChoose: (kind: AddableKind) => void;
  onOpenFile: (file: FileRef, where: 'editor' | 'preview') => void;
}

export function PaneContent({
  pane,
  shown,
  viewKey,
  main,
  threadId,
  mac,
  onChoose,
  onOpenFile,
}: PaneContentProps) {
  switch (pane.kind) {
    case 'main':
      return <>{main}</>;
    case 'empty':
      return <PaneChooser onChoose={onChoose} />;
    case 'editor':
      return (
        <EditorPane
          file={pane.file ?? null}
          mac={mac}
          onPreview={(f) => onOpenFile(f, 'preview')}
        />
      );
    case 'preview':
      return (
        <PreviewPane
          file={pane.file ?? null}
          threadId={threadId}
          onEdit={(f) => onOpenFile(f, 'editor')}
        />
      );
    case 'terminal':
      return (
        <TerminalPanel
          viewKey={`pane:${viewKey}`}
          visible={shown}
          threadId={threadId}
          label={LAYOUT_TEXT.terminalPane}
        />
      );
    case 'diff':
      return (
        <EmptyState
          title={LAYOUT_TEXT.diffLater}
          description={LAYOUT_TEXT.diffLaterDetail}
          icon="compare"
          level={3}
        />
      );
    case 'browser':
      return (
        <EmptyState
          title={LAYOUT_TEXT.browserLater}
          description={LAYOUT_TEXT.browserLaterDetail}
          icon="external"
          level={3}
        />
      );
  }
}

function PaneChooser({ onChoose }: { onChoose: (kind: AddableKind) => void }) {
  return (
    <div className="pane-chooser">
      <p className="pane-chooser-title">{LAYOUT_TEXT.choose}</p>
      <ul className="pane-chooser-list">
        {ADDABLE_KINDS.map((k, i) => (
          <li key={k}>
            <Button onClick={() => onChoose(k)} {...(i === 0 ? { 'data-pane-focus': true } : {})}>
              <Icon name={KIND_ICON[k]} /> {LAYOUT_TEXT.kind[k]}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
