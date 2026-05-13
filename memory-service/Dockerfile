FROM python:3.12-slim
WORKDIR /app
COPY nova-contracts/ /nova-contracts/
COPY memory-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY memory-service/app/ app/
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8002"]
