FROM python:3.12-alpine

# git only. No docker socket, no network credentials, no model client — the
# whole point of this container is that repository write access lives in one
# place that can do nothing else.
# git-daemon is a SEPARATE alpine package from git, and `git daemon` is not a
# subcommand without it — the first build had only `git` and the daemon died
# with "not a git command" while the startup log cheerfully said it was
# serving. Both halves of that were fixed together.
RUN apk add --no-cache git git-daemon

WORKDIR /srv
COPY server.py .

EXPOSE 9912
CMD ["python", "server.py"]
