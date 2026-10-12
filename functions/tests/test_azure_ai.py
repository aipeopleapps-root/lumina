"""Tests for common/azure_ai.py's generate() retry behaviour.

Mocks requests.post (and time.sleep, so retry-delay tests run instantly) rather than
hitting a real Azure AI Foundry endpoint — no test in this suite calls out to a real
service (see conftest.py's module-level env var comment).
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
import requests

from common import azure_ai


def _resp(status_code: int, text_content: str = "ok", reason: str = "error") -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.reason = reason
    if status_code < 300:
        resp.json.return_value = {"content": [{"type": "text", "text": text_content}]}
        resp.raise_for_status.return_value = None
    else:
        resp.raise_for_status.side_effect = requests.HTTPError(
            f"{status_code} error", response=resp
        )
    return resp


@pytest.fixture(autouse=True)
def _no_real_token_or_sleep():
    with patch.object(azure_ai, "_foundry_token", return_value="fake-token"), patch.object(
        azure_ai.time, "sleep"
    ) as sleep_mock:
        yield sleep_mock


class TestGenerateSuccess:
    def test_succeeds_immediately_with_no_retry(self, _no_real_token_or_sleep):
        with patch.object(azure_ai.requests, "post", return_value=_resp(200, "hello")) as post:
            result = azure_ai.generate("sys", [{"role": "user", "content": "hi"}])
        assert result == "hello"
        assert post.call_count == 1
        _no_real_token_or_sleep.assert_not_called()


class TestGenerateRetriesTransient:
    @pytest.mark.parametrize("status", [429, 503])
    def test_retries_then_succeeds(self, status, _no_real_token_or_sleep):
        responses = [_resp(status), _resp(status), _resp(200, "recovered")]
        with patch.object(azure_ai.requests, "post", side_effect=responses) as post:
            result = azure_ai.generate("sys", [{"role": "user", "content": "hi"}])
        assert result == "recovered"
        assert post.call_count == 3
        # Two retries happened -> two sleeps, with the documented backoff schedule.
        assert _no_real_token_or_sleep.call_count == 2
        _no_real_token_or_sleep.assert_any_call(2)
        _no_real_token_or_sleep.assert_any_call(4)

    def test_retries_on_connection_error_then_succeeds(self, _no_real_token_or_sleep):
        with patch.object(
            azure_ai.requests,
            "post",
            side_effect=[requests.ConnectionError("dropped"), _resp(200, "ok")],
        ) as post:
            result = azure_ai.generate("sys", [{"role": "user", "content": "hi"}])
        assert result == "ok"
        assert post.call_count == 2

    def test_exhausts_retries_and_raises(self, _no_real_token_or_sleep):
        responses = [_resp(429)] * 4  # initial attempt + 3 retries, per _RETRY_DELAYS
        with patch.object(azure_ai.requests, "post", side_effect=responses) as post:
            with pytest.raises(requests.HTTPError):
                azure_ai.generate("sys", [{"role": "user", "content": "hi"}])
        assert post.call_count == 4
        assert _no_real_token_or_sleep.call_count == 3


class TestGenerateDoesNotRetryPersistentFailures:
    @pytest.mark.parametrize("status", [400, 401, 403, 404])
    def test_raises_immediately_without_retry(self, status, _no_real_token_or_sleep):
        with patch.object(azure_ai.requests, "post", return_value=_resp(status)) as post:
            with pytest.raises(requests.HTTPError):
                azure_ai.generate("sys", [{"role": "user", "content": "hi"}])
        assert post.call_count == 1
        _no_real_token_or_sleep.assert_not_called()
