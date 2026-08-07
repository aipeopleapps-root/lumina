"""
Azure Blob Storage helper — mirrors the boto3 S3 client surface used across
the document-handling handlers (`put_object`, `get_object`, `delete_object`,
`generate_presigned_url` for both PUT and GET).

SAS URLs are signed with a user-delegation key (via `DefaultAzureCredential`),
not an account key — consistent with this migration's auth decision to avoid
managing shared secrets wherever Entra-based auth is available.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobSasPermissions, BlobServiceClient, generate_blob_sas

log = logging.getLogger(__name__)

_credential: DefaultAzureCredential | None = None
_service_client: BlobServiceClient | None = None

_UDK_SAFETY_MARGIN = timedelta(minutes=5)


def _account_url() -> str:
    return os.environ["AZURE_STORAGE_ACCOUNT_URL"]


def _container_name() -> str:
    return os.environ.get("DOCS_CONTAINER_NAME", "docs")


def _client() -> BlobServiceClient:
    global _credential, _service_client
    if _service_client is None:
        _credential = DefaultAzureCredential()
        _service_client = BlobServiceClient(_account_url(), credential=_credential)
    return _service_client


def _container():
    return _client().get_container_client(_container_name())


def put_object(key: str, data: bytes, content_type: str) -> None:
    from azure.storage.blob import ContentSettings

    _container().upload_blob(
        key, data, overwrite=True, content_settings=ContentSettings(content_type=content_type)
    )


def get_object_bytes(key: str) -> bytes:
    return _container().download_blob(key).readall()


def delete_object(key: str) -> None:
    _container().delete_blob(key)


def generate_upload_sas(key: str, content_type: str, expires_in: int = 3600) -> str:
    """SAS URL for a client-side PUT — equivalent to generate_presigned_url('put_object', ...)."""
    return _generate_sas(key, expires_in, BlobSasPermissions(write=True, create=True))


def generate_download_sas(key: str, expires_in: int = 3600) -> str:
    """SAS URL for a client-side GET — equivalent to generate_presigned_url('get_object', ...)."""
    return _generate_sas(key, expires_in, BlobSasPermissions(read=True))


def _generate_sas(key: str, expires_in: int, permission: BlobSasPermissions) -> str:
    now = datetime.now(timezone.utc)
    expiry = now + timedelta(seconds=expires_in)
    service = _client()
    udk = service.get_user_delegation_key(
        key_start_time=now - _UDK_SAFETY_MARGIN,
        key_expiry_time=expiry + _UDK_SAFETY_MARGIN,
    )
    sas_token = generate_blob_sas(
        account_name=service.account_name,
        container_name=_container_name(),
        blob_name=key,
        user_delegation_key=udk,
        permission=permission,
        expiry=expiry,
    )
    return f"{_account_url()}/{_container_name()}/{key}?{sas_token}"
