"""
Per-app admin-configurable settings — a declarative schema registry plus a
resolved-value reader, backed by the same generic `config` Cosmos container
`app_visibility` already uses for the same shape of problem (admin-only,
per-app, partial-override map).

Storage: one Cosmos item per app, pk="APP_SETTINGS", sk=<app_id>:
    { "pk": "APP_SETTINGS", "sk": "ask-stuey", "settings": {"top_k": 15} }
The stored `settings` map holds ONLY overrides — a key absent from it means
"use the schema-declared default." A fresh environment needs no seeding.

SETTINGS_SCHEMAS is the single source of truth, read by both:
  - functions/admin_app_settings/handler.py (to know what to display/validate)
  - individual app handlers, via get_app_settings(app_id) (to read resolved values)
so the schema is never declared twice.

Not every hardcoded constant belongs here — only business-tunable behavior
(model params, thresholds, curated value lists) that an admin might
legitimately want to change without a code deploy. System/security invariants
(valid user roles, valid admin actions, protected tenant ids) stay as plain
code constants; making those admin-editable would be a footgun, not a feature.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from . import cosmos_config as config

_PK = "APP_SETTINGS"


@dataclass(frozen=True)
class SettingDef:
    key: str
    label: str
    type: str  # "number" | "boolean" | "select" | "string_list"
    default: Any
    description: str = ""
    min: float | None = None
    max: float | None = None
    step: float | None = None
    options: list[str] | None = None  # required for type == "select"


SETTINGS_SCHEMAS: dict[str, list[SettingDef]] = {
    "ask-stuey": [
        SettingDef(
            key="top_k", label="Retrieval candidates (Top K)", type="number",
            default=12, min=1, max=50, step=1,
            description="Raw chunks fetched before per-source de-duping. Needs headroom above "
                         "the final source count shown, or a table-heavy document (one chunk per "
                         "row) can crowd other documents out entirely.",
        ),
        SettingDef(
            key="max_context_sources", label="Max documents sent to Claude", type="number",
            default=6, min=1, max=20, step=1,
            description="Caps how many distinct documents' full excerpts go into the prompt. "
                         "Every extra source here is real cost and latency — Stuey's persona only "
                         "ever leans on one or two of these to answer anyway.",
        ),
        SettingDef(
            key="max_chunks_per_source", label="Chunks per document sent to Claude", type="number",
            default=2, min=1, max=5, step=1,
            description="How many of a document's own best-scoring chunks go into the prompt, "
                         "not just its single top-scoring one. Confirmed live: a question could "
                         "retrieve only a course manual's table-of-contents chunk (which happens "
                         "to name both terms in the question) while the chunk with the actual "
                         "explanation, elsewhere in the same document, scored slightly lower and "
                         "was silently dropped — Stuey then correctly refused to answer from a "
                         "title page. Raising this gives a document more than one chance to "
                         "surface its real content. The citation card shown to the user still "
                         "de-dupes to one per document regardless of this setting — this only "
                         "affects what Claude reads, not what's displayed.",
        ),
        SettingDef(
            key="max_display_sources", label="Max sources shown to the user", type="number",
            default=8, min=1, max=20, step=1,
            description="Hard ceiling on source links ever shown, even for an explicit "
                         "\"give me every X\" request — insurance against a runaway list.",
        ),
        SettingDef(
            key="confidence_high", label="High confidence threshold", type="number",
            default=0.55, min=0, max=1, step=0.01,
            description="Cosine-similarity score at/above which a reply is labeled High "
                         "confidence. Calibrated against real scores observed in this system, "
                         "not a universal standard — retune if the knowledge base's content mix "
                         "shifts the score distribution.",
        ),
        SettingDef(
            key="confidence_medium", label="Medium confidence threshold", type="number",
            default=0.40, min=0, max=1, step=0.01,
            description="Score at/above which a reply is labeled Medium confidence rather than "
                         "Low. Must stay below the High threshold.",
        ),
        SettingDef(
            key="citation_match_threshold", label="Citation word-overlap threshold", type="number",
            default=0.7, min=0, max=1, step=0.05,
            description="Fraction of a document's significant words that must appear in the "
                         "reply text for that document to be shown as a cited source. Lower risks "
                         "showing unrelated sources; higher risks showing none when Claude "
                         "paraphrases a title.",
        ),
        SettingDef(
            key="max_tokens", label="Max reply length (tokens)", type="number",
            default=500, min=50, max=2000, step=50,
            description="Generation cap passed to Claude. Knowledge-style answers are allowed to "
                         "use the room; document-finding answers rarely need more than a fraction "
                         "of it.",
        ),
        SettingDef(
            key="temperature", label="Response creativity (temperature)", type="number",
            default=0.5, min=0, max=1, step=0.05,
            description="Higher values make Stuey's phrasing more varied, lower values more "
                         "literal/consistent.",
        ),
    ],
    "rfp-reimagine": [
        SettingDef(
            key="valid_modules", label="Workday modules", type="string_list",
            default=["HCM", "Fins", "Payroll", "Platform"],
            description="Allowed values for the RFP questionnaire's Workday module field.",
        ),
        SettingDef(
            key="valid_budget_ranges", label="Budget ranges", type="string_list",
            default=["Under $2M", "$2M-$5M", "$5M-$10M", "$10M+", "Not disclosed"],
            description="Allowed values for the RFP questionnaire's budget-range field.",
        ),
    ],
}


def get_app_settings(app_id: str) -> dict[str, Any]:
    """
    One Cosmos read. Returns every declared setting for app_id, resolved —
    admin override if one exists, schema default otherwise. Call this ONCE
    per handler invocation and destructure whatever keys you need; calling
    get_setting-per-key would mean N Cosmos round-trips per request instead
    of one.
    """
    schema = SETTINGS_SCHEMAS.get(app_id, [])
    resolved: dict[str, Any] = {s.key: s.default for s in schema}
    item = config.get_item(_PK, app_id)
    if item:
        resolved.update(item.get("settings", {}))
    return resolved


def list_all_resolved() -> dict[str, dict[str, Any]]:
    """Admin-listing helper: every app's schema + resolved values, one Cosmos
    query (not one point-read per app) — see admin_app_settings/handler.py."""
    overrides_by_app = {item["sk"]: item.get("settings", {}) for item in config.query_by_pk(_PK)}
    out: dict[str, dict[str, Any]] = {}
    for app_id, schema in SETTINGS_SCHEMAS.items():
        resolved = {s.key: s.default for s in schema}
        resolved.update(overrides_by_app.get(app_id, {}))
        out[app_id] = {
            "schema": [
                {
                    "key": s.key, "label": s.label, "type": s.type, "default": s.default,
                    "description": s.description, "min": s.min, "max": s.max, "step": s.step,
                    "options": s.options,
                }
                for s in schema
            ],
            "values": resolved,
        }
    return out


def validate_and_normalize(app_id: str, settings: dict[str, Any]) -> dict[str, Any]:
    """
    Validates `settings` (a proposed override map) against app_id's schema —
    unknown keys, wrong types, or out-of-range/out-of-options values all
    raise ValueError with a message safe to return as a 400. Returns the
    settings dict unchanged (normalization hook for future setting types).
    """
    schema_by_key = {s.key: s for s in SETTINGS_SCHEMAS.get(app_id, [])}
    if not schema_by_key:
        raise ValueError(f"app {app_id!r} has no configurable settings")

    for key, value in settings.items():
        if key not in schema_by_key:
            raise ValueError(f"unknown setting {app_id}.{key}")
        s = schema_by_key[key]

        if s.type == "number":
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ValueError(f"{key} must be a number")
            if s.min is not None and value < s.min:
                raise ValueError(f"{key} must be >= {s.min}")
            if s.max is not None and value > s.max:
                raise ValueError(f"{key} must be <= {s.max}")
        elif s.type == "boolean":
            if not isinstance(value, bool):
                raise ValueError(f"{key} must be a boolean")
        elif s.type == "select":
            if value not in (s.options or []):
                raise ValueError(f"{key} must be one of: {', '.join(s.options or [])}")
        elif s.type == "string_list":
            if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                raise ValueError(f"{key} must be a list of strings")
        else:
            raise ValueError(f"unhandled setting type {s.type!r} for {key}")

    return settings
