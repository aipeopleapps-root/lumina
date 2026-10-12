"""
common/http_adapter.py is the boundary between Azure's HttpRequest/HttpResponse
shape and the Lambda-style event/response dict every ported handler still
speaks. If this translation drifts, every one of the 71 routes breaks at
once — it's worth pinning directly rather than only indirectly via handler
tests.
"""

from __future__ import annotations

import json

from common.http_adapter import event_from_request, invoke, response_from_result


class FakeHttpRequest:
    """Duck-typed stand-in for azure.functions.HttpRequest — event_from_request()
    only touches the attributes/methods below, so a real HttpRequest isn't needed."""

    def __init__(self, *, method="GET", url="https://example.com/manage/list-users",
                 headers=None, params=None, route_params=None, body=b""):
        self.method = method
        self.url = url
        self.headers = headers or {}
        self.params = params or {}
        self.route_params = route_params or {}
        self._body = body

    def get_body(self):
        return self._body


class TestEventFromRequest:
    def test_lowercases_header_names(self):
        req = FakeHttpRequest(headers={"X-Tenant-Id": "acme", "Authorization": "Bearer x"})
        event = event_from_request(req)
        assert event["headers"] == {"x-tenant-id": "acme", "authorization": "Bearer x"}

    def test_decodes_body_when_present(self):
        req = FakeHttpRequest(body=b'{"foo": "bar"}')
        event = event_from_request(req)
        assert event["body"] == '{"foo": "bar"}'

    def test_body_is_none_when_empty(self):
        req = FakeHttpRequest(body=b"")
        event = event_from_request(req)
        assert event["body"] is None

    def test_raw_path_from_url(self):
        req = FakeHttpRequest(url="https://lumina-func.azurewebsites.net/manage/list-users?x=1")
        event = event_from_request(req)
        assert event["rawPath"] == "/manage/list-users"

    def test_path_and_query_params(self):
        req = FakeHttpRequest(params={"tenant_id": "acme"}, route_params={"run_id": "r1"})
        event = event_from_request(req)
        assert event["queryStringParameters"] == {"tenant_id": "acme"}
        assert event["pathParameters"] == {"run_id": "r1"}

    def test_empty_params_become_none_not_empty_dict(self):
        req = FakeHttpRequest()
        event = event_from_request(req)
        assert event["queryStringParameters"] is None
        assert event["pathParameters"] is None

    def test_method_threaded_through(self):
        req = FakeHttpRequest(method="POST")
        event = event_from_request(req)
        assert event["requestContext"]["http"]["method"] == "POST"


class TestInvoke:
    def test_success_path_translates_response(self):
        def handler(event, context):
            return {"statusCode": 200, "headers": {}, "body": json.dumps({"ok": True})}

        resp = invoke(handler, FakeHttpRequest())
        assert resp.status_code == 200
        assert json.loads(resp.get_body()) == {"ok": True}

    def test_unhandled_exception_becomes_clean_500(self):
        def handler(event, context):
            raise RuntimeError("boom — secret connection string leaked here")

        resp = invoke(handler, FakeHttpRequest())
        assert resp.status_code == 500
        body = resp.get_body().decode()
        assert "internal server error" in body
        # The real exception text must never leak into the HTTP response body.
        assert "secret connection string" not in body

    def test_response_from_result_defaults_status_200(self):
        resp = response_from_result({"body": "{}"})
        assert resp.status_code == 200
