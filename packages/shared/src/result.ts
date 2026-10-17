// A small Result type for operations whose failures are expected values, not exceptions.
import type { ErrorBody } from './errors.ts';

export type Result<T, E = ErrorBody> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
