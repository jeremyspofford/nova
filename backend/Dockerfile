FROM python:3.12-slim

WORKDIR /app/backend

# tesseract-ocr + poppler-utils are the LOCAL half of reading a document that
# has no text layer: a scanned PDF or a photographed letter. They stay in the
# image rather than in a sidecar because they take bytes the operator already
# handed us and make no network call of their own — the property that decides
# where extraction lives (see doc_extract.py). eng only; more languages are
# `tesseract-ocr-<lang>` and a settings change away.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl tesseract-ocr poppler-utils postgresql-client \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml .
RUN pip install --no-cache-dir -e .

# The application itself. It used to be absent: only pyproject.toml was
# copied, so the image held the dependencies and none of the code, and every
# container was really running the ./backend bind mount from docker-compose.
# That works exactly once — on this machine. The bind mount still shadows
# this in dev, so nothing changes day to day; the difference is that the
# image can now stand on its own.
COPY app ./app

EXPOSE 8000

# No --reload here. uvicorn's reloader is a dev tool (an extra watcher
# process, a restart on any file touch, no worker management) and it was the
# production entrypoint because it was the only entrypoint. docker-compose
# adds it back for the dev container, which is where it belongs.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
