FROM python:3.12-slim

RUN pip install --no-cache-dir uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY app ./app
COPY migrations ./migrations

RUN useradd --create-home --uid 1000 appuser && chown -R appuser /app
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

EXPOSE 8001
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
