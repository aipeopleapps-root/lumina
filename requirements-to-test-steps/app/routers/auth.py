from __future__ import annotations

from fastapi import APIRouter, Depends

from app.config import Settings, get_settings

router = APIRouter(prefix="/api/auth")


@router.get("/config")
async def get_auth_config(settings: Settings = Depends(get_settings)) -> dict:
    """Return auth configuration for the frontend to initialise MSAL."""
    enabled = bool(settings.AZURE_AD_CLIENT_ID)
    return {
        "auth_enabled": enabled,
        "client_id": settings.AZURE_AD_CLIENT_ID if enabled else "",
        "tenant_name": settings.AZURE_AD_TENANT_NAME if enabled else "",
        "authority": (
            f"https://{settings.AZURE_AD_TENANT_NAME}.ciamlogin.com/"
            f"{settings.AZURE_AD_TENANT_NAME}.onmicrosoft.com"
            if enabled else ""
        ),
    }
