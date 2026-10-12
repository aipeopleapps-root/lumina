from __future__ import annotations

import json
import logging

from app.agents.base import call_llm
from app.config import Settings
from app.models import TestScenario, UserStory

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are an AI assistant specialising in Workday HCM and Financial ERP implementation
and testing. All text MUST be in en-AU/Commonwealth English.

## Task
Analyse the User Story JSON given and output EXACTLY TWO Test Scenarios:
1. ONE Positive scenario (happy path)
2. ONE Negative scenario (failure / edge case)

## Output format
Respond with ONLY valid JSON — no markdown fences, no preamble:
{
  "scenarios": [
    {
      "scenario_id": "TS-XXX",
      "scenario_type": "Positive",
      "title": "<short title>",
      "description": "<what is being tested>",
      "preconditions": ["<precondition 1>", ...]
    },
    {
      "scenario_id": "TS-XXX",
      "scenario_type": "Negative",
      "title": "<short title>",
      "description": "<what is being tested>",
      "preconditions": ["<precondition 1>", ...]
    }
  ]
}"""


async def generate_test_scenarios(
    user_story: UserStory,
    settings: Settings,
) -> list[TestScenario]:
    """Call Agent 2 to convert a UserStory into two TestScenarios."""
    user_message = json.dumps(user_story.model_dump(), indent=2)

    try:
        raw = await call_llm(SYSTEM_PROMPT, user_message, settings)
    except RuntimeError as exc:
        raise RuntimeError(
            f"Agent 2 (test_scenarios) failed for story {user_story.story_id}: {exc}"
        ) from exc

    try:
        scenarios_raw = raw["scenarios"]
        scenarios: list[TestScenario] = []
        for item in scenarios_raw:
            scenarios.append(
                TestScenario(
                    story_id=user_story.story_id,
                    scenario_id=item["scenario_id"],
                    scenario_type=item["scenario_type"],
                    title=item["title"],
                    description=item["description"],
                    preconditions=item["preconditions"],
                )
            )
        return scenarios
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            f"Agent 2 returned unexpected structure for story {user_story.story_id}. "
            f"Raw response: {raw!r}"
        ) from exc
