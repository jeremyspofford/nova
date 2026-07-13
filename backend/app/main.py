"""Nova backend - FastAPI app."""

from contextlib import asynccontextmanager
import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import db
from app.config import settings

log = logging.getLogger(__name__)
logging.basicConfig(level=settings.LOG_LEVEL)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown logic."""
    # Startup
    log.info("Starting Nova backend...")
    await db.init_pool()
    await db.run_migrations()
    log.info("Backend ready")
    yield
    # Shutdown
    log.info("Shutting down...")
    await db.close_pool()


app = FastAPI(title="Nova Backend", lifespan=lifespan)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "db": "ok"}


@app.get("/")
async def root():
    """Root endpoint."""
    return {"message": "Nova Backend"}
