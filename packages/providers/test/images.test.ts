// The images call of the OpenAI-compatible adapter (FR-030) against a local fake server: the
// request it sends (base64 asked for, except from image-only models), what it returns, which
// providers and models declare image generation, and the failures: HTTP errors with the key
// scrubbed, a link instead of data, no image, bad sizes, cancellation and timeouts.
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  OpenAICompatibleProvider,
  compatibleModelCaps,
  openAIModelCaps,
  sniffImage,
  type OpenAICompatibleOptions,
} from '../src/index.ts';
import { useFakeServer } from './fake-server.ts';

const server = useFakeServer();
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const provider = (o: Partial<OpenAICompatibleOptions> = {}) =>
  new OpenAICompatibleProvider({
    id: 'p',
    kind: 'openai',
    baseUrl: `${server.origin}/v1`,
    apiKey: 'sk-test-key-123456',
    ...o,
  });

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (_req: unknown, res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

const req = (
  over: Partial<{ model: string; prompt: string; size: string; signal: AbortSignal }> = {},
) => ({
  model: 'dall-e-3',
  prompt: 'a lighthouse at dusk',
  size: '1024x1024',
  signal: new AbortController().signal,
  ...over,
});

describe('OpenAI-compatible images call', () => {
  it('posts to /images/generations asking for base64 and returns the image', async () => {
    server.handlers.push(
      json(200, { data: [{ b64_json: PNG, revised_prompt: 'a lighthouse, dusk' }] }),
    );
    const r = await provider().generateImage(req(), { requestId: 'r1' });
    expect(r).toEqual({
      model: 'dall-e-3',
      images: [{ data: PNG, mime: 'image/png', revisedPrompt: 'a lighthouse, dusk' }],
    });
    const sent = server.seen[0]!;
    expect(sent).toMatchObject({ method: 'POST', url: '/v1/images/generations' });
    expect(sent.headers.authorization).toBe('Bearer sk-test-key-123456');
    expect(JSON.parse(sent.body)).toEqual({
      model: 'dall-e-3',
      prompt: 'a lighthouse at dusk',
      size: '1024x1024',
      n: 1,
      response_format: 'b64_json',
    });
  });

  it('does not send response_format to image-only models', async () => {
    server.handlers.push(json(200, { data: [{ b64_json: '/9j/4AAQ' }] }));
    const r = await provider().generateImage(req({ model: 'gpt-image-1' }), { requestId: 'r' });
    expect(r.images[0]).toEqual({ data: '/9j/4AAQ', mime: 'image/jpeg' });
    expect(JSON.parse(server.seen[0]!.body)).not.toHaveProperty('response_format');
  });

  it('maps HTTP errors and never repeats the key', async () => {
    server.handlers.push(
      json(401, {
        error: { message: 'bad key sk-test-key-123456', type: 'invalid_request_error' },
      }),
    );
    const e = (await provider()
      .generateImage(req(), { requestId: 'r' })
      .then(
        () => null,
        (x: unknown) => x,
      )) as { code: string; message: string } | null;
    expect(e).toMatchObject({ code: 'auth_expired' });
    expect(e?.message).not.toContain('sk-test-key-123456');
    server.handlers.push(
      json(400, { error: { message: 'Your request was rejected by the safety system.' } }),
    );
    await expect(provider().generateImage(req(), { requestId: 'r' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    server.handlers.push(json(503, 'down'));
    await expect(provider().generateImage(req(), { requestId: 'r' })).rejects.toMatchObject({
      code: 'provider_error',
      retryable: true,
    });
  });

  it('refuses a link instead of data, an empty answer and a body that is not JSON', async () => {
    server.handlers.push(json(200, { data: [{ url: 'https://cdn.example/img.png' }] }));
    await expect(provider().generateImage(req(), { requestId: 'r' })).rejects.toThrow(
      /link instead of the image/,
    );
    server.handlers.push(json(200, { data: [] }));
    await expect(provider().generateImage(req(), { requestId: 'r' })).rejects.toThrow(/no image/);
    server.handlers.push(json(200, 'not json'));
    await expect(provider().generateImage(req(), { requestId: 'r' })).rejects.toThrow(
      /not an image/,
    );
  });

  it('checks the size and prompt before sending anything', async () => {
    for (const size of ['big', '10x10', '9000x9000', '1024'])
      await expect(
        provider().generateImage(req({ size }), { requestId: 'r' }),
      ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      provider().generateImage(req({ prompt: '  ' }), { requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(server.seen).toHaveLength(0);
  });

  it('can be cancelled, and reports an unreachable server', async () => {
    const ac = new AbortController();
    server.handlers.push(() => setTimeout(() => ac.abort(), 5));
    await expect(
      provider().generateImage(req({ signal: ac.signal }), { requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    await expect(
      provider({ baseUrl: 'http://127.0.0.1:9/v1' }).generateImage(req(), { requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('is offered by OpenAI and generic servers only, and refused where it is not', async () => {
    expect(provider().capabilities.imageGeneration).toBe(true);
    expect(provider({ kind: 'openai_compatible' }).capabilities.imageGeneration).toBe(true);
    for (const kind of ['ollama', 'llamacpp', 'openrouter'] as const) {
      const p = provider({ kind });
      expect(p.capabilities.imageGeneration, kind).toBe(false);
      await expect(p.generateImage(req(), { requestId: 'r' })).rejects.toMatchObject({
        code: 'capability_missing',
      });
    }
  });

  it('marks image models in the model list', async () => {
    expect(openAIModelCaps('gpt-image-1').imageGeneration).toBe(true);
    expect(openAIModelCaps('dall-e-3').imageGeneration).toBe(true);
    expect(openAIModelCaps('gpt-4o').imageGeneration).toBeUndefined();
    expect(compatibleModelCaps('stabilityai/stable-diffusion-xl')).toEqual({
      imageGeneration: true,
    });
    expect(compatibleModelCaps('flux-schnell')).toEqual({ imageGeneration: true });
    expect(compatibleModelCaps('llama3')).toEqual({});
    server.handlers.push(json(200, { data: [{ id: 'gpt-4o' }, { id: 'gpt-image-1' }] }));
    const models = await provider().listModels();
    expect(models.find((m) => m.id === 'gpt-image-1')?.capabilities.imageGeneration).toBe(true);
    server.handlers.push(json(200, { data: [{ id: 'sdxl-turbo' }] }));
    const local = await provider({ kind: 'openai_compatible' }).listModels();
    expect(local[0]?.capabilities).toEqual({ imageGeneration: true });
    expect(sniffImage('AAAA')).toBeNull();
    expect(sniffImage('UklGRxxx')).toBe('image/webp');
    expect(sniffImage('R0lGODlh')).toBe('image/gif');
  });
});
