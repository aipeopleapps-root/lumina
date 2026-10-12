from __future__ import annotations

import json
import logging

from app.agents.base import call_llm
from app.config import Settings
from app.models import ConfigItem, TestScenario

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are an AI assistant specialising in Workday HCM and Financial ERP implementation
and testing. All text MUST be in en-AU/Commonwealth English.

## Task
Analyse the Workday configuration item given and output EXACTLY TWO Test Scenarios:
1. ONE Positive scenario — verify the configuration exists in Workday with the exact
   settings specified in the Configuration Workbook
2. ONE Negative scenario — verify a boundary condition appropriate to the action:
   - Add: verify Workday rejects a duplicate Reference ID
   - Update: verify the system enforces a relevant field constraint (eligibility, unit, etc.)
   - Remove: verify the item is no longer visible or selectable by end users

## Workday Navigation Paths — use exactly these for the relevant object type
- Time Off Types: Menu → Absence → Setup → Time Off Types
- Time Off Plans: Menu → Absence → Setup → Time Off Plans
- Leave of Absence Types: Menu → Absence → Setup → Leave of Absence Types
- Holiday Calendars: Menu → Absence → Setup → Holiday Calendars
- Period Schedules: Menu → Absence → Setup → Period Schedules
- Time Off Segment Security: Menu → Absence → Setup → Segment-Based Security Groups
- Work Schedules: Menu → Time and Absence → Setup → Work Schedules
- Absence Type Groups: Menu → Absence → Setup → Absence Type Groups
- Questionnaire: Menu → Recruiting → Setup → Questionnaires (or Absence setup)

## Preconditions must include
- Required Workday security role (typically Business Process Administrator or HR Administrator)
- Any test worker or tenant data prerequisites

## Output format
Respond with ONLY valid JSON — no markdown fences, no preamble:
{
  "scenarios": [
    {
      "scenario_id": "TS-XXX",
      "scenario_type": "Positive",
      "title": "<short title>",
      "description": "<what is being validated in Workday>",
      "preconditions": ["<precondition 1>", ...]
    },
    {
      "scenario_id": "TS-XXX",
      "scenario_type": "Negative",
      "title": "<short title>",
      "description": "<what boundary condition is being tested>",
      "preconditions": ["<precondition 1>", ...]
    }
  ]
}"""


async def generate_config_scenarios(
    item: ConfigItem,
    settings: Settings,
) -> list[TestScenario]:
    """Call the Config Scenarios agent to generate two TestScenarios from a ConfigItem."""
    user_message = (
        f"Configuration Item ID: {item.item_id}\n"
        f"Workday Object Type (Sheet): {item.sheet_name}\n"
        f"Action: {item.action}\n"
        f"Reference ID: {item.reference_id}\n"
        f"Display Name: {item.display_name}\n"
    )
    if item.additional_fields:
        user_message += "Configuration Fields:\n"
        for key, val in item.additional_fields.items():
            user_message += f"  {key}: {val}\n"

    try:
        raw = await call_llm(SYSTEM_PROMPT, user_message, settings)
    except RuntimeError as exc:
        raise RuntimeError(
            f"Config scenarios agent failed for {item.item_id} ({item.reference_id}): {exc}"
        ) from exc

    try:
        scenarios_raw = raw["scenarios"]
        return [
            TestScenario(
                story_id=item.item_id,
                scenario_id=sc["scenario_id"],
                scenario_type=sc["scenario_type"],
                title=sc["title"],
                description=sc["description"],
                preconditions=sc["preconditions"],
            )
            for sc in scenarios_raw
        ]
    except (KeyError, TypeError) as exc:
        raise RuntimeError(
            f"Config scenarios agent returned unexpected structure for {item.item_id}. "
            f"Raw: {raw!r}"
        ) from exc
