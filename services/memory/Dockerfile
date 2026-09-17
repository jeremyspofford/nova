FROM python:3.12-slim

RUN pip install --no-cache-dir uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY app ./app
COPY migrations ./migrations

RUN useradd --create-home --uid 1000 appuser && chown -R appuser /app

# MEMORY_ROOT's mount point has to exist in the image, owned by the user the
# process runs as. Docker initialises an empty named volume from the image
# path it is mounted over — including its ownership — so without this the
# v4_memdata volume arrives root-owned and the service dies on its very first
# boot with "PermissionError: '/data/memory/people'", before it has written a
# single file. (Found by the first real install, 2026-08-28.)
RUN mkdir -p /data/memory && chown -R appuser /data

USER appuser

ENV PATH="/app/.venv/bin:${PATH}"
EXPOSE 8002
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8002"]
