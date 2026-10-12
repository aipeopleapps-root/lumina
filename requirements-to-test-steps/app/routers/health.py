from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health_check() -> dict[str, str]:
    """Liveness probe — returns ok when the app is running."""
    return {"status": "ok", "version": "1.0.0"}
