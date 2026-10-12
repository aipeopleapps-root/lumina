"""
Enqueue helpers for the two Azure Storage Queues this app uses.

`jobs` (default, `enqueue_job`): the shared cross-invoke/async-worker pattern
(generate_tests, pi_parse, pi_agent_lld, rfp_reimagine, test_automation's own
generation stages). AWS side: the sync Lambda does
`_lambda_client.invoke(InvocationType="Event", ...)` to fire-and-forget invoke
a separate worker Lambda. Azure has no direct function-to-function async
invoke, so the trigger handler instead enqueues a job message here; a
queue-triggered Function dequeues it and dispatches to the matching worker
module's `worker_handler(payload)` by `job_type`. All these job types share
one queue — the message envelope carries `job_type` so a single dispatcher
can route to the right worker.

`execution` (`enqueue_execution`): a SEPARATE queue, deliberately not folded
into `jobs`. Backs the Workday-execution engine (Container Apps Job, KEDA
queue-scaled) — a fundamentally different consumer (a container, not this
Function App) and a much heavier/longer-running unit of work (one Chromium
session driving a live Workday UI, potentially minutes per message) than the
LLM-call jobs sharing `jobs` today. Same reasoning `test_automation` got its
own Postgres schema instead of overloading `pi`.
"""

from __future__ import annotations

import json
import os
from typing import Any

from azure.identity import DefaultAzureCredential
from azure.storage.queue import QueueClient, TextBase64EncodePolicy

_clients: dict[str, QueueClient] = {}


def _queue_client(queue_name: str) -> QueueClient:
    if queue_name not in _clients:
        _clients[queue_name] = QueueClient(
            account_url=os.environ["AZURE_STORAGE_QUEUE_URL"],
            queue_name=queue_name,
            credential=DefaultAzureCredential(),
            message_encode_policy=TextBase64EncodePolicy(),
        )
    return _clients[queue_name]


def enqueue_job(job_type: str, payload: dict[str, Any]) -> None:
    """Enqueue {job_type, payload} onto the shared 'jobs' queue."""
    queue_name = os.environ.get("JOBS_QUEUE_NAME", "jobs")
    message = {"job_type": job_type, "payload": payload}
    _queue_client(queue_name).send_message(json.dumps(message))


def enqueue_execution(payload: dict[str, Any]) -> None:
    """
    Enqueue one scenario-execution message onto the dedicated 'execution'
    queue, consumed by the Workday-execution Container Apps Job (not this
    Function App) — no job_type envelope needed since there's exactly one
    consumer/shape, unlike `jobs`.
    """
    queue_name = os.environ.get("EXECUTION_QUEUE_NAME", "execution")
    _queue_client(queue_name).send_message(json.dumps(payload))
