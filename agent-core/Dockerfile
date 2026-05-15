# agent-core/Dockerfile
FROM python:3.12-slim

# System deps + Node.js 20 (needed for Playwright MCP server)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright MCP globally so it's available as a stdio server
RUN npm install -g @playwright/mcp@latest

# Install Playwright's Chromium browser + its OS dependencies
RUN npx playwright install chromium --with-deps

WORKDIR /app

# nova-contracts copied from repo root build context
COPY nova-contracts/ /nova-contracts/

COPY agent-core/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY agent-core/app/ app/

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
