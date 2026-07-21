FROM python:3.12-slim

# Node.js/npx for the JS-based reference MCP servers (filesystem, git, etc.
# — most of the official @modelcontextprotocol/server-* packages). Python
# -based stdio servers (uvx-launched) are covered by the base image itself.
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .

EXPOSE 8100
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8100"]
