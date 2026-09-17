import type { Attachment } from '../../lib/api'

/**
 * One attachment, shaped exactly as core returns it (S28) — the
 * noticeFixture idiom, so a test says only what it is about and every other
 * field is a plausible row rather than an omission that quietly changes what
 * is being tested.
 */
export function attachmentFixture(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a1',
    filename: 'shot.png',
    media_type: 'image/png',
    kind: 'image',
    size_bytes: 2048,
    path: 'attachments/c1/shot.png',
    created_at: new Date().toISOString(),
    has_text: false,
    extract_note: null,
    ...overrides,
  }
}
