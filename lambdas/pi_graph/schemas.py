"""
Output schema for the Agentic Workflow ("to-be") generation, validated with
Pydantic and a retry-once-on-failure loop.

Scope note: only `proposed_agents[]` gets a strict schema here. The rest of
the to-be graph (`swimlanes`/`steps`/`connectors`/`transformation_summary`/
`ai_stats`) is left as loosely-typed passthrough — it's already consumed
as-is by ProcessMap.tsx and isn't part of what this refinement changes.

pydantic is a dependency of this Lambda only (see requirements.txt) — do not
import this module from anything bundled into a different function.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from common import bedrock

log = logging.getLogger(__name__)

_STAGE_NAMES = ("Detect", "Plan", "Nudge", "Insight", "Action", "Learning Loop")


class AgenticStage(BaseModel):
    stage: Literal["Detect", "Plan", "Nudge", "Insight", "Action", "Learning Loop"]
    label: str
    description: str
    builtOn: str
    agentType: Literal["1P", "3P", "External"]
    executionMode: Literal["Ambient", "Delegate"]
    groundingRef: str | None = None


class Maturity(BaseModel):
    position: float = Field(ge=0, le=1)
    note: str | None = None


class HumanRole(BaseModel):
    tier: Literal["Human Led", "Human Guided", "Human Supervised"]
    description: str


class ProposedAgentV2(BaseModel):
    name: str
    description: str | None = None
    model: str | None = None
    tools: list[dict] = []
    replaces_step_ids: list[str] = []
    stages: list[AgenticStage]
    maturity: Maturity
    humanRoles: list[HumanRole]


def _validate_proposed_agents(tobe: dict) -> None:
    """Raises pydantic.ValidationError (with all per-agent errors) if invalid."""
    errors: list[str] = []
    for i, agent in enumerate(tobe.get("proposed_agents") or []):
        try:
            ProposedAgentV2.model_validate(agent)
        except ValidationError as exc:
            errors.append(f"proposed_agents[{i}] ({agent.get('name', '?')}): {exc}")
    if errors:
        raise ValueError("Schema validation failed:\n" + "\n".join(errors))


def validate_with_retry(
    *, system: str, user_prompt: str, max_tokens: int = 8000, temperature: float = 0.2
) -> dict:
    """
    Generate + validate the to-be JSON. On the first failure — whether the model's
    JSON was truncated/malformed (bedrock.generate_json raises ValueError) or it
    parsed but failed schema validation — retry once with the error fed back into
    the prompt (per the spec's explicit ask) rather than silently coercing
    malformed output. Raises on a second failure.

    max_tokens defaults to 8000 (not the old 4096): the per-agent stages/maturity/
    humanRoles fields added meaningfully more required output per agent, and 4096
    was observed live to truncate mid-string on a multi-agent process.
    """
    try:
        tobe = bedrock.generate_json(system, user_prompt, max_tokens=max_tokens, temperature=temperature)
        _validate_proposed_agents(tobe)
        return tobe
    except ValueError as first_error:
        log.warning("to-be generation/validation failed, retrying once: %s", first_error)
        retry_prompt = (
            user_prompt
            + "\n\n<validation_error>\nYour previous response failed:\n"
            + str(first_error)
            + "\nFix these issues — including making sure the JSON is complete and well-formed, not truncated — "
              "and return a corrected JSON object with the exact same overall structure."
            + "\n</validation_error>"
        )
        tobe = bedrock.generate_json(system, retry_prompt, max_tokens=max_tokens, temperature=temperature)
        _validate_proposed_agents(tobe)  # let this raise if it fails again — no silent coercion
        return tobe
