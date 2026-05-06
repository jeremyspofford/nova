FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY nova-contracts /nova-contracts
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir /nova-contracts

COPY nova-worker-common /nova-worker-common
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir /nova-worker-common

COPY cortex/pyproject.toml .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install .

COPY cortex/app/ app/

EXPOSE 8100

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
