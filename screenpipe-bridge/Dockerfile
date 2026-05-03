FROM python:3.12-slim

WORKDIR /app

COPY nova-contracts /nova-contracts
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir /nova-contracts

COPY screenpipe-bridge/pyproject.toml .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install .

COPY screenpipe-bridge/app/ app/

EXPOSE 8140

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8140"]
