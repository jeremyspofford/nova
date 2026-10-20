// Generate image in the composer (FR-030; docs/04 §3, docs/08 §1): offered only while a configured
// provider can make images (the Hub lists `image.generate` only then, and only local models while
// cloud routing is off). Describe the image and pick a shape; the result is saved in the chat as an
// image artifact with its prompt, model and size, and shows here and in the chat's artifacts. The
// request passes the policy gate like any tool call; when it asks first, the approval is in the
// chat. Images are loaded only from the Hub's own artifact route.
import { useEffect, useId, useRef, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import { Button, Dialog, Icon, IconButton, RadioGroup, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { useImagesApi, type ImageSize, type ImagesApi } from './api.ts';
import './images.css';

export const IMAGE_TEXT = defineMessages('images', {
  shape: { square: 'Square', landscape: 'Landscape', portrait: 'Portrait' },
  /** An image size in pixels: "1024 × 1536". */
  size: '{width} × {height}',
  generate: 'Generate an image',
  describe: 'Describe the image: its subject, style and composition.',
  tooLong: 'Keep the description under {max} characters.',
  generating: 'Generating the image.',
  waitsApproval: 'The image waits for your approval in the chat.',
  generated: 'Image generated and saved in this chat.',
  notGenerated: 'The image was not generated.',
  failed: 'Could not generate the image.',
  dialogBody: 'It is saved in this chat as an image, with your description.',
  description: 'Description',
  shapeLabel: 'Shape',
  generatingShort: 'Generating',
  generatingLong: 'Generating… This can take a minute.',
  saved: 'Saved in this chat’s artifacts.',
  approvalNote:
    'Your rules ask before generating images. Approve it in the chat; the image then appears in its artifacts.',
  done: 'Done',
  cancel: 'Cancel',
  another: 'Generate another',
  go: 'Generate',
});

const SHAPES: {
  value: ImageSize;
  shape: 'square' | 'landscape' | 'portrait';
  w: number;
  h: number;
}[] = [
  { value: '1024x1024', shape: 'square', w: 1024, h: 1024 },
  { value: '1536x1024', shape: 'landscape', w: 1536, h: 1024 },
  { value: '1024x1536', shape: 'portrait', w: 1024, h: 1536 },
];

const PROMPT_MAX = 4000;
/** How long a "can make images" answer is reused across chats. */
export const AVAILABILITY_TTL_MS = 60_000;

const cache = new WeakMap<ImagesApi, { at: number; value: boolean }>();

/** Whether a provider can make images now (asked once a minute at most). */
export function useImageGeneration(api: ImagesApi | null): boolean {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!api) return;
    const hit = cache.get(api);
    if (hit && Date.now() - hit.at < AVAILABILITY_TTL_MS) return;
    let alive = true;
    const settle = (value: boolean) => {
      cache.set(api, { at: Date.now(), value });
      if (alive) setTick((n) => n + 1);
    };
    api.imageGenerationTool().then(
      (tool) => settle(tool !== null),
      () => settle(false),
    );
    return () => {
      alive = false;
    };
  }, [api]);
  return api ? (cache.get(api)?.value ?? false) : false;
}

/** Forget the cached answer (tests, or after providers change). */
export function resetImageAvailability(api: ImagesApi): void {
  cache.delete(api);
}

/** The composer's Generate image button; nothing while no provider can make images. */
export function GenerateImageButton({ threadId }: { threadId: string | null }) {
  const api = useImagesApi();
  const available = useImageGeneration(api);
  const [open, setOpen] = useState(false);
  if (!api || !available || !threadId) return null;
  return (
    <>
      <IconButton
        label={IMAGE_TEXT.generate}
        icon={<Icon name="image" />}
        variant="ghost"
        onClick={() => setOpen(true)}
      />
      {open ? (
        <GenerateImageDialog api={api} threadId={threadId} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

type Outcome =
  | { kind: 'done'; artifactId: string | null; text: string }
  | { kind: 'waiting' }
  | { kind: 'failed'; text: string };

function GenerateImageDialog({
  api,
  threadId,
  onClose,
}: {
  api: ImagesApi;
  threadId: string;
  onClose: () => void;
}) {
  const { api: hub } = useServices();
  const announce = useAnnounce();
  const id = `gi${useId()}`;
  const first = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState<ImageSize>('1024x1024');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [shown, setShown] = useState('');
  const problem = !prompt.trim()
    ? IMAGE_TEXT.describe
    : prompt.length > PROMPT_MAX
      ? IMAGE_TEXT.tooLong({ max: fmt.number(PROMPT_MAX) })
      : null;

  const generate = async () => {
    setTried(true);
    if (problem || busy) return;
    setBusy(true);
    setOutcome(null);
    announce(IMAGE_TEXT.generating);
    try {
      const r = await api.generateImage(threadId, prompt.trim(), size);
      if (r.approvalId !== undefined) {
        setOutcome({ kind: 'waiting' });
        announce(IMAGE_TEXT.waitsApproval);
      } else if (r.ok) {
        // The tool's result names the artifact it saved.
        setShown(prompt.trim());
        setOutcome({ kind: 'done', artifactId: r.meta?.artifact?.id ?? null, text: r.text ?? '' });
        announce(IMAGE_TEXT.generated);
      } else {
        setOutcome({ kind: 'failed', text: r.error?.message ?? IMAGE_TEXT.notGenerated });
      }
    } catch (err) {
      setOutcome({ kind: 'failed', text: errorMessage(err, IMAGE_TEXT.failed) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={IMAGE_TEXT.generate}
      description={IMAGE_TEXT.dialogBody}
      onClose={onClose}
      initialFocusRef={first}
      className="ws-wide-dialog"
    >
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void generate();
        }}
      >
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={`${id}-prompt`}>
            {IMAGE_TEXT.description}
          </label>
          <textarea
            ref={first}
            id={`${id}-prompt`}
            className="nv-input ws-textarea"
            rows={4}
            value={prompt}
            aria-invalid={tried && problem ? true : undefined}
            aria-describedby={tried && problem ? `${id}-err` : undefined}
            onChange={(e) => setPrompt(e.target.value)}
          />
          {tried && problem ? (
            <span id={`${id}-err`} className="nv-field-error" role="alert">
              {problem}
            </span>
          ) : null}
        </div>
        <RadioGroup
          legend={IMAGE_TEXT.shapeLabel}
          name={`${id}-size`}
          value={size}
          onChange={(v) => setSize(v as ImageSize)}
          options={SHAPES.map((s) => ({
            value: s.value,
            label: IMAGE_TEXT.shape[s.shape],
            description: IMAGE_TEXT.size({ width: s.w, height: s.h }),
          }))}
        />
        <div aria-live="polite" className="img-result">
          {busy ? (
            <p className="muted">
              <Spinner label={IMAGE_TEXT.generatingShort} /> {IMAGE_TEXT.generatingLong}
            </p>
          ) : outcome?.kind === 'done' ? (
            outcome.artifactId ? (
              <figure className="img-figure">
                <img
                  src={hub.artifactContentUrl(outcome.artifactId)}
                  alt={shown}
                  className="img-preview"
                />
                <figcaption className="muted">{IMAGE_TEXT.saved}</figcaption>
              </figure>
            ) : (
              <p className="muted">{IMAGE_TEXT.saved}</p>
            )
          ) : outcome?.kind === 'waiting' ? (
            <p className="ws-callout" role="status">
              <Icon name="hand" />
              <span>{IMAGE_TEXT.approvalNote}</span>
            </p>
          ) : outcome?.kind === 'failed' ? (
            <p className="nv-field-error" role="alert">
              {outcome.text}
            </p>
          ) : null}
        </div>
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>
            {outcome?.kind === 'done' ? IMAGE_TEXT.done : IMAGE_TEXT.cancel}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : <Icon name="image" />}{' '}
            {outcome?.kind === 'done' ? IMAGE_TEXT.another : IMAGE_TEXT.go}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
