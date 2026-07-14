FROM python:3.12-alpine

RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /srv
COPY server.py .

EXPOSE 9911
CMD ["python", "server.py"]
