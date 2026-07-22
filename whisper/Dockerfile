FROM python:3.12-slim

# libgomp1: OpenMP runtime ctranslate2 (faster-whisper's backend) needs.
# PyAV bundles ffmpeg libs, so webm/opus/mp4 decode without a system ffmpeg.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

# faster-whisper + the CUDA 12 runtime libs its backend (ctranslate2) needs on
# GPU. The libs just ride along in the image; WHISPER_DEVICE=cpu ignores them,
# so the SAME image runs on CPU or GPU — the nvidia container runtime injects
# the driver at run time, these provide cuBLAS + cuDNN. LD_LIBRARY_PATH points
# ctranslate2 at them.
RUN pip install --no-cache-dir "faster-whisper>=1.1" "fastapi>=0.104" "uvicorn>=0.24" \
        nvidia-cublas-cu12 nvidia-cudnn-cu12
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib:/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib

WORKDIR /srv
COPY app.py .

EXPOSE 9000
HEALTHCHECK --interval=30s --timeout=3s --start-period=90s \
    CMD curl -sf http://localhost:9000/health || exit 1
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9000"]
