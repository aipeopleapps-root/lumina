"""
Enqueue helper for the shared Azure Storage Queue ("jobs") that backs the
cross-invoke/async-worker pattern (generate_tests, pi_parse, pi_agent_lld).

AWS side: the sync Lambda does `_lambda_client.invoke(InvocationType="Event", ...)`
to fire-and-forget invoke a separate worker Lambda. Azure has no direct
function-to-function async invoke, so the trigger handler instead enqueues a
job message here; a queue-triggered Function (wired in Phase 7) dequeues it
and dispatches to the matching worker module's `worker_handler(payload)` by
`job_type`. All job types share one queue — the message envelope carries
`job_type` so a single dispatcher can route to the right worker.
"""

from __future__ import annotations

import json
import os
from typing import Any

from azure.identity import DefaultAzureCredential
from azure.storage.queue import QueueClient, TextBase64EncodePolicy

_client: QueueClient | None = None


def _queue_name() -> str:
    return os.environ.get("JOBS_QUEUE_NAME", "jobs")


def _queue_client() -> QueueClient:
    global _client
    if _client is None:
        _client = QueueClient(
            account_url=os.environ["AZURE_STORAGE_QUEUE_URL"],
            queue_name=_queue_name(),
            credential=DefaultAzureCredential(),
            message_encode_policy=TextBase64EncodePolicy(),
        )
    return _client


def enqueue_job(job_type: str, payload: dict[str, Any]) -> None:
    """Enqueue {job_type, payload} onto the shared 'jobs' queue."""
    message = {"job_type": job_type, "payload": payload}
    _queue_client().send_message(json.dumps(message))
