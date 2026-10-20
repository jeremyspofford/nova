// Words of the app's shared stores and helpers (FR-016): load errors, the settings store's lock
// error, model fallbacks and the contrast checks' color pairs.
import { defineMessages } from '@nova/i18n';

export const STORE_TEXT = defineMessages('app.stores', {
  loadChats: 'Could not load chats.',
  loadMoreChats: 'Could not load more chats.',
  loadArchived: 'Could not load archived chats.',
  loadModels: 'Could not load models.',
  noModel: 'No model',
  locked: '{key} is managed by your organization',
});

/** The color pairs the contrast check names (Settings → Appearance). */
export const CONTRAST_TEXT = defineMessages('app.contrast', {
  body: 'Text on background',
  muted: 'Secondary text on background',
  accent: 'Accent on background',
});
