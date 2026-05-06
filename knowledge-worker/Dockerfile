FROM python:3.12-slim
RUN apt-get update && apt-get install -y curl && apt-get clean
WORKDIR /app
COPY nova-contracts /nova-contracts
RUN pip install /nova-contracts
COPY nova-worker-common /nova-worker-common
RUN pip install /nova-worker-common
COPY knowledge-worker/pyproject.toml .
RUN pip install .
COPY knowledge-worker/app/ app/
EXPOSE 8120
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8120"]
