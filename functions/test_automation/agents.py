"""
The 5 generation agents, ported from requirements-to-test-steps/app/agents/*.py.
System prompts are ported verbatim (validated, Workday-domain-specific
content) — only the call mechanics change: raw httpx to a Deloitte GPT-5.1
gateway (`call_llm`) is replaced with `common.ai.generate_json()` against the
user's own Azure AI Foundry / Claude deployment (see functions/common/azure_ai.py).

Every function returns plain dicts, not Pydantic models (no other Lumina
handler uses pydantic). None of the source app's own "story_id"/"scenario_id"
output fields are trusted — human-readable/display IDs are assigned by the
caller (test_automation/handler.py) from Postgres insertion order instead,
matching the source app's own pipeline.py behaviour of reassigning sequential
IDs after generation rather than trusting whatever the model echoed back.
"""

from __future__ import annotations

import logging

from common import ai

log = logging.getLogger(__name__)

# ── Agent 1: Requirement -> User Story ──────────────────────────────────────

_USER_STORY_SYSTEM = """\
You are an AI assistant specialising in Workday HCM and Financial ERP implementation
and testing. Your responses MUST follow only the described desired content and MUST
NOT include any superfluous text. All text MUST be in en-AU/Commonwealth English.

## Task
Analyse the requirement text given and output EXACTLY ONE User Story.
Do NOT merge, combine, or group multiple requirements.

## Output format
Respond with ONLY valid JSON matching this schema:
{
  "as_a": "<role>",
  "i_want": "<goal>",
  "so_that": "<benefit>",
  "acceptance_criteria": ["<criterion 1>", "<criterion 2>", ...]
}"""


def generate_user_story(requirement: dict) -> dict:
    """Convert a Requirement dict into a UserStory dict."""
    user_message = (
        f"Requirement ID: {requirement['requirement_id']}\n"
        f"Requirement: {requirement['requirement_text']}\n"
    )
    if requirement.get("module"):
        user_message += f"Module: {requirement['module']}\n"
    if requirement.get("priority"):
        user_message += f"Priority: {requirement['priority']}\n"

    try:
        raw = ai.generate_json(_USER_STORY_SYSTEM, user_message, max_tokens=800, temperature=0.3)
        return {
            "requirement_id": requirement["requirement_id"],
            "story_id": None,  # assigned by the caller from insertion order
            "as_a": raw["as_a"],
            "i_want": raw["i_want"],
            "so_that": raw["so_that"],
            "acceptance_criteria": raw.get("acceptance_criteria") or [],
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(
            f"Agent 1 (user_stories) failed for {requirement['requirement_id']}: {exc}"
        ) from exc


# ── Agent 2: User Story -> Test Scenarios ───────────────────────────────────

_TEST_SCENARIOS_SYSTEM = """\
You are an AI assistant specialising in Workday HCM and Financial ERP implementation
and testing. All text MUST be in en-AU/Commonwealth English.

## Task
Analyse the User Story JSON given and output EXACTLY TWO Test Scenarios:
1. ONE Positive scenario (happy path)
2. ONE Negative scenario (failure / edge case)

## Output format
Respond with ONLY valid JSON:
{
  "scenarios": [
    {
      "scenario_type": "Positive",
      "title": "<short title>",
      "description": "<what is being tested>",
      "preconditions": ["<precondition 1>", ...]
    },
    {
      "scenario_type": "Negative",
      "title": "<short title>",
      "description": "<what is being tested>",
      "preconditions": ["<precondition 1>", ...]
    }
  ]
}"""


def generate_test_scenarios(user_story: dict) -> list[dict]:
    """Convert a UserStory dict into two TestScenario dicts."""
    import json as _json
    user_message = _json.dumps(user_story, indent=2)

    try:
        raw = ai.generate_json(_TEST_SCENARIOS_SYSTEM, user_message, max_tokens=1200, temperature=0.3)
        return [
            {
                "source_ref": user_story["story_id"],
                "scenario_type": sc["scenario_type"],
                "title": sc["title"],
                "description": sc["description"],
                "preconditions": sc.get("preconditions") or [],
            }
            for sc in raw["scenarios"]
        ]
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(
            f"Agent 2 (test_scenarios) failed for story {user_story.get('story_id')}: {exc}"
        ) from exc


# ── Agent 3: Test Scenario -> Test Steps ────────────────────────────────────

_TEST_STEPS_SYSTEM = """\
You are an AI assistant specialising in Workday HCM and Financial ERP implementation
and testing. The audience are end-clients with limited Workday experience.
All text MUST be in en-AU/Commonwealth English.

## Task
For each Test Scenario given, produce a numbered list of test steps.
Each step must be actionable and self-contained.

## Quoting UI targets (required)
Whenever a step names a specific button, link, menu item, tab, or field the
tester interacts with, wrap that exact label in single quotes in `action` —
e.g. "Click the 'Create Project' button", "Enter the value in the 'Project
Name' field", "Select 'Approve' from the actions menu". Use the literal
on-screen label a tester would read, not a paraphrase or the workflow's own
name for the step. This is not just for human readability — Lumina's
Workday-execution engine parses this exact quoted text to locate and
interact with the element automatically, so a step with a real UI target but
no quotes around it will be skipped as unexecutable. Steps that are purely
navigational scene-setting with no single clickable/fillable target (e.g.
"Log in as the Finance Manager persona") don't need a quoted target.

## Output format
Respond with ONLY valid JSON:
{
  "steps": [
    {
      "step_number": 1,
      "action": "<what the tester does, with the literal UI target 'quoted' if there is one>",
      "ui_target": "<the exact on-screen label of the element the tester interacts with, verbatim, or null if none>",
      "expected_result": "<what should happen>",
      "test_data": "<any specific data values or null>"
    },
    ...
  ]
}"""


def generate_test_steps(scenario: dict) -> list[dict]:
    """Convert a TestScenario dict into a list of TestStep dicts."""
    import json as _json
    user_message = _json.dumps({
        "scenario_type": scenario["scenario_type"],
        "title": scenario["title"],
        "description": scenario.get("description"),
        "preconditions": scenario.get("preconditions") or [],
    }, indent=2)

    try:
        # 1500 was too tight — a detailed scenario with 10+ verbose steps hard-truncates the JSON
        # mid-generation (confirmed live: a Finance/cost-allocation scenario's response cut off
        # mid-string), which ai.generate_json() then can't parse. 3500 gives real headroom.
        raw = ai.generate_json(_TEST_STEPS_SYSTEM, user_message, max_tokens=3500, temperature=0.3)
        return [
            {
                "scenario_id": scenario["scenario_id"],
                "step_number": item["step_number"],
                "action": item["action"],
                "ui_target": (item.get("ui_target") or "").strip() or None,
                "expected_result": item["expected_result"],
                "test_data": item.get("test_data"),
            }
            for item in raw["steps"]
        ]
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(
            f"Agent 3 (test_steps) failed for scenario {scenario.get('scenario_id')}: {exc}"
        ) from exc


# ── Config-workbook special-case agent: ConfigItem -> Test Scenarios ────────

_CONFIG_SCENARIOS_SYSTEM = """\
You are an AI assistant specialising in Workday HCM and Financial ERP implementation
and testing. All text MUST be in en-AU/Commonwealth English.

## Task
Analyse the Workday configuration item given and output EXACTLY TWO Test Scenarios:
1. ONE Positive scenario - verify the configuration exists in Workday with the exact
   settings specified in the Configuration Workbook
2. ONE Negative scenario - verify a boundary condition appropriate to the action:
   - Add: verify Workday rejects a duplicate Reference ID
   - Update: verify the system enforces a relevant field constraint (eligibility, unit, etc.)
   - Remove: verify the item is no longer visible or selectable by end users

## Workday Navigation Paths - use exactly these for the relevant object type
- Time Off Types: Menu -> Absence -> Setup -> Time Off Types
- Time Off Plans: Menu -> Absence -> Setup -> Time Off Plans
- Leave of Absence Types: Menu -> Absence -> Setup -> Leave of Absence Types
- Holiday Calendars: Menu -> Absence -> Setup -> Holiday Calendars
- Period Schedules: Menu -> Absence -> Setup -> Period Schedules
- Time Off Segment Security: Menu -> Absence -> Setup -> Segment-Based Security Groups
- Work Schedules: Menu -> Time and Absence -> Setup -> Work Schedules
- Absence Type Groups: Menu -> Absence -> Setup -> Absence Type Groups
- Questionnaire: Menu -> Recruiting -> Setup -> Questionnaires (or Absence setup)

## Preconditions must include
- Required Workday security role (typically Business Process Administrator or HR Administrator)
- Any test worker or tenant data prerequisites

## Output format
Respond with ONLY valid JSON:
{
  "scenarios": [
    {
      "scenario_type": "Positive",
      "title": "<short title>",
      "description": "<what is being validated in Workday>",
      "preconditions": ["<precondition 1>", ...]
    },
    {
      "scenario_type": "Negative",
      "title": "<short title>",
      "description": "<what boundary condition is being tested>",
      "preconditions": ["<precondition 1>", ...]
    }
  ]
}"""


def generate_config_scenarios(item: dict) -> list[dict]:
    """Generate two TestScenario dicts from a ConfigItem dict."""
    user_message = (
        f"Configuration Item ID: {item['item_id']}\n"
        f"Workday Object Type (Sheet): {item['sheet_name']}\n"
        f"Action: {item['action']}\n"
        f"Reference ID: {item['reference_id']}\n"
        f"Display Name: {item['display_name']}\n"
    )
    if item.get("additional_fields"):
        user_message += "Configuration Fields:\n"
        for key, val in item["additional_fields"].items():
            user_message += f"  {key}: {val}\n"

    try:
        raw = ai.generate_json(_CONFIG_SCENARIOS_SYSTEM, user_message, max_tokens=1200, temperature=0.3)
        return [
            {
                "source_ref": item["item_id"],
                "scenario_type": sc["scenario_type"],
                "title": sc["title"],
                "description": sc["description"],
                "preconditions": sc.get("preconditions") or [],
            }
            for sc in raw["scenarios"]
        ]
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(
            f"Config scenarios agent failed for {item['item_id']} ({item['reference_id']}): {exc}"
        ) from exc


# ── BPW special-case agent: BPWProcess + steps -> Test Scenarios ────────────

_BPW_SCENARIOS_SYSTEM = """\
You are an AI assistant specialising in Workday HCM and Financial ERP implementation
and testing. All text MUST be in en-AU/Commonwealth English.

## Task
Analyse the Workday Business Process details given and generate Test Scenarios.
Generate ONE scenario per approval route:
- Primary approval route -> ONE Positive scenario (happy path through Workday)
- Each Alternate approval route -> ONE Negative scenario (edge case / alternate initiator)
- Any unique conditional path identified in the step "Condition Applies" fields
  (e.g. "IF Parental Leave", "IF EAS initiates") -> ONE additional scenario

Rules:
- Non-Workday steps (offline discussions, phone calls) become preconditions - not test steps
- Workday steps (system tasks: Request, Approve, Review, etc.) form the basis of test steps
- Each scenario precondition list must state: required security role, test worker type,
  and any tenant data (leave type, leave plan, questionnaire) that must exist before testing
- Scenario type must be "Positive" for the primary route, "Negative" for all others

## Output format
Respond with ONLY valid JSON:
{
  "scenarios": [
    {
      "scenario_type": "Positive",
      "title": "<short title>",
      "description": "<which route / path is being tested and what outcome is expected>",
      "preconditions": ["<precondition 1>", ...]
    },
    ...
  ]
}"""


def generate_bpw_scenarios(bpw_process: dict, steps: list[dict]) -> list[dict]:
    """
    Generate TestScenario dicts for one business process.
    Returns 2-5 scenarios depending on the number of approval routes and conditions.
    """
    user_message = f"Process Name: {bpw_process['process_name']}\n"
    if bpw_process.get("overview"):
        user_message += f"Overview: {bpw_process['overview']}\n"
    if bpw_process.get("objective"):
        user_message += f"Objective: {bpw_process['objective']}\n"
    if bpw_process.get("business_trigger"):
        user_message += f"Business Trigger: {bpw_process['business_trigger']}\n"

    if bpw_process.get("approval_routes"):
        user_message += "\nApproval Routes:\n"
        for route in bpw_process["approval_routes"]:
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
            f"  Step {step['step_number']} [{step['step_type']}] - {step['step_name']} "
            f"(Role: {step['role']})"
        )
        if step.get("description"):
            user_message += f": {step['description'][:150]}"
        if step.get("condition"):
            user_message += f" [Condition: {step['condition']}]"
        user_message += "\n"

    try:
        # Same truncation risk as generate_test_steps (see its comment) — a process with several
        # approval routes plus conditional paths can produce 5+ detailed scenarios.
        raw = ai.generate_json(_BPW_SCENARIOS_SYSTEM, user_message, max_tokens=3500, temperature=0.3)
        return [
            {
                "source_ref": bpw_process["process_name"],
                "scenario_type": sc["scenario_type"],
                "title": sc["title"],
                "description": sc["description"],
                "preconditions": sc.get("preconditions") or [],
            }
            for sc in raw["scenarios"]
        ]
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(
            f"BPW scenarios agent failed for process '{bpw_process['process_name']}': {exc}"
        ) from exc
