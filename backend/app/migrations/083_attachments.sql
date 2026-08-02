-- Migration 083: attachments as first-class objects (roadmap #22b).
--
-- Until now an attachment rode ONE turn and vanished. That was survivable
-- while every file also sat in the operator's Downloads folder; it stopped
-- being survivable when he said he intends to attach documents from his
-- phone — a photographed letter or receipt that exists in exactly one place,
-- and re-attaching it later is not possible because the camera roll is not a
-- filing system and the turn destroyed the only copy it ever had.
--
-- IDENTITY IS NOT THE FILENAME. This is the whole design, and it is a
-- reaction to a specific defect: every earlier sketch of this feature keyed
-- the stored document on its name, so March's `invoice.pdf` and July's
-- `invoice.pdf` collapsed onto one record and the second silently destroyed
-- the first. `Scan.pdf`, `statement.pdf`, `IMG_0042.jpg` are what phones
-- actually produce — the collision is the normal case, not the edge. Here a
-- row is identified by a UUID, and its BYTES by sha256. Two documents that
-- share a name are two rows; the same document sent twice is two rows over
-- one blob. Neither can overwrite the other, because nothing is keyed on
-- something the operator can repeat.
--
-- The bytes live on disk, content-addressed, not in this table. Measured:
-- TOAST compression is a no-op on PDFs and JPEGs (already compressed), and
-- pg_dump is not streamed here, so blobs in Postgres would inflate exactly
-- the backup that does not exist yet (#31).
--
-- message_id is SET NULL, deliberately NOT CASCADE. Cascading would mean
-- clearing a conversation destroys the documents it carried — and the
-- premise of this whole feature is that those documents exist nowhere else.
-- A chat is ephemeral; the letter he photographed is not. Deleting a
-- document is its own act, with its own endpoint.

CREATE TABLE IF NOT EXISTS attachments (
    id              uuid PRIMARY KEY,
    -- content address of the bytes on disk. NOT unique: the same document
    -- attached twice is two rows sharing one blob, and the blob is unlinked
    -- only when the last row referencing it goes (derived by query, never a
    -- refcount column that can drift from the truth).
    sha256          text NOT NULL,
    -- what the operator's device called it. A LABEL, never an address —
    -- nothing resolves by this column.
    display_name    text NOT NULL,
    mime            text NOT NULL DEFAULT '',
    bytes           bigint NOT NULL,
    kind            text NOT NULL,

    -- What could be read out of it, and HOW. The source is stored because
    -- the three are different kinds of claim: `mechanical` IS the document's
    -- text, `ocr` is tesseract's reading of pixels (wrong in specific,
    -- recognisable ways — a misread digit in an amount), `vision` is a model
    -- describing an image and can be confidently wrong about something that
    -- was never on the page. A column that held all three and called itself
    -- "the text" would be a machine for confident errors in November.
    text_content    text,
    text_source     text,
    -- why there is no text, in the operator's words, so the Documents list
    -- can say "no text layer, and OCR found nothing" rather than sit blank
    text_error      text,

    message_id      uuid REFERENCES messages(id) ON DELETE SET NULL,
    conversation_id uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT attachments_kind_check CHECK (kind IN ('doc', 'image', 'text')),
    CONSTRAINT attachments_text_source_check
        CHECK (text_source IS NULL OR text_source IN ('mechanical', 'ocr', 'vision'))
);

-- the Documents list is newest-first; the sha index backs both dedupe on
-- write and the last-reference check on delete
CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_sha ON attachments (sha256);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments (message_id);

COMMENT ON COLUMN attachments.sha256 IS
  'Content address of the bytes under data/attachments/<sha[0:2]>/<sha>. Not unique — the last row referencing a blob unlinks it.';
COMMENT ON COLUMN attachments.display_name IS
  'What the device called the file. A label only: nothing resolves by name, because two documents routinely share one.';
COMMENT ON COLUMN attachments.text_source IS
  'mechanical = the document''s own text layer; ocr = tesseract read pixels; vision = a model described an image. Never interchangeable.';
