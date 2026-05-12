FROM python:3.12-slim
WORKDIR /app
COPY nova-contracts/ /nova-contracts/
COPY voice-gateway/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY voice-gateway/app/ app/
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8003"]
