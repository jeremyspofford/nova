FROM python:3.12-alpine

# git only. No docker socket, no network credentials, no model client — the
# whole point of this container is that repository write access lives in one
# place that can do nothing else.
RUN apk add --no-cache git

WORKDIR /srv
COPY server.py .

EXPOSE 9912
CMD ["python", "server.py"]
