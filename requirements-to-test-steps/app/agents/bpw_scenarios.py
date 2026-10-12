from __future__ import annotations

import json
import logging

from app.agents.base import call_llm
from app.config import Settings
from app.models import BPWProcess, BPWStep, TestScenario

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are an AI assistant specialising in Workday HCM and Financial ERP implementation
and testing. All text MUST be in en-AU/Commonwealth English.

## Task
Analyse the Workday Business Process details given and generate Test Scenarios.
Generate ONE scenario per approval route:
- Primary approval route → ONE Positive scenario (happy path through Workday)
- Each Alternate approval route → ONE Negative scenario (edge case / alternate initiator)
- Any unique conditional path identified in the step "Condition Applies" fields
  (e.g. "IF Parental Leave", "IF EAS initiates") → ONE additional scenario

Rules:
- Non-Workday steps (offline discussions, phone calls) become preconditions — not test steps
- Workday steps (system tasks: Request, Approve, Review, etc.) form the basis of test steps
- Each scenario precondition list must state: required security role, test worker type,
  and any tenant data (leave type, leave plan, questionnaire) that must exist before testing
- Scenario type must be "Positive" for the primary route, "Negative" for all others

## Output format
Respond with ONLY valid JSON — no markdown fences, no preamble:
{
  "scenarios": [
    {
      "scenario_id": "TS-XXX",
      "scenario_type": "Positive",
      "title": "<short title>",
      "description": "<which route / path is being tested and what outcome is expected>",
      "preconditions": ["<precondition 1>", ...]
    },
    ...
  ]
}"""


async def generate_bpw_scenarios(
    bpw_process: BPWProcess,
    steps: list[BPWStep],
    settings: Settings,
) -> list[TestScenario]:
    """
    Call the BPW Scenarios agent to generate TestScenarios for one business process.
    Returns 2–5 scenarios depending on the number of approval routes and conditions.
    """
    # Build a structured user message with process context + steps
    user_message = f"Process Name: {bpw_process.process_name}\n"
    if bpw_process.overview:
        user_message += f"Overview: {bpw_process.overview}\n"
    if bpw_process.objective:
        user_message += f"Objective: {bpw_process.objective}\n"
    if bpw_process.business_trigger:
        user_message += f"Business Trigger: {bpw_process.business_trigger}\n"

    if bpw_process.approval_routes:
        user_message += "\nApproval Routes:\n"
        for route in bpw_process.approval_routes:
            user_message += (
                f"  - {route.get('route', '')}: "
                f"Initiator={route.get('initiator', '')}, "
                f"1st Approval={route.get('first_approval', '')}, "
                f"2nd Approval={route.get('second_approval', '')}"
            )
            if route.get("comments"):
                user_message += f", Note={route['comments']}"
            user_message += "\n"

    user_message += "\nProcess Steps:\n"
    for step in steps:
        user_message += (
            f"  Step {step.step_number} [{step.step_type}] — {step.step_name} "
            f"(Role: {step.role})"
        )
        if step.description:
            user_message += f": {step.description[:150]}"
        if step.condition:
            user_message += f" [Condition: {step.condition}]"
        user_message += "\n"

    try:
        raw = await call_llm(SYSTEM_PROMPT, user_message, settings)
    except RuntimeError as exc:
        raise RuntimeError(
            f"BPW scenarios agent failed for process '{bpw_process.process_name}': {exc}"
        ) from exc

    try:
        scenarios_raw = raw["scenarios"]
        return [
            TestScenario(
                story_id=bpw_process.process_name,
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
            f"BPW scenarios agent returned unexpected structure for '{bpw_process.process_name}'. "
            f"Raw: {raw!r}"
        ) from exc
