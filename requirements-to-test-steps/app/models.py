from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel


class InputType(str, Enum):
    requirements = "requirements"
    user_stories = "user_stories"
    config_workbook = "config_workbook"
    bpw = "bpw"


class Requirement(BaseModel):
    row_number: int
    requirement_id: str
    requirement_text: str
    module: str | None = None
    priority: str | None = None


class UserStory(BaseModel):
    requirement_id: str
    story_id: str
    as_a: str
    i_want: str
    so_that: str
    acceptance_criteria: list[str]


class ConfigItem(BaseModel):
    item_id: str                          # e.g. "CFG-001"
    sheet_name: str                       # Workday object type, e.g. "Time Off Types"
    action: str                           # Add | Update | Remove
    reference_id: str
    display_name: str
    additional_fields: dict[str, str] = {}  # all other config columns


class BPWStep(BaseModel):
    process_name: str                     # e.g. "Request Leave of Absence"
    step_number: str                      # e.g. "4."
    step_type: str                        # "Workday" | "Non-Workday"
    step_name: str
    role: str
    description: str
    condition: str | None = None


class BPWProcess(BaseModel):
    process_name: str
    overview: str | None = None
    objective: str | None = None
    business_trigger: str | None = None
    approval_routes: list[dict] = []      # [{route, initiator, approvals, comments}]


class TestScenario(BaseModel):
    story_id: str                         # req/story/config item/process name
    scenario_id: str
    scenario_type: Literal["Positive", "Negative"]
    title: str
    description: str
    preconditions: list[str]


class TestStep(BaseModel):
    scenario_id: str
    step_id: str
    step_number: int
    action: str
    expected_result: str
    test_data: str | None = None


class PipelineResult(BaseModel):
    run_id: str
    input_filename: str
    input_type: InputType = InputType.requirements
    status: Literal["running", "completed", "failed"]
    requirements_count: int
    user_stories: list[UserStory] = []
    config_items: list[ConfigItem] = []
    bpw_steps: list[BPWStep] = []
    test_scenarios: list[TestScenario] = []
    test_steps: list[TestStep] = []
    error_message: str | None = None
    output_blob_url: str | None = None
