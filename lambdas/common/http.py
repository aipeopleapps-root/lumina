"""HTTP response shaping for API Gateway v2."""

from __future__ import annotations

import json
from typing import Any

_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
}


def ok(body: Any) -> dict[str, Any]:
    return {"statusCode": 200, "headers": _HEADERS, "body": json.dumps(body)}


def bad_request(message: str) -> dict[str, Any]:
    return {"statusCode": 400, "headers": _HEADERS, "body": json.dumps({"error": message})}


def forbidden(message: str = "forbidden") -> dict[str, Any]:
    return {"statusCode": 403, "headers": _HEADERS, "body": json.dumps({"error": message})}


def server_error(message: str = "internal error") -> dict[str, Any]:
    return {"statusCode": 500, "headers": _HEADERS, "body": json.dumps({"error": message})}
