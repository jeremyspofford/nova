FROM python:3.12-slim

# espeak-ng: phonemizer fallback some kokoro-onnx versions use for OOD words
RUN apt-get update && apt-get install -y --no-install-recommends \
        espeak-ng curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "kokoro-onnx>=0.4" "fastapi>=0.104" "uvicorn>=0.24" numpy

WORKDIR /srv
COPY app.py .

EXPOSE 8880
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s \
    CMD curl -sf http://localhost:8880/health || exit 1
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8880"]
