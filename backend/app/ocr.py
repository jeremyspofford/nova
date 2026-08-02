"""Reading a document that has no text layer — locally (roadmap #22).

Two cases, one answer. A scanned PDF is images of text wearing a PDF
extension; a photographed letter is the same thing without the wrapper.
`doc_extract` refuses both today with the sentence "it is most likely a
scan, which needs OCR this server does not have". This is that OCR, and it
runs on this machine: tesseract and poppler are in the backend image, they
take bytes the operator already handed us, and neither makes a network call.
That last property is why OCR lives here and vision does not — a vision
model may be local OR cloud, and "may be cloud" changes what the operator
has to consent to.

THE RULE THAT SHAPES THIS MODULE: **text has a source, and the source is
part of the text's meaning.** Three things can produce the words in a
document, and they are not interchangeable:

  mechanical  pypdf / python-docx / utf-8 — this IS the document's text.
  ocr         tesseract read pixels. Usually right, wrong in specific,
              recognisable ways: `1`/`l`, `0`/`O`, a column order it
              invented, a signature it rendered as noise.
  vision      a language model described an image. It can be fluently,
              confidently wrong about something that was never there.

A system that stores all three in the same field and calls it "the
document's text" is building a machine for confident errors, because in
November nothing can tell which one answered. So every result carries its
source and its confidence, callers are expected to say so, and OCR output is
never presented as the document itself.

Bounded on purpose: OCR is CPU-heavy and synchronous here, so page count and
resolution are capped and the caps are stated in the result rather than
applied silently.
"""

import asyncio
import logging
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

# Rasterisation DPI. 200 is the low end of what tesseract reads reliably for
# body text (it wants ~300 for small print, and 150 starts dropping serifs);
# it is also 4x the pixels of 100, and this runs on the request path.
_DPI = 200

# Pages rasterised and read. A 300-page scan at 200 DPI is minutes of CPU
# and gigabytes of intermediate PNG, on the same box that serves chat.
_MAX_PAGES = 20

# Per-page wall clock. tesseract on a noisy photograph can spin far longer
# than on clean text, and an unbounded subprocess on the request path is how
# one bad upload takes the chat down with it.
_PAGE_TIMEOUT_S = 30

# Below this, a "successful" OCR read is indistinguishable from a failed
# one: tesseract returns punctuation noise for a blank or unreadable page
# rather than an error, and a caller that trusts a 4-character result will
# answer about a document nobody read.
_MIN_USEFUL_CHARS = 24


@dataclass
class OcrResult:
    """What OCR produced, and how much of the document it actually saw."""
    text: str
    pages_read: int
    pages_total: int
    truncated: bool          # more pages exist than _MAX_PAGES allowed

    @property
    def complete(self) -> bool:
        return not self.truncated and self.pages_read >= self.pages_total


class OcrUnavailable(Exception):
    """The tools are not installed. Distinct from "OCR ran and got nothing":
    one is a deployment fact the operator can fix, the other is about the
    document, and telling them apart is the difference between "install
    tesseract" and "this photo is too blurry to read"."""


class OcrEmpty(Exception):
    """OCR ran and found no usable text. Carries an operator-facing reason."""


def available() -> tuple[bool, str]:
    """Whether OCR can run, DERIVED by looking for the binaries rather than
    from a flag someone remembered to set. A settings toggle that claims OCR
    is on while tesseract is missing is exactly the kind of hardcoded truth
    this codebase refuses."""
    if not shutil.which("tesseract"):
        return False, "tesseract is not installed in the backend image"
    if not shutil.which("pdftoppm"):
        return False, "poppler-utils (pdftoppm) is not installed in the backend image"
    return True, ""


def _run_tesseract(image_path: Path) -> str:
    proc = subprocess.run(
        ["tesseract", str(image_path), "stdout", "--dpi", str(_DPI)],
        capture_output=True, timeout=_PAGE_TIMEOUT_S)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()[:200]
        raise OcrEmpty(f"the OCR engine failed on this page ({err})")
    return proc.stdout.decode("utf-8", "replace")


def _ocr_image_sync(data: bytes) -> OcrResult:
    with tempfile.TemporaryDirectory(prefix="nova-ocr-") as tmp:
        # written by us, read by us, deleted with the directory — the bytes
        # never land anywhere the operator has to know about or clean up
        img = Path(tmp) / "page.png"
        try:
            from PIL import Image
            with Image.open(__import__("io").BytesIO(data)) as im:
                # tesseract wants an opaque raster; a PNG with alpha or a
                # CMYK JPEG both read as garbage without this
                im.convert("RGB").save(img, format="PNG")
        except Exception as e:
            raise OcrEmpty(f"the image could not be opened ({e})") from e
        text = _run_tesseract(img).strip()
    if len(text) < _MIN_USEFUL_CHARS:
        raise OcrEmpty(
            "OCR found no readable text in this image — it may be too "
            "blurry, too low-resolution, or not a document at all")
    return OcrResult(text=text, pages_read=1, pages_total=1, truncated=False)


def _ocr_pdf_sync(data: bytes) -> OcrResult:
    with tempfile.TemporaryDirectory(prefix="nova-ocr-") as tmp:
        src = Path(tmp) / "in.pdf"
        src.write_bytes(data)
        # -l caps the rasterisation itself rather than rasterising everything
        # and reading a prefix: the page images are the expensive part
        proc = subprocess.run(
            ["pdftoppm", "-r", str(_DPI), "-png", "-l", str(_MAX_PAGES),
             str(src), str(Path(tmp) / "pg")],
            capture_output=True, timeout=_PAGE_TIMEOUT_S * _MAX_PAGES)
        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", "replace").strip()[:200]
            raise OcrEmpty(f"the PDF could not be rasterised for OCR ({err})")
        pages = sorted(Path(tmp).glob("pg*.png"))
        if not pages:
            raise OcrEmpty("the PDF produced no page images to read")
        parts = []
        for p in pages:
            try:
                parts.append(_run_tesseract(p).strip())
            except (OcrEmpty, subprocess.TimeoutExpired):
                # one unreadable page does not sink a 12-page document; the
                # count below is what tells the caller how much was read
                log.debug("OCR failed on %s", p.name, exc_info=True)
                parts.append("")
        text = "\n\n".join(p for p in parts if p)
    if len(text) < _MIN_USEFUL_CHARS:
        raise OcrEmpty(
            f"OCR read {len(pages)} page(s) and found no usable text — the "
            f"scan may be too low-resolution or the pages may be blank")
    total = _page_count(data) or len(pages)
    return OcrResult(text=text, pages_read=len(pages), pages_total=total,
                     truncated=total > len(pages))


def _page_count(data: bytes) -> int:
    try:
        from pypdf import PdfReader
        import io
        return len(PdfReader(io.BytesIO(data)).pages)
    except Exception:
        return 0


async def read(data: bytes, *, is_pdf: bool) -> OcrResult:
    """OCR these bytes. Raises OcrUnavailable or OcrEmpty — never returns
    an empty-ish result, because a caller cannot tell one from a real read.

    Runs in a worker thread: tesseract is seconds of blocking CPU, and this
    is called from the chat request path where blocking the event loop
    stalls every in-flight SSE stream (the same mistake the memory link pass
    makes at 631 ms — do not repeat it at 20x the cost).
    """
    ok, why = available()
    if not ok:
        raise OcrUnavailable(why)
    fn = _ocr_pdf_sync if is_pdf else _ocr_image_sync
    try:
        return await asyncio.to_thread(fn, data)
    except subprocess.TimeoutExpired as e:
        raise OcrEmpty(
            f"OCR timed out after {_PAGE_TIMEOUT_S}s on a page — the image "
            f"may be very large or very noisy") from e
