"""Top-level conftest: set required env vars for unit tests that import app.config."""
import os

# Provide dummy values so Settings() doesn't fail at import time.
# Tests that need a real DB use the running services (make test).
os.environ.setdefault("DATABASE_URL", "postgresql://nova:nova@localhost:5432/nova")
os.environ.setdefault("ADMIN_SECRET", "test-secret")
