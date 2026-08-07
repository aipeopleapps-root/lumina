"""
Generic key-value CRUD over the Cosmos `config` container (partition key /pk).

Mirrors the ConfigTable pk/sk composite-key shape almost every handler already
calls against directly via boto3 (`table.get_item(Key={"pk": ..., "sk": ...})`,
`table.put_item(...)`, `table.query(KeyConditionExpression=Key("pk").eq(...))`,
`table.scan(FilterExpression=Attr("pk").begins_with(...))`). Item `id` == `sk`
within a `pk` partition, so most call sites port over by swapping the boto3
Table call for the matching function here.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from azure.cosmos import CosmosClient, exceptions
from azure.identity import DefaultAzureCredential

log = logging.getLogger(__name__)

_client: CosmosClient | None = None


def _container():
    global _client
    if _client is None:
        endpoint = os.environ["COSMOS_ENDPOINT"]
        _client = CosmosClient(endpoint, credential=DefaultAzureCredential())
    database = _client.get_database_client(os.environ.get("COSMOS_DATABASE", "lumina"))
    return database.get_container_client(os.environ.get("CONFIG_CONTAINER_NAME", "config"))


def get_item(pk: str, sk: str) -> dict[str, Any] | None:
    """Point read. Returns None if missing (mirrors DynamoDB get_item's absent 'Item')."""
    try:
        return _container().read_item(item=sk, partition_key=pk)
    except exceptions.CosmosResourceNotFoundError:
        return None


def put_item(item: dict[str, Any]) -> None:
    """Item must include 'pk' and 'sk'; 'id' defaults to 'sk' if not already set."""
    item.setdefault("id", item["sk"])
    _container().upsert_item(item)


def create_item(item: dict[str, Any]) -> None:
    """
    Create-only; raises FileExistsError if pk+sk already exists. Mirrors DynamoDB's
    `ConditionExpression="attribute_not_exists(pk)"` used for e.g. tenant creation,
    where Cosmos's upsert-only put_item would silently overwrite instead of rejecting.
    """
    item.setdefault("id", item["sk"])
    try:
        _container().create_item(item)
    except exceptions.CosmosResourceExistsError as exc:
        raise FileExistsError(f"item pk={item['pk']!r} sk={item['sk']!r} already exists") from exc


def update_item(pk: str, sk: str, updates: dict[str, Any]) -> None:
    """
    Partial update via read-modify-write. Cosmos's patch_item API requires
    knowing in advance whether each field already exists (replace vs. add),
    which none of the ported handlers need to care about — records here are
    small, low-volume admin/config data, so the extra round trip is a non-issue.
    """
    item = get_item(pk, sk)
    if item is None:
        raise KeyError(f"no item pk={pk!r} sk={sk!r}")
    item.update(updates)
    _container().upsert_item(item)


def delete_item(pk: str, sk: str) -> None:
    try:
        _container().delete_item(item=sk, partition_key=pk)
    except exceptions.CosmosResourceNotFoundError:
        pass


def query_by_pk(pk: str, sk_prefix: str | None = None) -> list[dict[str, Any]]:
    """All items in one partition, optionally filtered by sk prefix."""
    query = "SELECT * FROM c WHERE c.pk = @pk"
    parameters: list[dict[str, Any]] = [{"name": "@pk", "value": pk}]
    if sk_prefix:
        query += " AND STARTSWITH(c.sk, @sk_prefix)"
        parameters.append({"name": "@sk_prefix", "value": sk_prefix})
    return list(_container().query_items(query, parameters=parameters, partition_key=pk))


def scan_prefix(pk_prefix: str, sk_prefix: str | None = None) -> list[dict[str, Any]]:
    """
    Cross-partition scan for admin listing operations (e.g. all TENANT# or
    ASSIGN# items). Cosmos has no index-free scan equivalent — this runs a
    server-side filtered query across all partitions instead.
    """
    query = "SELECT * FROM c WHERE STARTSWITH(c.pk, @pk_prefix)"
    parameters: list[dict[str, Any]] = [{"name": "@pk_prefix", "value": pk_prefix}]
    if sk_prefix:
        query += " AND STARTSWITH(c.sk, @sk_prefix)"
        parameters.append({"name": "@sk_prefix", "value": sk_prefix})
    return list(_container().query_items(
        query, parameters=parameters, enable_cross_partition_query=True
    ))
