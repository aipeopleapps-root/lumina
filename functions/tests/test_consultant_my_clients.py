"""
consultant_my_clients/handler.py — worked example for this test suite: how
to test a full handler by mocking the common/ boundary (config.query_by_pk /
config.get_item) directly, the same way every other handler test in this
repo should, rather than mocking the underlying Cosmos SDK client.
"""

from __future__ import annotations

import json

import consultant_my_clients.handler as handler


def _event(headers):
    return {
        "headers": headers,
        "body": None,
        "queryStringParameters": None,
        "pathParameters": None,
        "rawPath": "/consultant/my-clients",
        "requestContext": {"http": {"method": "GET", "sourceIp": "127.0.0.1"}},
    }


def test_returns_only_assigned_non_archived_clients(mocker, consultant_headers):
    mocker.patch.object(handler.config, "query_by_pk", return_value=[
        {"sk": "CLIENT#acme", "client_name": "Acme Corp", "industry": "Retail"},
        {"sk": "CLIENT#yellow-bank", "client_name": "Yellow Bank", "industry": "Finance"},
    ])

    def fake_get_item(pk, sk):
        tenants = {
            "TENANT#acme": {"status": "active"},
            "TENANT#yellow-bank": {"status": "archived"},
        }
        return tenants.get(pk)

    mocker.patch.object(handler.config, "get_item", side_effect=fake_get_item)

    result = handler.handler(_event(consultant_headers), None)

    assert result["statusCode"] == 200
    clients = json.loads(result["body"])["clients"]
    assert [c["tenant_id"] for c in clients] == ["acme"]
    assert clients[0]["name"] == "Acme Corp"


def test_excludes_client_with_no_tenant_metadata(mocker, consultant_headers):
    mocker.patch.object(handler.config, "query_by_pk", return_value=[
        {"sk": "CLIENT#ghost-tenant", "client_name": "Ghost", "industry": ""},
    ])
    mocker.patch.object(handler.config, "get_item", return_value=None)

    result = handler.handler(_event(consultant_headers), None)

    assert json.loads(result["body"])["clients"] == []


def test_empty_assignment_list_returns_empty_clients(mocker, consultant_headers):
    mocker.patch.object(handler.config, "query_by_pk", return_value=[])
    spy = mocker.patch.object(handler.config, "get_item")

    result = handler.handler(_event(consultant_headers), None)

    assert json.loads(result["body"])["clients"] == []
    spy.assert_not_called()


def test_non_consultant_role_is_forbidden(mocker, super_admin_headers):
    spy = mocker.patch.object(handler.config, "query_by_pk")

    result = handler.handler(_event(super_admin_headers), None)

    assert result["statusCode"] == 403
    spy.assert_not_called()
