# Playwright's Python image ships the browsers + system deps preinstalled.
FROM mcr.microsoft.com/playwright/python:v1.48.0-noble

WORKDIR /app

COPY nova-contracts /nova-contracts
RUN pip install --no-cache-dir /nova-contracts

COPY nova-worker-common /nova-worker-common
RUN pip install --no-cache-dir /nova-worker-common

COPY browser-worker/pyproject.toml .
RUN pip install --no-cache-dir .

COPY browser-worker/app/ app/

EXPOSE 8150

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8150"]
