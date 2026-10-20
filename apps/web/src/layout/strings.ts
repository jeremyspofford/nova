// Words of the pane workspace (FR-005, FR-016).
import { defineMessages } from '@nova/i18n';

export const LAYOUT_TEXT = defineMessages('layout', {
  newPane: 'New pane',
  fileTitle: '{kind}: {file}',
  kind: {
    editor: 'Editor',
    preview: 'Preview',
    terminal: 'Terminal',
    diff: 'Diff',
    browser: 'Browser',
  },
  terminalPane: 'Terminal pane',
  diffLater: 'Diffs arrive with Code sessions',
  diffLaterDetail: 'This pane will show the changes a coding session makes, file by file.',
  browserLater: 'The browser pane arrives in a later milestone',
  browserLaterDetail: 'This pane will show the pages an agent opens while it works.',
  choose: 'Choose what this pane shows',
  panesCount: '{n, plural, one {# pane} other {# panes}}',
  resizeBetween: 'Resize {first} and {second}',
  aPane: 'pane',
  resizeBottom: 'Resize the bottom panel',
  bottomPanel: 'Bottom panel',
  terminal: 'Terminal',
  closeBottom: 'Close the bottom panel',
  moveUp: 'Move up',
  moveDown: 'Move down',
  moveLeft: 'Move left',
  moveRight: 'Move right',
  resetLayout: 'Reset layout',
  splitRight: 'Split {pane} right',
  splitDown: 'Split {pane} down',
  restore: 'Restore {pane}',
  maximize: 'Maximize {pane}',
  moreActions: 'More actions for {pane}',
  close: 'Close {pane}',
  panes: 'Panes',
});

/** Resizing without dragging (WCAG 2.5.7): a pane's menu and the bottom panel's. */
export const PANE_SIZE_TEXT = defineMessages('layout.size', {
  larger: 'Make larger',
  smaller: 'Make smaller',
  bottomMenu: 'More actions for the bottom panel',
  taller: 'Make taller',
  shorter: 'Make shorter',
});
