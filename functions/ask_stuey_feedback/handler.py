"""
Ask Stuey — thumbs up/down feedback on a chat reply.

POST /ask-stuey/feedback
  Body: {
    "message": str,               # the consultant's question
    "reply": str,                 # Stuey's reply text
    "sources": [str, ...],        # source_name of each document Stuey cited
    "rating": "up" | "down",
    "comment": str (optional)     # only meaningful for "down" — what was wrong
  }
  Role: consultant | project_admin | super_admin (same as chat itself)

No dedicated feedback store — writes into the existing audit-log pipeline
(functions/common/audit_events.py) under action "ai.stuey_feedback", so it's
reviewable today through AdminPanel's existing Audit Log tab (already filters
by an "ai." category) rather than needing a new admin screen built for it.
Thumbs-down entries carry the consultant's own explanation of what was wrong
in `details.comment` — the intended use is a human periodically scanning
"ai.stuey_feedback" + rating=down entries to spot patterns (a document that
keeps getting missed, a chunk that reads confusingly) and fix the underlying
content or chunking, the same way session 15's Talent Optimization SKU bug
was found and fixed. This endpoint only records the signal; it does not
itself change retrieval or prompting.
"""

from __future__ import annotations

import json
import logging
import os

from common import tenant_from_event, TenantError, audit_events, http

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_VALID_RATINGS = {"up", "down"}
_MAX_LEN = 4000


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("consultant", "super_admin", "project_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    message = (body.get("message") or "").strip()[:_MAX_LEN]
    reply = (body.get("reply") or "").strip()[:_MAX_LEN]
    rating = (body.get("rating") or "").strip().lower()
    comment = (body.get("comment") or "").strip()[:_MAX_LEN]
    sources = body.get("sources")
    if not isinstance(sources, list) or not all(isinstance(s, str) for s in sources):
        sources = []

    if not message or not reply:
        return http.bad_request("message and reply are required")
    if rating not in _VALID_RATINGS:
        return http.bad_request(f"rating must be one of: {', '.join(sorted(_VALID_RATINGS))}")

    audit_events.write(
        ctx,
        "ai.stuey_feedback",
        ip=audit_events.get_ip(event),
        resource_type="stuey_feedback",
        resource_id=rating,
        resource_name=message[:120],
        details={
            "message": message,
            "reply": reply,
            "sources": sources,
            "rating": rating,
            "comment": comment,
        },
    )

    log.info("Stuey feedback rating=%s user=%s comment_len=%d", rating, ctx.user_id, len(comment))
    return http.ok({"recorded": True})
