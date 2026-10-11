FROM python:3.12-slim

RUN pip install --no-cache-dir uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY app ./app
COPY migrations ./migrations

RUN useradd --create-home --uid 1000 appuser && chown -R appuser /app

# MEMORY_ROOT's mount point has to exist in the image, owned by the user the
# process runs as. Docker initialises an empty named volume from the image
# path it is mounted over — including its ownership — so without this the
# v4_memdata volume arrives root-owned and the service dies on its very first
# boot with "PermissionError: '/data/memory/people'", before it has written a
# single file. (Found by the first real install, 2026-08-28.)
RUN mkdir -p /data/memory && chown -R appuser /data

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

EXPOSE 8002
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8002"]
