"""The attachment text chain: mechanical -> OCR, and what each REFUSES.

    docker compose exec backend python tests/test_doc_extract.py

The rails here are all of the same shape: an extraction that produced
nothing must SAY so rather than hand back an empty string, because an empty
string reaching the model reads as "the document said nothing" and it will
answer about a file it never saw. Every check below is one instance of that.
"""

import asyncio
import io
import sys

sys.path.insert(0, "/app/backend")

from app import doc_extract, ocr                            # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _pdf_with_text(body: bytes) -> bytes:
    """A minimal, real PDF carrying a text layer."""
    text = b"BT /F1 12 Tf 72 720 Td (" + body + b") Tj ET"
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
            b"/Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\nstream\n" % len(text) + text + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out = bytearray(b"%PDF-1.4\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    x = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for o in offs:
        out += b"%010d 00000 n \n" % o
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objs) + 1, x)
    return bytes(out)


def _rendered_page(lines: list[str]) -> tuple[bytes, bytes]:
    """(png, pdf) of TEXT DRAWN AS PIXELS — a scan, with no text layer.
    This is the case doc_extract refuses on its own and OCR exists for."""
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (1700, 130 * len(lines) + 80), "white")
    d = ImageDraw.Draw(img)
    y = 40
    for ln in lines:
        d.text((60, y), ln, fill="black")
        y += 130
    png, pdf = io.BytesIO(), io.BytesIO()
    img.save(png, format="PNG")
    img.save(pdf, format="PDF", resolution=200)
    return png.getvalue(), pdf.getvalue()


async def main():
    print("1. mechanical extraction is preferred and labelled as such")
    pdf = _pdf_with_text(b"The quick brown fox jumps over the lazy dog.")
    text, src = await doc_extract.extract_best(pdf, "a.pdf", "application/pdf")
    check("a PDF with a text layer is read mechanically, not by OCR",
          src == "mechanical" and "quick brown fox" in text, src)

    text, src = await doc_extract.extract_best(b"hello there, a plain file", "a.txt")
    check("a text file is mechanical too", src == "mechanical", src)

    print("\n2. OCR is available, and is DERIVED from the binaries being present")
    ok, why = ocr.available()
    check("tesseract and pdftoppm are installed in this image", ok, why)

    print("\n3. a scan falls through to OCR — the case that used to be refused")
    lines = ["COUNTY OF SANTA CLARA", "Notice of Assessment",
             "Reference ARTICHOKE 7731"]
    png, scan_pdf = _rendered_page(lines)

    raised = None
    try:
        doc_extract.extract(scan_pdf, "scan.pdf", "application/pdf")
    except doc_extract.Unextractable as e:
        raised = str(e)
    check("mechanical extraction still REFUSES a scan rather than returning ''",
          raised is not None and "no extractable text layer" in (raised or ""),
          (raised or "no refusal")[:60])

    text, src = await doc_extract.extract_best(scan_pdf, "scan.pdf", "application/pdf")
    check("...and extract_best reads it with OCR instead", src == "ocr", src)
    check("...recovering the document's actual words",
          "SANTA" in text.upper().replace(" ", "") or "ARTICHOKE" in text.upper(),
          text.strip()[:60])

    print("\n4. a photographed document is read the same way")
    text, src = await doc_extract.extract_image(png, "letter.png")
    check("an image yields OCR text", src == "ocr" and len(text) > 20, src)
    check("...containing the reference on the page",
          "ARTICHOKE" in text.upper().replace(" ", ""), text.strip()[:60])

    print("\n5. the refusals that keep a bad read from reading as an empty document")
    blank_png, blank_pdf = _rendered_page(["   "])
    raised = None
    try:
        await doc_extract.extract_image(blank_png, "blank.png")
    except doc_extract.Unextractable as e:
        raised = str(e)
    check("a blank image is REFUSED, never returned as empty text",
          raised is not None, raised or "returned successfully")

    raised = None
    try:
        await doc_extract.extract_best(scan_pdf, "scan.pdf", "application/pdf",
                                       allow_ocr=False)
    except doc_extract.Unextractable as e:
        raised = str(e)
    check("with OCR switched off the scan refuses, rather than silently "
          "contributing nothing", raised is not None, (raised or "")[:60])

    raised = None
    try:
        await doc_extract.extract_best(b"PK\x03\x04nonsense", "x.zip", "")
    except doc_extract.Unsupported as e:
        raised = str(e)
    check("a zip container is refused with a reason the operator can act on",
          raised is not None, (raised or "")[:60])

    print("\n6. truncation announces itself (a gap the model cannot flag)")
    big = _pdf_with_text(b"word " * 20000)
    text, src = await doc_extract.extract_best(big, "big.pdf", "application/pdf")
    check("an over-long document is cut", len(text) < 200_000)
    check("...and SAYS it was cut, naming both numbers",
          "TRUNCATED" in text and "60,000" in text, text[-90:].replace("\n", " "))

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    asyncio.run(main())
