# voice-gateway/app/main.py
from fastapi import FastAPI
from nova_contracts import HealthStatus

app = FastAPI(title="voice-gateway", version="2.0.0")


@app.get("/health/live")
async def live():
    return {"status": "ok"}


@app.get("/health/ready")
async def ready():
    return HealthStatus(status="ok", service="voice-gateway")
