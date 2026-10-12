from __future__ import annotations

import json
import logging

from app.agents.base import call_llm
from app.config import Settings
from app.models import TestScenario, TestStep

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are an AI assistant specialising in Workday HCM and Financial ERP implementation
and testing. The audience are end-clients with limited Workday experience.
All text MUST be in en-AU/Commonwealth English.

## Task
For each Test Scenario given, produce a numbered list of test steps.
Each step must be actionable and self-contained.

## Output format
Respond with ONLY valid JSON — no markdown fences, no preamble:
{
  "steps": [
    {
      "step_number": 1,
      "action": "<what the tester does>",
      "expected_result": "<what should happen>",
      "test_data": "<any specific data values or null>"
    },
    ...
  ]
}"""


async def generate_test_steps(
    scenario: TestScenario,
    settings: Settings,
) -> list[TestStep]:
    """Call Agent 3 to convert a TestScenario into a list of TestSteps."""
    user_message = json.dumps(scenario.model_dump(), indent=2)

    try:
        raw = await call_llm(SYSTEM_PROMPT, user_message, settings)
    except RuntimeError as exc:
        raise RuntimeError(
            f"Agent 3 (test_steps) failed for scenario {scenario.scenario_id}: {exc}"
        ) from exc

    try:
        steps_raw = raw["steps"]
        steps: list[TestStep] = []
        for item in steps_raw:
            step_num = item["step_number"]
            step_id = f"{scenario.scenario_id}-{step_num:03d}"
            steps.append(
                TestStep(
                    scenario_id=scenario.scenario_id,
                    step_id=step_id,
                    step_number=step_num,
                    action=item["action"],
                    expected_result=item["expected_result"],
                    test_data=item.get("test_data"),
                )
            )
        return steps
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            f"Agent 3 returned unexpected structure for scenario {scenario.scenario_id}. "
            f"Raw response: {raw!r}"
        ) from exc
