FROM python:3.12-slim

# Install build tools for asyncpg compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libpq-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install nova-contracts first (rarely changes)
COPY nova-contracts /nova-contracts
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir /nova-contracts

COPY nova-worker-common /nova-worker-common
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir /nova-worker-common

COPY memory-service/pyproject.toml .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install .

COPY memory-service/app/ app/

EXPOSE 8002

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8002"]
