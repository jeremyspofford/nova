import type { PullLine } from './api'

/**
 * The one reducer every pull consumer runs — Settings → Models, the
 * onboarding Downloading step and the Models catalogue all read the same
 * NDJSON stream (a gateway preflight line, then ollama's own lines relayed
 * verbatim, then maybe an error line), and they used to each carry their
 * own copy of this logic and of `formatBytes`. The rules that matter and
 * must hold everywhere:
 *
 *   - a pull is DONE only when the literal `{"status":"success"}` line was
 *     seen; a stream that ends quietly is a stated failure
 *     (`STREAM_ENDED_QUIET`), never a finished download;
 *   - an `error` line wins over everything after it;
 *   - the preflight line is rendered as a sentence that says where the size
 *     came from when the gateway states it (`size_source`), and says plainly
 *     when the size is unknown.
 */
export interface PullState {
  target: string
  status: string
  completed: number
  total: number
  preflight: string | null
  error: string | null
  /** The literal success line was seen. Not the same as `done`: a caller
   * may still have work to do (verify the install, write a setting). */
  sawSuccess: boolean
  done: boolean
}

export const STREAM_ENDED_QUIET =
  'the download stream ended without ollama reporting success — the model is not confirmed installed'

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

export function initialPullState(target: string): PullState {
  return {
    target,
    status: 'starting the download…',
    completed: 0,
    total: 0,
    preflight: null,
    error: null,
    sawSuccess: false,
    done: false,
  }
}

const SOURCE_LABELS: Record<string, string> = {
  'hf-hub': 'huggingface.co',
  'ollama-registry': 'registry.ollama.ai',
}

/** The preflight line as one sentence. `note` is the gateway's own words
 * (size unknown, could not check free space) and is shown verbatim. */
export function preflightNote(line: PullLine, target: string): string {
  if (line.note) return line.note
  const from = line.size_source ? ` (size from ${SOURCE_LABELS[line.size_source] ?? line.size_source})` : ''
  if (line.ok === false) {
    return `${target} needs about ${line.required_gb} GB and only ${line.free_gb} GB is free — the pull will probably fail.${from}`
  }
  return `${line.required_gb} GB needed, ${line.free_gb} GB free.${from}`
}

/** Fold one stream line into the state. Pure. */
export function applyPullLine(state: PullState, line: PullLine): PullState {
  if (line.error) return { ...state, error: line.error }
  if (line.status === 'preflight') return { ...state, preflight: preflightNote(line, state.target) }
  return {
    ...state,
    status: line.status ?? state.status,
    total: typeof line.total === 'number' ? line.total : state.total,
    completed: typeof line.completed === 'number' ? line.completed : state.completed,
    sawSuccess: state.sawSuccess || line.status === 'success',
  }
}

/** What the stream's END means: the one place the quiet-end rule lives. */
export function settlePull(state: PullState): PullState {
  if (state.error) return state
  if (!state.sawSuccess) return { ...state, error: STREAM_ENDED_QUIET }
  return { ...state, done: true }
}
