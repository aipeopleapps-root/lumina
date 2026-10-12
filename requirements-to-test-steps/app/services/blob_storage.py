from __future__ import annotations

import logging

from azure.identity.aio import DefaultAzureCredential
from azure.storage.blob.aio import BlobServiceClient

from app.config import Settings

logger = logging.getLogger(__name__)


def _get_blob_service_client(settings: Settings) -> BlobServiceClient:
    """Return an async BlobServiceClient using managed identity or connection string."""
    if settings.USE_MANAGED_IDENTITY:
        credential = DefaultAzureCredential()
        return BlobServiceClient(
            account_url=settings.AZURE_STORAGE_ACCOUNT_URL,
            credential=credential,
        )
    if not settings.AZURE_STORAGE_CONNECTION_STRING:
        raise RuntimeError(
            "USE_MANAGED_IDENTITY is False but AZURE_STORAGE_CONNECTION_STRING is not set."
        )
    return BlobServiceClient.from_connection_string(
        settings.AZURE_STORAGE_CONNECTION_STRING
    )


async def upload_bytes(
    data: bytes,
    blob_name: str,
    container: str,
    settings: Settings,
) -> str:
    """Upload bytes to Azure Blob Storage and return the blob URL."""
    client = _get_blob_service_client(settings)
    async with client:
        blob_client = client.get_blob_client(container=container, blob=blob_name)
        await blob_client.upload_blob(data, overwrite=True)
        url = blob_client.url
        logger.info("Uploaded blob '%s' to container '%s' (%d bytes)", blob_name, container, len(data))
        return url


async def download_bytes(
    blob_name: str,
    container: str,
    settings: Settings,
) -> bytes:
    """Download bytes from Azure Blob Storage."""
    client = _get_blob_service_client(settings)
    async with client:
        blob_client = client.get_blob_client(container=container, blob=blob_name)
        stream = await blob_client.download_blob()
        data: bytes = await stream.readall()
        logger.info("Downloaded blob '%s' from container '%s' (%d bytes)", blob_name, container, len(data))
        return data
