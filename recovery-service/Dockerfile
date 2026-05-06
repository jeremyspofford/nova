FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client curl gnupg \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Docker CLI + compose plugin (needed for profiled service management)
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc && \
    chmod a+r /etc/apt/keyrings/docker.asc && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
      https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install shared internal package first — the trusted-network middleware lives
# here, alongside admin secret resolution used by the other internal services.
COPY nova-worker-common /nova-worker-common
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir /nova-worker-common

COPY recovery-service/pyproject.toml .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install .

COPY recovery-service/app/ app/

EXPOSE 8888

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8888"]
