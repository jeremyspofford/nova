// Image generation (FR-030): `image.generate` makes an image from a prompt through a provider
// that can, and saves it as an image artifact with its prompt, model and size. The tool is only
// offered when a configured provider declares `imageGeneration` and has an images call; with
// none (the Mock provider, every adapter today) it is simply not listed.
//
// The provider call is the optional `generateImage` method this module expects adapters to add
// (see `ImageCapableProvider`); until one does, the tool stays hidden.
import { NovaError, uuidv7, type ToolDescriptor } from '@nova/shared';
import type { CallContext, Provider } from '@nova/providers';
import type { AccountModel, ProviderAccountRow } from '../registry.ts';
import type { ArtifactService, CreateArtifactInput } from './artifacts.ts';
import { argsOf, builtinDescriptor, extrasOf, fail, ok, str, type BuiltinTool } from './builtin.ts';
import { clip } from './text.ts';
import type { ToolSourceProvider } from './types.ts';

export const IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024', '512x512', '256x256'] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

/** The request an adapter's `generateImage` receives. */
export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  size: ImageSize;
  signal: AbortSignal;
}

/** One generated image, base64 encoded. */
export interface GeneratedImage {
  data: string;
  mime?: string;
  /** The prompt as the provider rewrote it, when it did. */
  revisedPrompt?: string;
}

export interface ImageGenerationResult {
  model: string;
  images: GeneratedImage[];
}

/**
 * A provider with an images call: the addition FR-030 needs in packages/providers
 * (`Provider.generateImage?`), with `capabilities.imageGeneration: true` and the image models
 * marked `imageGeneration` in their ModelInfo capabilities.
 */
export interface ImageCapableProvider extends Provider {
  generateImage(req: ImageGenerationRequest, ctx: CallContext): Promise<ImageGenerationResult>;
}

export function canGenerateImages(p: Provider): p is ImageCapableProvider {
  return (
    p.capabilities.imageGeneration &&
    typeof (p as Partial<ImageCapableProvider>).generateImage === 'function'
  );
}

/** Where images come from for an account. */
export interface ImageGenerator {
  /** The model that serves this account's images, or null when none can. Never throws. */
  model(accountId: string): Promise<{ ref: string; label: string } | null>;
  generate(
    accountId: string,
    req: { prompt: string; size: ImageSize; signal: AbortSignal },
  ): Promise<{ model: string; image: GeneratedImage }>;
}

export interface ProviderImageGeneratorOptions {
  registry: {
    accountModels(accountId: string): Promise<AccountModel[]>;
    provider(row: ProviderAccountRow): Provider;
  };
  /** routing.allowCloud: when false only local image models are used (privacy first). */
  allowCloud?: () => Promise<boolean>;
}

/** Image generation through the first configured model that declares it. */
export function providerImageGenerator(opts: ProviderImageGeneratorOptions): ImageGenerator {
  const pick = async (accountId: string) => {
    const cloud = (await opts.allowCloud?.()) ?? true;
    for (const m of await opts.registry.accountModels(accountId)) {
      if (m.info.capabilities.imageGeneration !== true) continue;
      if (!cloud && !m.local) continue;
      const provider = opts.registry.provider(m.account);
      if (canGenerateImages(provider)) return { m, provider };
    }
    return null;
  };
  return {
    model: async (accountId) => {
      try {
        const hit = await pick(accountId);
        return hit ? { ref: hit.m.view.ref, label: hit.m.view.label } : null;
      } catch {
        return null;
      }
    },
    generate: async (accountId, req) => {
      const hit = await pick(accountId);
      if (!hit) throw new NovaError('validation', 'no configured provider can generate images');
      const r = await hit.provider.generateImage(
        { model: hit.m.info.id, prompt: req.prompt, size: req.size, signal: req.signal },
        { requestId: `image:${uuidv7()}` },
      );
      const image = r.images[0];
      if (!image) throw new NovaError('provider_error', 'the provider returned no image');
      return { model: hit.m.view.ref, image };
    },
  };
}

export interface ImageToolOptions {
  artifacts: ArtifactService;
  generator: ImageGenerator;
}

const DESCRIPTOR: ToolDescriptor = builtinDescriptor({
  name: 'image.generate',
  title: 'Generate an image',
  description:
    'Generate an image from a text prompt and show it in the artifacts pane. Describe the subject, style and composition in the prompt.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 4000 },
      size: { enum: [...IMAGE_SIZES] },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  annotations: { action: 'write', costClass: 'metered' },
  timeoutMs: 180_000,
});

/** The `image.generate` tool. */
export function imageTool(opts: ImageToolOptions): BuiltinTool {
  return {
    descriptor: DESCRIPTOR,
    origin: null,
    handler: async (args, ctx) => {
      const a = argsOf(args);
      const prompt = (str(a.prompt) ?? '').trim();
      if (!prompt) return fail('validation', 'the prompt is empty');
      const size = IMAGE_SIZES.includes(a.size as ImageSize) ? (a.size as ImageSize) : '1024x1024';
      try {
        const { model, image } = await opts.generator.generate(ctx.accountId, {
          prompt,
          size,
          signal: ctx.signal,
        });
        // `meta` is kept with the artifact once ArtifactService stores extra metadata (FR-030);
        // the tool result carries the same fields either way.
        const meta = { prompt, model, size, revisedPrompt: image.revisedPrompt ?? null };
        const input: CreateArtifactInput & { meta: Record<string, unknown> } = {
          accountId: ctx.accountId,
          threadId: ctx.threadId || null,
          messageId: extrasOf(ctx)?.messageId ?? null,
          turnId: ctx.turnId || null,
          kind: 'image',
          title: clip(prompt.replace(/\s+/g, ' '), 80),
          content: image.data,
          encoding: 'base64',
          meta,
        };
        const view = await opts.artifacts.save(input);
        return ok(`Generated a ${size} image with ${model} (artifact id ${view.id}).`, {
          artifact: { id: view.id, kind: view.kind, title: view.title, version: view.version },
          ...meta,
        });
      } catch (err) {
        if (err instanceof NovaError) return fail(err.code, err.message);
        throw err;
      }
    },
  };
}

/** `image.generate` as a tool source: listed only while a provider can generate images. */
export function imageToolSource(opts: ImageToolOptions): ToolSourceProvider {
  const tool = imageTool(opts);
  return {
    source: 'builtin',
    list: async (accountId) => {
      try {
        return (await opts.generator.model(accountId)) ? [tool] : [];
      } catch {
        return [];
      }
    },
  };
}
