FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash sandbox
RUN mkdir -p /workspace.in /workspace.out /tmp \
    && chown sandbox:sandbox /workspace.out /tmp
USER sandbox
WORKDIR /workspace.out
CMD ["sleep", "infinity"]
