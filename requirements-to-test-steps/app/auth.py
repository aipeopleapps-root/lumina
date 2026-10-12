from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from app.config import Settings, get_settings

logger = logging.getLogger(__name__)

_bearer = HTTPBearer(auto_error=False)
_jwks_cache: dict[str, Any] = {"jwks": {}, "issuer": "", "fetched_at": 0.0}
_JWKS_TTL = 3600.0


@dataclass
class AuthUser:
    user_id: str
    email: str
    name: str


async def _get_oidc_config(settings: Settings) -> tuple[dict, str]:
    """Return (jwks_dict, issuer) fetched from the OIDC discovery document.

    jwks_dict has the shape {"keys": [...]} that python-jose expects.
    issuer is read directly from the discovery document so it always matches
    the exact string present in tokens.
    """
    now = time.time()
    if _jwks_cache["jwks"] and now - _jwks_cache["fetched_at"] < _JWKS_TTL:
        return _jwks_cache["jwks"], _jwks_cache["issuer"]

    discovery_url = (
        f"https://{settings.AZURE_AD_TENANT_NAME}.ciamlogin.com/"
        f"{settings.AZURE_AD_TENANT_NAME}.onmicrosoft.com"
        f"/v2.0/.well-known/openid-configuration"
    )
    async with httpx.AsyncClient(timeout=10) as client:
        disc = await client.get(discovery_url)
        disc.raise_for_status()
        disc_data = disc.json()
        issuer = disc_data["issuer"]
        jwks_uri = disc_data["jwks_uri"]
        jwks_resp = await client.get(jwks_uri)
        jwks_resp.raise_for_status()
        # python-jose expects {"keys": [...]} — never pass the list directly
        jwks = jwks_resp.json()  # already {"keys": [...]}

    _jwks_cache["jwks"] = jwks
    _jwks_cache["issuer"] = issuer
    _jwks_cache["fetched_at"] = now
    logger.info("OIDC config refreshed — issuer: %s  keys: %d", issuer, len(jwks.get("keys", [])))
    return jwks, issuer


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    settings: Settings = Depends(get_settings),
) -> AuthUser:
    # Auth disabled (no client ID configured) — return local dev user
    if not settings.AZURE_AD_CLIENT_ID:
        return AuthUser(user_id="local-dev", email="dev@local", name="Local Dev")

    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = credentials.credentials
    try:
        jwks, issuer = await _get_oidc_config(settings)

        # Log unverified claims so mismatches appear in server logs
        try:
            unverified = jwt.get_unverified_claims(token)
            logger.debug(
                "Token claims — iss: %s  aud: %s  exp: %s",
                unverified.get("iss"), unverified.get("aud"), unverified.get("exp"),
            )
            logger.debug("Expected — issuer: %s  audience: %s", issuer, settings.AZURE_AD_CLIENT_ID)
        except Exception:
            pass

        payload = jwt.decode(
            token,
            jwks,
            algorithms=["RS256"],
            audience=settings.AZURE_AD_CLIENT_ID,
            issuer=issuer,
            options={"verify_at_hash": False},
        )
        oid = payload.get("oid") or payload.get("sub", "")
        email = payload.get("email") or payload.get("preferred_username") or ""
        name = payload.get("name") or email or "User"
        if not oid:
            raise ValueError("No user identifier in token")
        return AuthUser(user_id=oid, email=email, name=name)
    except JWTError as exc:
        logger.warning("JWT validation failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("Auth error: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication failed",
            headers={"WWW-Authenticate": "Bearer"},
        )
