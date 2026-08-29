FROM python:3.12-slim

RUN pip install --no-cache-dir uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY app ./app
COPY migrations ./migrations

RUN useradd --create-home --uid 1000 appuser && chown -R appuser /app

# WORKSPACE_ROOT's mount point has to exist in the image, owned by the user
# the process runs as. Docker initialises an empty named volume from the
# image path it is mounted over — ownership included — so without this the
# v4_workspace volume arrives root-owned and the very first
# workspace_write_file fails with a permission error the model can do
# nothing about. Exactly the failure the memory service hit on the first
# real install (see services/memory/Dockerfile).
RUN mkdir -p /data/workspace && chown -R appuser /data

USER appuser

ENV PATH="/app/.venv/bin:${PATH}"
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
