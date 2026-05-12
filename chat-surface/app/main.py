# chat-surface/app/main.py
from fastapi import FastAPI
from nova_contracts import HealthStatus

app = FastAPI(title="chat-surface", version="2.0.0")


@app.get("/health/live")
async def live():
    return {"status": "ok"}


@app.get("/health/ready")
async def ready():
    return HealthStatus(status="ok", service="chat-surface")
