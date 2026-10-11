FROM python:3.12-slim

RUN pip install --no-cache-dir uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY app ./app
COPY migrations ./migrations

RUN useradd --create-home --uid 1000 appuser && chown -R appuser /app

# WORKSPACE_ROOT's mount point has to exist in the image, owned by the user
# the process runs as. Docker initialises an empty named volume from the
# image path it is mounted over — ownership included — so without this the
# v4_workspace volume arrives root-owned and the very first
# workspace_write_file fails with a permission error the model can do
# nothing about. Exactly the failure the memory service hit on the first
# real install (see services/memory/Dockerfile).
# /data/browser-output (S38) is the browser engine's output volume, for the
# same reason.
RUN mkdir -p /data/workspace /data/browser-output && chown -R appuser /data

USER appuser

ENV PATH="/app/.venv/bin:${PATH}"
# Build identity (S32.1): the commit and this service's content hash that
# ./install passes as build args (deploy/docker-compose.yml). Declared after
# the last RUN on purpose: a RUN after an ARG gets it in its environment, so
# every new commit would miss the cache on uv sync and the user layers. Baked
# as ENV (/status reads it) and as labels (./install's verify step reads them
# off the running container). Built without them, both are empty: never a
# made-up value.
ARG NOVA_BUILD_SHA=
ARG NOVA_CONTENT_HASH=
ENV NOVA_BUILD_SHA="$NOVA_BUILD_SHA" NOVA_CONTENT_HASH="$NOVA_CONTENT_HASH"
LABEL nova.build-sha="$NOVA_BUILD_SHA" nova.content-hash="$NOVA_CONTENT_HASH"

EXPOSE 8000
# --timeout-graceful-shutdown: on SIGTERM uvicorn stops accepting, waits for
# open connections (an in-flight SSE turn is one) up to this many seconds,
# and only THEN runs the lifespan shutdown — the drain that lets a detached
# turn close its trace (app/main.py). Unset it waits forever, so a stuck
# connection meant compose's SIGKILL landed before the drain ever ran. 300 =
# chat.GATEWAY_TIMEOUT.read, the longest one gateway call can hold a turn
# open; deploy/docker-compose.yml's stop_grace_period is this plus a margin
# for the drain itself, and tests/test_traces.py pins the ordering.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--timeout-graceful-shutdown", "300"]
