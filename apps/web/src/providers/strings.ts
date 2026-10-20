// The provider setup's words (FR-014, FR-016): one blurb and one help text per provider kind, the
// form's labels and its messages. Read at render time, so they follow the active locale.
import { defineMessages } from '@nova/i18n';

export const PROVIDER_TEXT = defineMessages('providers', {
  /** A provider that runs on this computer or the network, after its name. */
  local: '{name} (local)',
  /** Two model groups of one provider kind are told apart by a number. */
  numbered: '{label} ({n})',
  kinds: {
    mock: {
      blurb: 'Works offline. Gives canned replies, so you can try Nova without an account.',
      help: 'No key needed. Switch to a real provider any time in Settings → Accounts.',
    },
    ollama: {
      blurb: 'Models running on this computer or your network. Nothing leaves your machines.',
      help:
        'Install Ollama and pull a model. Nova connects to the address below; change it if ' +
        'Ollama runs elsewhere.',
    },
    llamacpp: {
      blurb: 'A llama.cpp server on this computer or your network. Nothing leaves your machines.',
      help:
        'Start llama-server with a model. Nova connects to the address below; change it if the ' +
        'server runs elsewhere. Add a key only if you started the server with one.',
    },
    openai_compatible: {
      blurb: 'Any server that speaks the OpenAI chat API, local or hosted.',
      help:
        'Use the base URL your server documents, usually ending in /v1. Add a key only if the ' +
        'server asks for one.',
    },
    anthropic: {
      blurb: 'Hosted models with your Anthropic API key.',
      help: 'Create a key in the API keys section of your Anthropic account, then paste it here.',
    },
    openai: {
      blurb: 'Hosted models with your OpenAI API key.',
      help: 'Create a key on the API keys page of your OpenAI account, then paste it here.',
    },
    openrouter: {
      blurb: 'Many hosted models through one OpenRouter API key.',
      help: 'Create a key on the Keys page of your OpenRouter account, then paste it here.',
    },
  },
  saveAndTest: 'Save and test',
  urlInvalid: 'Enter a full URL, like http://host:port/v1',
  rejected: 'The provider did not accept the connection.',
  testFailed: 'The connection test failed.',
  saveFailed: 'Could not save the provider.',
  removeFailed: 'Could not remove the provider.',
  couldNotConnect: '{name} could not connect: {detail}',
  testAgain: 'Test again',
  removeAndEdit: 'Remove and edit',
  baseUrl: 'Base URL',
  baseUrlAdvancedHint:
    'Optional. Only for a proxy or a self-hosted gateway; leave empty to use the provider directly.',
  baseUrlDefaultHint: 'Optional. Defaults to {url}.',
  baseUrlProviderHint: 'Optional. Defaults to the provider address.',
  provider: 'Provider',
  name: 'Name',
  nameHint: 'Shown in model pickers. Defaults to “{name}”.',
  apiKey: 'API key',
  apiKeyOptionalHint:
    "Optional. Stored in the Hub's secret vault; it is never shown again or kept in this browser.",
  apiKeyHint: "Stored in the Hub's secret vault. It is never shown again or kept in this browser.",
  advanced: 'Advanced',
  testing: 'Testing connection…',
  saving: 'Saving…',
});
