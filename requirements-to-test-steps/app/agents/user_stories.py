from __future__ import annotations

import json
import logging

from app.agents.base import call_llm
from app.config import Settings
from app.models import Requirement, UserStory

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are an AI assistant specialising in Workday HCM and Financial ERP implementation
and testing. Your responses MUST follow only the described desired content and MUST
NOT include any superfluous text. All text MUST be in en-AU/Commonwealth English.

## Task
Analyse the requirement text given and output EXACTLY ONE User Story.
Do NOT merge, combine, or group multiple requirements.

## Output format
Respond with ONLY valid JSON matching this schema — no markdown fences, no preamble:
{
  "story_id": "US-XXX",
  "as_a": "<role>",
  "i_want": "<goal>",
  "so_that": "<benefit>",
  "acceptance_criteria": ["<criterion 1>", "<criterion 2>", ...]
}"""


async def generate_user_story(
    requirement: Requirement,
    settings: Settings,
) -> UserStory:
    """Call Agent 1 to convert a Requirement into a UserStory."""
    user_message = (
        f"Requirement ID: {requirement.requirement_id}\n"
        f"Requirement: {requirement.requirement_text}\n"
    )
    if requirement.module:
        user_message += f"Module: {requirement.module}\n"
    if requirement.priority:
        user_message += f"Priority: {requirement.priority}\n"

    try:
        raw = await call_llm(SYSTEM_PROMPT, user_message, settings)
    except RuntimeError as exc:
        raise RuntimeError(
            f"Agent 1 (user_stories) failed for {requirement.requirement_id}: {exc}"
        ) from exc

    try:
        return UserStory(
            requirement_id=requirement.requirement_id,
            story_id=raw["story_id"],
            as_a=raw["as_a"],
            i_want=raw["i_want"],
            so_that=raw["so_that"],
            acceptance_criteria=raw["acceptance_criteria"],
        )
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            f"Agent 1 returned unexpected structure for {requirement.requirement_id}. "
            f"Raw response: {raw!r}"
        ) from exc
