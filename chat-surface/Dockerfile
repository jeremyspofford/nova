FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY nova-contracts/ /nova-contracts/
COPY chat-surface/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY chat-surface/app/ app/
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8004"]
