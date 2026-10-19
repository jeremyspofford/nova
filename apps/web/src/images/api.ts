// Hub client calls for image generation from the composer (FR-030; docs/08 §1, `image.generate`):
// whether a configured provider can make images (the tool is listed only then), and generating
// one into a chat, where it is saved as an image artifact (the result's `meta.artifact` names it).
// The click is the user's own request, so the call carries `initiator: 'user'` and passes the
// policy gate like a direct call. In the conventions of src/api.ts; `createApi` spreads
// `imagesApi(call)` into the client.
import type { ToolView } from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const V1 = '/api/v1';

/** Sizes the image tool takes (packages/core/src/tools/images.ts). */
export const IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

/**
 * What `image.generate` puts in its result's `meta`: the image artifact it saved, and its prompt,
 * model and size. Over 20,000 characters the Hub sends `{truncated: true}` instead.
 */
export interface GeneratedImageMeta {
  artifact?: { id: string; kind: string; title: string | null; version: number };
  prompt?: string;
  model?: string;
  size?: string;
  revisedPrompt?: string | null;
  truncated?: boolean;
}

/** What a direct tool call answers: its result, or 202 with the approval it waits on. */
export interface GenerateImageResult {
  ok?: boolean;
  text?: string;
  /** The tool's result `meta` (null on failure). */
  meta?: GeneratedImageMeta | null;
  error?: { code: string; message: string };
  /** Set when the call waits for an approval (202). */
  approvalId?: string | null;
  callId?: string;
}

export function imagesApi(call: HubCall) {
  return {
    /** The `image.generate` tool when a provider can make images now, else null. */
    imageGenerationTool: () =>
      call<{ items: ToolView[] }>('GET', `${V1}/tools`).then(
        (r) => r.items.find((t) => t.name === 'image.generate') ?? null,
      ),
    /** Generate one image into the chat (an image artifact with its prompt, model and size). */
    generateImage: (threadId: string, prompt: string, size: ImageSize) =>
      call<GenerateImageResult>('POST', `${V1}/tools/image.generate/invoke`, {
        args: { prompt, size },
        threadId,
        initiator: 'user',
      }),
  };
}

export type ImagesApi = ReturnType<typeof imagesApi>;

/**
 * The image calls of the app's client (`createApi` spreads them), or null for a client without
 * them (a test double or an embedding that leaves them out): the composer then offers nothing.
 */
export function useImagesApi(): ImagesApi | null {
  const api: Partial<ImagesApi> = useServices().api;
  return typeof api.imageGenerationTool === 'function' && typeof api.generateImage === 'function'
    ? (api as ImagesApi)
    : null;
}
