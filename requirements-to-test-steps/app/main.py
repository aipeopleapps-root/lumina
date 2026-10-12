from __future__ import annotations

import logging
import logging.config
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.routers.auth import router as auth_router
from app.routers.health import router as health_router
from app.routers.pipeline import router as pipeline_router
from app.routers.stages import router as stages_router

_LOG_FORMAT = "%(asctime)s %(levelname)-8s %(name)s — %(message)s"
logging.basicConfig(level=logging.INFO, format=_LOG_FORMAT)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    settings = get_settings()
    if settings.USE_COSMOS:
        from app.services.cosmos_store import initialise_cosmos
        await initialise_cosmos(settings)
    else:
        logger.info("Cosmos persistence disabled (USE_COSMOS=false)")
    yield


app = FastAPI(
    title="Requirements to Test Steps",
    description=(
        "Reads user requirements from an uploaded Excel file, runs them through "
        "three AI agents (user stories → test scenarios → test steps), and returns "
        "a formatted output Excel file stored in Azure Blob Storage."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

app.mount("/static", StaticFiles(directory="app/static"), name="static")

app.include_router(health_router, tags=["health"])
app.include_router(pipeline_router, tags=["pipeline"])
app.include_router(stages_router, tags=["interactive-pipeline"])
app.include_router(auth_router, tags=["auth"])


@app.get("/", include_in_schema=False)
async def serve_ui() -> FileResponse:
    return FileResponse("app/static/index.html")


