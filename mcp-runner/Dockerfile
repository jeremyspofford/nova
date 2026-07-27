FROM python:3.12-slim

# Node.js/npx for the JS-based reference MCP servers (filesystem, git, etc.
# — most of the official @modelcontextprotocol/server-* packages). Python
# -based stdio servers (uvx-launched) are covered by the base image itself.
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# The filesystem server is BAKED, not fetched at runtime. Two reasons:
# the hardened container mounts its caches noexec, so a package downloaded
# into tmpfs cannot run — and more importantly a pinned, image-resident
# version is auditable, where `npx -y` fetches and executes whatever the
# registry serves that minute. Registered as `node <path>`, which keeps the
# stdio launcher allow-list intact (mcp_servers._STDIO_COMMANDS).
RUN npm install -g --no-fund --no-audit \
        @modelcontextprotocol/server-filesystem@2025.8.21 \
    && npm cache clean --force

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .

EXPOSE 8100
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8100"]
