// Every HTTP adapter kind runs the shared ProviderConformance suite (docs/07 §15).
import {
  AnthropicProvider,
  OpenAICompatibleProvider,
  type OpenAICompatibleKind,
} from '../src/index.ts';
import { runConformance, type ConformanceSpec, type ErrorKind } from './conformance.ts';
import { fixture } from './fake-server.ts';

const OPENAI_ERRORS: Record<ErrorKind, { type: string; code?: string }> = {
  auth: { type: 'invalid_request_error', code: 'invalid_api_key' },
  rate: { type: 'requests', code: 'rate_limit_exceeded' },
  server: { type: 'server_error' },
  bad: { type: 'invalid_request_error' },
  context: { type: 'invalid_request_error', code: 'context_length_exceeded' },
};

function openAISpec(kind: OpenAICompatibleKind, withV1: boolean): ConformanceSpec {
  return {
    name: `OpenAI-compatible (${kind})`,
    make: (origin, o) =>
      new OpenAICompatibleProvider({
        id: kind,
        kind,
        baseUrl: withV1 ? `${origin}/v1` : origin,
        ...(o.apiKey ? { apiKey: o.apiKey } : {}),
        maxRetries: o.maxRetries,
        retryBaseMs: o.retryBaseMs ?? 1,
        random: () => 0,
      }),
    streamPath: '/v1/chat/completions',
    modelsPath: '/v1/models',
    fixtures: {
      text: fixture('openai', 'text'),
      reasoning: fixture('openai', 'reasoning'),
      toolCalls: fixture('openai', 'tool-calls'),
    },
    finalMarker: '"finish_reason":"stop"',
    modelsBody: { object: 'list', data: [{ id: 'b-model' }, { id: 'a-model' }] },
    toolIds: ['call_abc', 'call_def'],
    errorBody: (k, message) => ({ error: { message, ...OPENAI_ERRORS[k] } }),
    authCode: 'auth_expired',
    credential: (s) => s.headers.authorization?.replace(/^Bearer /, ''),
    imageOf: (body) => (body.messages as { content: unknown[] }[])[0]!.content[1],
    expectedImage: { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    toolNames: (body) =>
      (body.tools as { function: { name: string } }[]).map((t) => t.function.name),
  };
}

const ANTHROPIC_ERRORS: Record<ErrorKind, string> = {
  auth: 'authentication_error',
  rate: 'rate_limit_error',
  server: 'api_error',
  bad: 'invalid_request_error',
  context: 'invalid_request_error',
};

const anthropicSpec: ConformanceSpec = {
  name: 'Anthropic',
  // The account's base URL is honoured for streaming and the model list alike; `/v1` is added.
  make: (origin, o) =>
    new AnthropicProvider({
      id: 'anthropic',
      baseUrl: origin,
      ...(o.apiKey ? { apiKey: o.apiKey } : {}),
      maxRetries: o.maxRetries,
      retryBaseMs: o.retryBaseMs ?? 1,
      random: () => 0,
    }),
  streamPath: '/v1/messages',
  modelsPath: '/v1/models',
  fixtures: {
    text: fixture('anthropic', 'text'),
    reasoning: fixture('anthropic', 'reasoning'),
    toolCalls: fixture('anthropic', 'tool-calls'),
  },
  finalMarker: '"type":"message_delta"',
  modelsBody: {
    data: [
      { type: 'model', id: 'b-model', display_name: 'B' },
      { type: 'model', id: 'a-model', display_name: 'A' },
    ],
    has_more: false,
    first_id: 'b-model',
    last_id: 'a-model',
  },
  toolIds: ['toolu_abc', 'toolu_def'],
  errorBody: (k, message) => ({ type: 'error', error: { type: ANTHROPIC_ERRORS[k], message } }),
  authCode: 'auth_missing',
  credential: (s) => s.headers['x-api-key'] as string | undefined,
  imageOf: (body) => (body.messages as { content: unknown[] }[])[0]!.content[1],
  expectedImage: {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
  },
  toolNames: (body) => (body.tools as { name: string }[]).map((t) => t.name),
};

runConformance(openAISpec('openai', true));
runConformance(openAISpec('openrouter', true));
runConformance(openAISpec('openai_compatible', true));
// Local servers are entered as their bare address; the adapter adds /v1.
runConformance(openAISpec('ollama', false));
runConformance(openAISpec('llamacpp', false));
runConformance(anthropicSpec);
