FROM python:3.12-slim

# libgomp1: OpenMP runtime ctranslate2 (faster-whisper's backend) needs.
# PyAV bundles ffmpeg libs, so webm/opus/mp4 decode without a system ffmpeg.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "faster-whisper>=1.0" "fastapi>=0.104" "uvicorn>=0.24"

WORKDIR /srv
COPY app.py .

EXPOSE 9000
HEALTHCHECK --interval=30s --timeout=3s --start-period=90s \
    CMD curl -sf http://localhost:9000/health || exit 1
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9000"]
