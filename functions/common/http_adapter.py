"""
Azure Functions HTTP trigger <-> Lambda-style event/response adapter.

Every ported handler under `functions/<name>/handler.py` still speaks the AWS
API Gateway v2 (HTTP API) event/response shape it was written against in
Phase 6 — `event["headers"]`, `event.get("body")`, `event.get("pathParameters")`,
`event.get("queryStringParameters")`, `event["requestContext"]["http"]["method"]`,
`event.get("rawPath")` — and returns `{"statusCode", "headers", "body"}`. Rather
than rewrite 37 handlers against `azure.functions.HttpRequest`/`HttpResponse`,
`function_app.py` (the actual Function App entry point, wired in Phase 7)
uses this module to translate in both directions at the boundary.

`host.json` sets `extensions.http.routePrefix` to `""` so Function App URLs
have no `/api` prefix — `req.url`'s path then matches the original AWS
`rawPath` values byte-for-byte (this matters: `pi_graph.handler` branches on
`rawPath.endswith(...)` and `mfa_reset_request.handler` branches on
`"/manage/" in path`, unchanged from Phase 6 apart from the `admin` → `manage`
route-prefix rename — see `function_app.py`'s module docstring for why).
"""

from __future__ import annotations

import logging
from typing import Any, Callable
from urllib.parse import urlparse

import azure.functions as func

log = logging.getLogger(__name__)

LambdaHandler = Callable[[dict[str, Any], Any], dict[str, Any]]


def event_from_request(req: func.HttpRequest) -> dict[str, Any]:
    try:
        body_bytes = req.get_body()
    except ValueError:
        body_bytes = b""

    source_ip = (req.headers.get("x-forwarded-for") or "unknown").split(",")[0].strip()

    return {
        "headers": {k.lower(): v for k, v in req.headers.items()},
        "body": body_bytes.decode("utf-8") if body_bytes else None,
        "queryStringParameters": dict(req.params) or None,
        "pathParameters": dict(req.route_params) or None,
        "rawPath": urlparse(req.url).path,
        "requestContext": {
            "http": {
                "method": req.method,
                "sourceIp": source_ip,
            }
        },
    }


def response_from_result(result: dict[str, Any]) -> func.HttpResponse:
    return func.HttpResponse(
        body=result.get("body") or "",
        status_code=result.get("statusCode", 200),
        headers=result.get("headers") or {},
        mimetype="application/json",
    )


def invoke(handler: LambdaHandler, req: func.HttpRequest) -> func.HttpResponse:
    """Run a ported Lambda-style handler against a real Azure HTTP trigger request."""
    event = event_from_request(req)
    try:
        result = handler(event, None)
    except Exception:
        log.exception("unhandled error in %s", getattr(handler, "__module__", handler))
        return func.HttpResponse(
            '{"error": "internal server error"}',
            status_code=500,
            mimetype="application/json",
        )
    return response_from_result(result)
