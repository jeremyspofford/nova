"""Media ingestion worker — yt-dlp (1000+ sites, keyless) + ffmpeg extraction,
with the whisper service as the universal fallback for caption-less audio and
direct media URLs. docs/plans/content-ingestion.md, phase 1.

Isolated from the backend on purpose (the same reasoning as the whisper/kokoro
services): ALL outbound media fetching and the heavy yt-dlp/ffmpeg binaries
live here, never in the backend process. No published port — only the
backend talks to this service, over the compose network.

    GET  /health
    POST /extract {url} ->
        {media_key, extractor, id, title, url, uploader, duration_s,
         transcript_source: "captions"|"whisper", language, chapters,
         segments: [{start, end, text, deep_link}]}
        or {"status": "skipped", "reason": ...} for live/upcoming streams
        (4xx/5xx with a plain-text detail on failure — never a silent drop)

Source-neutral by construction: `extractor` + `id` come from yt-dlp itself
(the same code path handles YouTube, Vimeo, Twitch, direct .mp4/.mp3 links,
...), so `media_key = "<extractor>:<id>"` never assumes a particular site.
"""

import asyncio
import logging
import os
import re
import shutil
import subprocess
import tempfile
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
import yt_dlp
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("media")

WHISPER_URL = os.environ.get("WHISPER_URL", "http://whisper:9000")
# safety cap: a source can plausibly point at anything; refuse before
# downloading rather than let one request run unbounded (docs/plans/
# content-ingestion.md "Traps" — mirrors the original video-ingestion.md
# backfill-cap reasoning, applied to single-item duration instead)
MAX_DURATION_S = int(os.environ.get("MEDIA_MAX_DURATION_S", "14400"))       # 4h
# whisper-fallback windowing: fixed-length chunks so one 3-hour video is many
# bounded requests, not a single giant one. Coarser than caption cue timing
# by design — see the plan's chunking-policy note.
WINDOW_S = int(os.environ.get("MEDIA_WHISPER_WINDOW_S", "300"))            # 5 min
WHISPER_TIMEOUT_S = float(os.environ.get("MEDIA_WHISPER_TIMEOUT_S", "300"))

app = FastAPI(title="nova-media")


class ExtractRequest(BaseModel):
    url: str


@app.get("/health")
async def health():
    return {"status": "ready", "yt_dlp_version": yt_dlp.version.__version__}


# ── native deep links ────────────────────────────────────────────────────

def _timestamp_url(url: str, extractor: str, seconds: float) -> str:
    """Best-effort site-native deep link at a timestamp. An unrecognized
    extractor gets the plain URL back rather than a guessed (possibly wrong)
    param — honesty over a confident-looking broken link."""
    sec = int(seconds)
    ex = (extractor or "").lower()
    if "youtube" in ex:
        parts = urlsplit(url)
        q = dict(parse_qsl(parts.query))
        q["t"] = f"{sec}s"
        return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(q), parts.fragment))
    if "vimeo" in ex:
        return f"{url}#t={sec}s"
    if ex in ("generic", ""):
        # HTML5 media-fragment syntax — works when the link is opened as
        # <video>/<audio> src; best-effort for a direct file URL.
        return f"{url}#t={sec}"
    return url


# ── captions (VTT) ───────────────────────────────────────────────────────

_TS_RE = re.compile(
    r"(\d{2}:)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}:)?(\d{2}):(\d{2})[.,](\d{3})")


def _ts_seconds(hours: str | None, minutes: str, seconds: str, millis: str) -> float:
    h = int(hours[:-1]) if hours else 0
    return h * 3600 + int(minutes) * 60 + int(seconds) + int(millis) / 1000


def _vtt_to_segments(vtt_text: str) -> list[dict]:
    """Minimal WebVTT cue parser: timestamps + text, inline tags stripped,
    consecutive duplicate cues collapsed (rolling auto-captions repeat the
    previous line as a visual effect — collapsing avoids near-duplicate
    chunks downstream)."""
    segments: list[dict] = []
    cur: dict | None = None
    for line in vtt_text.splitlines():
        m = _TS_RE.search(line)
        if m:
            if cur and cur["text"]:
                segments.append(cur)
            start = _ts_seconds(m.group(1), m.group(2), m.group(3), m.group(4))
            end = _ts_seconds(m.group(5), m.group(6), m.group(7), m.group(8))
            cur = {"start": start, "end": end, "text": ""}
            continue
        stripped = line.strip()
        if cur is None or not stripped or stripped.isdigit() or stripped.startswith("WEBVTT") \
                or stripped.startswith("NOTE") or stripped.startswith("Kind:") \
                or stripped.startswith("Language:"):
            continue
        text = re.sub(r"<[^>]+>", "", stripped).strip()
        if text:
            cur["text"] = (cur["text"] + " " + text).strip()
    if cur and cur["text"]:
        segments.append(cur)

    out: list[dict] = []
    for seg in segments:
        if out and out[-1]["text"] == seg["text"]:
            out[-1]["end"] = seg["end"]
            continue
        out.append(seg)
    return out


def _pick_track(tracks: dict) -> tuple[str, str] | None:
    """(lang, vtt_url) from a yt-dlp subtitles/automatic_captions dict,
    preferring English, else whatever's first. Only vtt is supported — the
    format every yt-dlp-backed site we've checked offers alongside its
    native ones; parsing every subtitle format is not worth the complexity
    for phase 1."""
    if not tracks:
        return None
    order = [k for k in tracks if k.startswith("en")] + \
        [k for k in tracks if not k.startswith("en")]
    for lang in order:
        for fmt in tracks.get(lang) or []:
            if fmt.get("ext") == "vtt" and fmt.get("url"):
                return lang, fmt["url"]
    return None


# ── yt-dlp (blocking; always run via asyncio.to_thread) ─────────────────

def _extract_info(url: str) -> dict:
    opts = {"quiet": True, "no_warnings": True, "skip_download": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        return ydl.extract_info(url, download=False)


def _probe_duration(path: str) -> float | None:
    """Actual duration of a downloaded file via ffprobe — yt-dlp's own
    metadata leaves `duration` unset for many generic/direct-URL downloads
    (confirmed live: a plain .ogg link), which would otherwise make the
    LAST window's end-timestamp wrong (it'd fall back to a full window
    length instead of the real, shorter clip)."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            check=True, capture_output=True, timeout=30, text=True)
        return float(out.stdout.strip())
    except Exception:
        log.warning("ffprobe duration read failed for %s", path)
        return None


def _download_and_window(url: str, duration_s: float | None
                         ) -> tuple[list[tuple[float, float, str]], float | None]:
    """yt-dlp bestaudio download, then one ffmpeg pass that resamples to
    whisper's expected 16kHz mono AND slices into fixed windows. Returns
    ([(start_s, end_s, wav_path)], probed_duration) — probed_duration fills
    in when yt-dlp's own metadata didn't report one, so the caller can
    correct both the last window's end and the response's duration_s."""
    tmp = tempfile.mkdtemp(prefix="media-")
    opts = {"quiet": True, "no_warnings": True, "format": "bestaudio/best",
            "outtmpl": os.path.join(tmp, "audio.%(ext)s")}
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    src = next((os.path.join(tmp, f) for f in os.listdir(tmp)
               if f.startswith("audio.")), None)
    if not src:
        shutil.rmtree(tmp, ignore_errors=True)
        raise RuntimeError("audio download produced no file")

    probed = duration_s or _probe_duration(src)

    chunk_tpl = os.path.join(tmp, "chunk_%04d.wav")
    subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-ar", "16000", "-ac", "1",
         "-f", "segment", "-segment_time", str(WINDOW_S),
         "-reset_timestamps", "1", chunk_tpl],
        check=True, capture_output=True, timeout=1800)

    windows = []
    for i, fname in enumerate(sorted(f for f in os.listdir(tmp) if f.startswith("chunk_"))):
        start = float(i * WINDOW_S)
        end = float(min((i + 1) * WINDOW_S, probed or (i + 1) * WINDOW_S))
        windows.append((start, end, os.path.join(tmp, fname)))
    return windows, probed


# ── the endpoint ──────────────────────────────────────────────────────────

@app.post("/extract")
async def extract(req: ExtractRequest):
    url = req.url.strip()
    if not url:
        raise HTTPException(400, "url is required")

    try:
        info = await asyncio.to_thread(_extract_info, url)
    except yt_dlp.utils.DownloadError as e:
        raise HTTPException(422, f"could not read '{url}': {e}")
    except Exception as e:
        log.exception("extract_info failed for %s", url)
        raise HTTPException(500, f"extraction failed: {e}")

    if info.get("is_live") or info.get("is_upcoming"):
        return {"status": "skipped",
                "reason": "live/upcoming stream has no final transcript"}

    extractor = (info.get("extractor_key") or info.get("extractor") or "generic").lower()
    media_id = str(info.get("id"))
    media_key = f"{extractor}:{media_id}"
    canonical_url = info.get("webpage_url") or url
    title = info.get("title") or media_key
    duration_s = info.get("duration")

    if duration_s and duration_s > MAX_DURATION_S:
        raise HTTPException(
            422, f"'{title}' is {int(duration_s / 60)} min, over the "
                f"{int(MAX_DURATION_S / 60)}-min cap for one ingest")

    chapters = [{"title": c.get("title"), "start": c.get("start_time")}
                for c in (info.get("chapters") or []) if c.get("start_time") is not None]

    picked = _pick_track(info.get("subtitles") or {}) or \
        _pick_track(info.get("automatic_captions") or {})
    segments_raw: list[dict] = []
    language = None
    transcript_source = None

    if picked:
        language, vtt_url = picked
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(vtt_url)
                resp.raise_for_status()
            segments_raw = _vtt_to_segments(resp.text)
            transcript_source = "captions"
        except httpx.HTTPError as e:
            log.warning("caption fetch failed for %s (%s) — falling back to whisper", url, e)

    if not segments_raw:
        try:
            windows, probed_duration = await asyncio.to_thread(
                _download_and_window, url, duration_s)
        except Exception as e:
            log.exception("audio download/window failed for %s", url)
            raise HTTPException(502, f"no captions available and audio "
                                     f"extraction failed: {e}")
        # yt-dlp's own metadata often omits duration for generic/direct-URL
        # downloads (confirmed live) — the ffprobe reading is the truer value
        duration_s = duration_s or probed_duration
        tmp_dir = os.path.dirname(windows[0][2]) if windows else None
        try:
            async with httpx.AsyncClient(timeout=WHISPER_TIMEOUT_S) as client:
                for start, end, path in windows:
                    with open(path, "rb") as f:
                        data = f.read()
                    try:
                        resp = await client.post(f"{WHISPER_URL}/transcribe", content=data)
                        resp.raise_for_status()
                    except httpx.ConnectError:
                        raise HTTPException(
                            502, "no captions available and the whisper service isn't "
                                "running — start it with 'docker compose --profile "
                                "voice up -d whisper', or ingest a captioned source")
                    except httpx.HTTPError as e:
                        raise HTTPException(502, f"whisper transcription failed: {e}")
                    body = resp.json()
                    text = (body.get("text") or "").strip()
                    language = language or body.get("language")
                    if text:
                        segments_raw.append({"start": start, "end": end, "text": text})
        finally:
            if tmp_dir:
                shutil.rmtree(tmp_dir, ignore_errors=True)
        transcript_source = "whisper"

    if not segments_raw:
        raise HTTPException(422, f"'{title}' produced no transcribable audio or captions")

    segments = [{**s, "deep_link": _timestamp_url(canonical_url, extractor, s["start"])}
                for s in segments_raw]

    return {
        "media_key": media_key, "extractor": extractor, "id": media_id,
        "title": title, "url": canonical_url, "uploader": info.get("uploader"),
        "duration_s": duration_s, "transcript_source": transcript_source,
        "language": language, "chapters": chapters, "segments": segments,
    }
