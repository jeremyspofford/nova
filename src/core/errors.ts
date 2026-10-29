// One error type for the core. The code decides the HTTP status; the message is written for a
// person, because it may be shown as-is.
export type ErrorCode = 'validation' | 'not_found' | 'conflict' | 'forbidden';

const STATUS: Record<ErrorCode, number> = { validation: 400, forbidden: 403, not_found: 404, conflict: 409 };

export class CoreError extends Error {
  readonly code: ErrorCode;
  readonly details: string[];
  constructor(code: ErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.details = details;
  }
  get status(): number {
    return STATUS[this.code];
  }
}
