FROM python:3.12-slim

WORKDIR /app/backend

# tesseract-ocr + poppler-utils are the LOCAL half of reading a document that
# has no text layer: a scanned PDF or a photographed letter. They stay in the
# image rather than in a sidecar because they take bytes the operator already
# handed us and make no network call of their own — the property that decides
# where extraction lives (see doc_extract.py). eng only; more languages are
# `tesseract-ocr-<lang>` and a settings change away.
# THE POSTGRES CLIENT MUST MATCH THE SERVER, and `postgresql-client` does not
# mean that — it means "whatever Debian ships", which on trixie is 17 while
# docker-compose.yml pins postgres:16-alpine. That mismatch broke disaster
# recovery outright and silently: pg_dump 17 writes `SET transaction_timeout
# = 0;` into every dump's header, PG16 has no such parameter, and pg_restore
# stops on it. Measured 2026-08-05 against the newest bundle:
#
#   pg_restore: error: could not execute query: ERROR:  unrecognized
#   configuration parameter "transaction_timeout"
#
# Every bundle on the install was unrestorable — a second, independent reason
# on top of the migration-ledger one that migration 087's tombstone records.
# Both were invisible because nothing ever restored a bundle: the backups were
# green, verified their own checksums, and could not be put back.
#
# Debian trixie carries only 17, so the version comes from PGDG. It is a build
# ARG rather than a literal so it has ONE source of truth with the compose
# file, and tests/test_pg_client_version.py fails if the two ever disagree —
# the day someone bumps the server image, the build that would have gone on
# producing unrestorable dumps goes red instead.
ARG PG_MAJOR=16
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl git tesseract-ocr poppler-utils ca-certificates gnupg \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
         -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt trixie-pgdg main" \
         > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}" \
    && apt-get purge -y gnupg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml .
RUN pip install --no-cache-dir -e .

# The application itself. It used to be absent: only pyproject.toml was
# copied, so the image held the dependencies and none of the code, and every
# container was really running the ./backend bind mount from docker-compose.
# That works exactly once — on this machine. The bind mount still shadows
# this in dev, so nothing changes day to day; the difference is that the
# image can now stand on its own.
COPY app ./app

EXPOSE 8000

# No --reload here. uvicorn's reloader is a dev tool (an extra watcher
# process, a restart on any file touch, no worker management) and it was the
# production entrypoint because it was the only entrypoint. docker-compose
# adds it back for the dev container, which is where it belongs.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
