// First-run onboarding's words (FR-014, FR-016). Sentences with an element inside (a key cap, a
// link) are rich messages: the element fills a placeholder, the translation decides where.
import { defineMessages } from '@nova/i18n';

export const ONBOARDING_TEXT = defineMessages('onboarding', {
  steps: {
    provider: 'Connect a model provider',
    model: 'Pick a default model',
    profile: 'Choose your name',
    tool: 'Connect a tool',
    sample: 'Run a first task',
  },
  stepOf: 'Step {n} of {total}',
  stepsLabel: 'Setup steps',
  skipSetup: 'Skip setup',
  back: 'Back',
  skipStep: 'Skip this step',
  continue: 'Continue',
  saveProgressFailed: 'Could not save your progress: {reason}',
  saveFailed: 'Could not save: {reason}',
  provider: {
    intro:
      'Nova sends your messages to the model provider you choose. Pick Mock to try it offline.',
    connected: 'Already connected:',
    addAnother: 'Add another',
    connectAndTest: 'Connect and test',
    restoreHint: 'Have an export of a Nova Hub? Restore it here instead of setting up again.',
    restore: 'Restore from an export file',
  },
  model: {
    none: 'No models are available yet. Go back and connect a provider, or skip for now.',
    legend: 'Default model for new chats',
  },
  profile: {
    displayName: 'Display name',
    hint: 'Shown in Nova on your devices. Add a username and avatar later in Settings, Profile & usage.',
    saveFailed: 'Could not save your name.',
  },
  tool: {
    intro:
      'Tools let Nova work with your files, issue trackers, calendars and other services through MCP servers. Add one now, or skip this step.',
    added:
      '{n, plural, one {Added {names}. It connects in the background.} other {Added {names}. They connect in the background.}}',
    addServer: 'Add an MCP server',
    addAnotherServer: 'Add another server',
    later: 'You can connect tools later in Settings, Tools & MCP.',
    importPrompt: 'Coming from another assistant? {link}.',
    importLink: 'Import its skills, servers, memories and chats',
  },
  sample: {
    threadTitle: 'Sample: summarize a document',
    prompt: 'Summarize this sample document',
    done: 'Setup complete. Your sample task is running.',
    startFailed: 'Could not start the sample task.',
    control: 'You stay in control',
    stopTip:
      'Press {stop} or {key} to stop a reply at any time. What was written so far is kept and marked “Stopped”.',
    stop: 'Stop',
    approvalTip:
      'Before Nova takes a consequential action, it shows an approval card that says what it will do and why. You can allow it once, for the session or always, deny it and let the work continue, deny it and stop, or do the step yourself. Every decision is in the audit log under Settings, Diagnostics.',
    paletteTip: 'Open the command palette with {key} to find any action.',
    tryIt:
      'Try a harmless first task: Nova summarizes a short sample document. This runs on the model you picked.',
    tryItNoModel:
      'Try a harmless first task: Nova summarizes a short sample document. This runs on the model you picked (connect a provider first).',
    message: 'Message',
    run: 'Run this',
    finishWithout: 'Finish without the sample',
  },
});
