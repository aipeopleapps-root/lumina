"""Shared fixtures for the backend test suite."""

from __future__ import annotations

import json
import os
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

# common/__init__.py eagerly imports every submodule, including azure_ai.py,
# which reads these at module level (and constructs SDK client objects,
# though without making any network call until a method is actually invoked)
# — so importing anything from common, even just tenant.py, transitively
# requires them to exist. Dummy values are enough; no test in this suite
# calls out to a real Azure AI endpoint. Set via setdefault() so a real
# local .env-sourced value (if a developer has one exported) always wins.
os.environ.setdefault("EMBEDDING_MODEL_NAME", "text-embedding-3-large")
os.environ.setdefault("GENERATION_MODEL_NAME", "claude-haiku-4-5")
os.environ.setdefault("AZURE_AI_FOUNDRY_ENDPOINT", "https://test-foundry.example.com")
os.environ.setdefault("AZURE_OPENAI_ENDPOINT", "https://test-openai.example.com")


def make_event(
    *,
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | str | None = None,
    path_params: dict[str, str] | None = None,
    query: dict[str, str] | None = None,
    method: str = "GET",
    raw_path: str = "/",
) -> dict[str, Any]:
    """Build the same Lambda-style event shape common/http_adapter.py's
    event_from_request() produces, so tests construct events the same way
    the real Function App does."""
    if isinstance(body, dict):
        body = json.dumps(body)
    return {
        "headers": {k.lower(): v for k, v in (headers or {}).items()},
        "body": body,
        "queryStringParameters": query or None,
        "pathParameters": path_params or None,
        "rawPath": raw_path,
        "requestContext": {"http": {"method": method, "sourceIp": "127.0.0.1"}},
    }


@pytest.fixture
def event_factory():
    return make_event


@pytest.fixture
def consultant_headers():
    return {
        "x-tenant-id": "yellow-bank",
        "x-user-sub": "consultant-sub-1",
        "x-user-role": "consultant",
        "x-user-email": "consultant@example.com",
    }


@pytest.fixture
def super_admin_headers():
    return {
        "x-tenant-id": "platform",
        "x-user-sub": "admin-sub-1",
        "x-user-role": "super_admin",
        "x-user-email": "admin@example.com",
    }


# ── Shared AI/Cosmos/Postgres mocking pattern ──────────────────────────────────────────────
#
# One reusable approach per external dependency, so Process Intelligence / Test Automation
# Suite / Ask Stuey's test suites don't each reinvent mocking. See tests/test_azure_ai.py for
# the lowest-level pattern these build on (patch.object against the real module, not a
# reimplementation of its interface).


@pytest.fixture
def mock_ai():
    """Patches common.ai.generate/generate_json so no test calls a real AI endpoint.

    Usage: mock_ai.generate.return_value = "some text"
           mock_ai.generate_json.return_value = {"key": "value"}
    An un-mocked call returns a plain MagicMock rather than real text/JSON — that's
    deliberately obvious in a failing assertion (e.g. "hello" == <MagicMock ...>), so
    a test that forgets to configure one of these still fails clearly, just via the
    assertion rather than a dedicated guard (a guard here would need to special-case
    distinguishing "never configured" from "configured", which plain unittest.mock
    has no clean way to do once .side_effect is involved — simpler to lean on the
    assertion than fight that).
    """
    from common import ai

    with patch.object(ai, "generate") as gen, patch.object(ai, "generate_json") as gen_json:
        yield type("MockAi", (), {"generate": gen, "generate_json": gen_json})()


class FakeCosmosStore:
    """A minimal in-memory stand-in for common.vectors/common.industry_knowledge's
    container-backed operations — enough for tests that need put/get/query semantics
    without a real Cosmos account. Not a full emulator: query() does simple equality
    filtering over the stored items' top-level fields, which is what every current
    caller actually needs (see cosmos_vectors.py/industry_knowledge.py's own query
    shapes — tenant_id/doc_id/chunk_id-prefix filters, no joins or aggregates)."""

    def __init__(self):
        self.items: dict[str, dict[str, Any]] = {}

    def put(self, item: dict[str, Any]) -> None:
        self.items[item["id"]] = dict(item)

    def get(self, item_id: str) -> dict[str, Any] | None:
        return self.items.get(item_id)

    def query(self, **filters: Any) -> list[dict[str, Any]]:
        return [
            item for item in self.items.values()
            if all(item.get(k) == v for k, v in filters.items())
        ]

    def delete(self, item_id: str) -> None:
        self.items.pop(item_id, None)


@pytest.fixture
def fake_cosmos_store():
    return FakeCosmosStore()


@pytest.fixture
def fake_db_connection():
    """Patches common.db.get_connection() to yield a MagicMock shaped like the real
    Connection/Cursor pair (see db.py) — execute()/fetchone()/fetchall() are
    MagicMocks you configure per test, e.g.:
        fake_db_connection.cursor.return_value.__enter__.return_value.fetchone.return_value = (1, "x")
    Use this for pi_aurora.py/test_automation_store.py functions, which all go
    through common.db.get_connection() rather than touching psycopg2 directly.
    """
    from common import db

    fake_cursor = MagicMock()
    fake_cursor.__enter__.return_value = fake_cursor
    fake_cursor.__exit__.return_value = False
    fake_conn = MagicMock()
    fake_conn.cursor.return_value = fake_cursor

    from contextlib import contextmanager

    @contextmanager
    def _fake_get_connection():
        yield fake_conn

    with patch.object(db, "get_connection", _fake_get_connection):
        yield fake_conn
