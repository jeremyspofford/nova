FROM python:3.12-slim

# ffmpeg: audio transcode + fixed-window slicing for the whisper fallback.
# yt-dlp: source-neutral extraction (1000+ sites) + caption fetch, keyless.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "yt-dlp>=2024.1" "fastapi>=0.104" "uvicorn>=0.24" "httpx>=0.27"

WORKDIR /srv
COPY app.py .

EXPOSE 8500
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD curl -sf http://localhost:8500/health || exit 1
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8500"]
