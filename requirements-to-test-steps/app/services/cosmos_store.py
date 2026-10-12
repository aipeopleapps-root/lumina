from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

from azure.cosmos import PartitionKey
from azure.cosmos.aio import CosmosClient

from app.config import Settings

logger = logging.getLogger(__name__)


# ── Run naming helpers ────────────────────────────────────────────────────────

def _safe(s: str) -> str:
    """Strip a string to alphanumeric + underscores, suitable for filenames."""
    return re.sub(r'[^a-zA-Z0-9]+', '_', s.strip()).strip('_')


def make_run_name(workstream: str, wave: str, input_type: str) -> str:
    """Human-readable display name, e.g. 'HCM · Wave 1 · Requirements · 05 Aug 2026 14:32'."""
    now = datetime.now()  # local time for display
    parts = [p.strip() for p in [workstream, wave] if p.strip()]
    parts.append(input_type.replace('_', ' ').title())
    parts.append(now.strftime('%d %b %Y %H:%M'))
    return ' · '.join(parts)


def make_file_name(workstream: str, wave: str, input_type: str) -> str:
    """Filesystem-safe filename, e.g. 'HCM_Wave_1_Requirements_2026-08-05_14-32.xlsx'."""
    now = datetime.now()  # local time for display
    parts = [_safe(p) for p in [workstream, wave] if p.strip()]
    parts.append(_safe(input_type))
    parts.append(now.strftime('%Y-%m-%d_%H-%M'))
    return '_'.join(filter(None, parts)) + '.xlsx'


def _make_client(settings: Settings) -> CosmosClient:
    """Return an async CosmosClient using key auth or Managed Identity."""
    if settings.COSMOS_USE_MANAGED_IDENTITY:
        from azure.identity.aio import DefaultAzureCredential
        return CosmosClient(settings.COSMOS_ENDPOINT, credential=DefaultAzureCredential())
    return CosmosClient(settings.COSMOS_ENDPOINT, credential=settings.COSMOS_KEY)


async def initialise_cosmos(settings: Settings) -> None:
    """
    Create the database and container if they do not already exist.
    Called once at application startup — no manual portal setup required.
    """
    try:
        async with _make_client(settings) as client:
            db = await client.create_database_if_not_exists(
                id=settings.COSMOS_DATABASE_NAME
            )
            await db.create_container_if_not_exists(
                id=settings.COSMOS_CONTAINER_NAME,
                partition_key=PartitionKey(path="/project_id"),
            )
            logger.info(
                "Cosmos ready — database: %s  container: %s",
                settings.COSMOS_DATABASE_NAME,
                settings.COSMOS_CONTAINER_NAME,
            )
    except Exception as exc:
        # Log but do not crash — app works without Cosmos
        logger.warning("Cosmos initialisation failed (app continues without persistence): %s", exc)


async def save_run(document: dict[str, Any], settings: Settings) -> None:
    """
    Upsert a pipeline run document into Cosmos.
    Failures are logged but never propagate — the export still completes.
    """
    try:
        async with _make_client(settings) as client:
            container = (
                client
                .get_database_client(settings.COSMOS_DATABASE_NAME)
                .get_container_client(settings.COSMOS_CONTAINER_NAME)
            )
            await container.upsert_item(document)
            logger.info(
                "Cosmos run saved — id: %s  project: %s  workstream: %s",
                document.get("id"),
                document.get("project_id"),
                document.get("workstream", "—"),
            )
    except Exception as exc:
        logger.warning("Cosmos save_run failed (run still exported): %s", exc)


async def get_project_runs(
    project_id: str,
    user_id: str,
    settings: Settings,
    limit: int = 20,
) -> list[dict]:
    """
    Return the most recent runs for a project, newest first.
    Returns an empty list on any error so the UI degrades gracefully.
    """
    try:
        async with _make_client(settings) as client:
            container = (
                client
                .get_database_client(settings.COSMOS_DATABASE_NAME)
                .get_container_client(settings.COSMOS_CONTAINER_NAME)
            )
            query = (
                "SELECT c.run_id, c.run_name, c.file_name, c.created_at, "
                "c.input_type, c.input_filename, c.workstream, c.wave, c.status, "
                "c.requirements_count, c.test_scenarios_count, c.test_steps_count, "
                "c.output_blob_url "
                "FROM c WHERE c.project_id = @pid AND c.user_id = @uid "
                "ORDER BY c.created_at DESC OFFSET 0 LIMIT @lim"
            )
            params: list[dict] = [
                {"name": "@pid", "value": project_id},
                {"name": "@uid", "value": user_id},
                {"name": "@lim", "value": limit},
            ]
            runs: list[dict] = []
            async for item in container.query_items(
                query=query,
                parameters=params,
                partition_key=project_id,
            ):
                runs.append(item)
            return runs
    except Exception as exc:
        logger.warning("Cosmos get_project_runs failed: %s", exc)
        return []


def build_run_document(
    run_id: str,
    project_id: str,
    input_type: str,
    filename: str,
    workstream: str,
    wave: str,
    requirements_count: int,
    test_scenarios_count: int,
    test_steps_count: int,
    output_blob_url: str | None,
    run_name: str = "",
    file_name: str = "",
    user_id: str = "",
) -> dict[str, Any]:
    """Construct the Cosmos document for a completed pipeline run."""
    return {
        "id": run_id,                          # Cosmos document id
        "project_id": project_id,              # partition key
        "run_id": run_id,
        "run_name": run_name or make_run_name(workstream, wave, input_type),
        "file_name": file_name or make_file_name(workstream, wave, input_type),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "input_type": input_type,
        "input_filename": filename,
        "workstream": workstream or "",
        "wave": wave or "",
        "status": "completed",
        "requirements_count": requirements_count,
        "test_scenarios_count": test_scenarios_count,
        "test_steps_count": test_steps_count,
        "output_blob_url": output_blob_url,
        "user_id": user_id,
    }
