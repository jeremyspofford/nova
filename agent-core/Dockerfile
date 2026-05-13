# agent-core/Dockerfile
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# nova-contracts copied from repo root build context
COPY nova-contracts/ /nova-contracts/

COPY agent-core/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY agent-core/app/ app/

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
