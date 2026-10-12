"""Proves conftest.py's shared mock_ai / fake_cosmos_store / fake_db_connection fixtures
actually work before later phases (Process Intelligence, Test Automation Suite, Ask Stuey)
build real test suites on top of them. Not testing product logic — testing the test
infrastructure itself.
"""

from __future__ import annotations

import pytest

from common import ai, db


class TestMockAi:
    def test_generate_returns_configured_value(self, mock_ai):
        mock_ai.generate.return_value = "hello"
        assert ai.generate("sys", [{"role": "user", "content": "hi"}]) == "hello"

    def test_generate_json_returns_configured_value(self, mock_ai):
        mock_ai.generate_json.return_value = {"ok": True}
        assert ai.generate_json("sys", "prompt") == {"ok": True}

    def test_unconfigured_call_returns_a_mock_not_a_real_value(self, mock_ai):
        # Deliberately not a real string/dict — see mock_ai's docstring for why this
        # is the intended fallback rather than a raised error.
        from unittest.mock import MagicMock

        assert isinstance(ai.generate("sys", []), MagicMock)


class TestFakeCosmosStore:
    def test_put_and_get(self, fake_cosmos_store):
        fake_cosmos_store.put({"id": "a1", "tenant_id": "t1", "text": "hello"})
        assert fake_cosmos_store.get("a1")["text"] == "hello"

    def test_query_filters_by_field(self, fake_cosmos_store):
        fake_cosmos_store.put({"id": "a1", "tenant_id": "t1"})
        fake_cosmos_store.put({"id": "a2", "tenant_id": "t2"})
        results = fake_cosmos_store.query(tenant_id="t1")
        assert [r["id"] for r in results] == ["a1"]

    def test_delete(self, fake_cosmos_store):
        fake_cosmos_store.put({"id": "a1"})
        fake_cosmos_store.delete("a1")
        assert fake_cosmos_store.get("a1") is None


class TestFakeDbConnection:
    def test_configured_fetchone_is_returned(self, fake_db_connection):
        fake_db_connection.cursor.return_value.fetchone.return_value = (1, "yellow-bank")
        with db.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                row = cur.fetchone()
        assert row == (1, "yellow-bank")

    def test_configured_fetchall_is_returned(self, fake_db_connection):
        fake_db_connection.cursor.return_value.fetchall.return_value = [(1,), (2,)]
        with db.get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                rows = cur.fetchall()
        assert rows == [(1,), (2,)]
