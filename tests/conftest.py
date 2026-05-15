# Integration tests hit real running services. No mocks.
# Start services before running: docker compose up -d
import os

from dotenv import load_dotenv

# Load .env from the repo root so NOVA_ADMIN_SECRET and other vars are available.
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

ADMIN_SECRET: str = os.getenv("NOVA_ADMIN_SECRET", "nova-dev-secret")

# Service URLs — override via env vars when running against non-default ports.
ORCHESTRATOR_URL: str = os.getenv("NOVA_ORCHESTRATOR_URL", "http://localhost:8000")
CHAT_API_URL: str = os.getenv("NOVA_CHAT_API_URL", "http://localhost:8004")
MEMORY_URL: str = os.getenv("NOVA_MEMORY_URL", "http://localhost:8002")
LLM_GATEWAY_URL: str = os.getenv("NOVA_LLM_GATEWAY_URL", "http://localhost:8001")
