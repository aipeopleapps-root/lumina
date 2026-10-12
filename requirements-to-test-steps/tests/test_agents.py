from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.agents.test_scenarios import generate_test_scenarios
from app.agents.test_steps import generate_test_steps
from app.agents.user_stories import generate_user_story
from app.config import Settings
from app.models import Requirement, TestScenario, UserStory


@pytest.fixture()
def settings() -> Settings:
    return Settings(
        LLM_GATEWAY_URL="http://fake-gateway/v1/chat/completions",
        LLM_GATEWAY_API_KEY="fake-key",
        AZURE_STORAGE_ACCOUNT_URL="http://fake-storage",
        USE_MANAGED_IDENTITY=False,
        AZURE_STORAGE_CONNECTION_STRING="fake-conn-str",
    )


@pytest.fixture()
def sample_requirement() -> Requirement:
    return Requirement(
        row_number=2,
        requirement_id="REQ-001",
        requirement_text="Employees shall be able to submit leave requests online.",
        module="Workday HCM",
        priority="High",
    )


@pytest.fixture()
def sample_user_story() -> UserStory:
    return UserStory(
        requirement_id="REQ-001",
        story_id="US-001",
        as_a="an employee",
        i_want="to submit leave requests online",
        so_that="I can manage my leave without visiting HR in person",
        acceptance_criteria=[
            "I can access the leave request form from the employee portal",
            "I can select leave type and dates",
            "I receive a confirmation email on submission",
        ],
    )


@pytest.fixture()
def sample_scenario() -> TestScenario:
    return TestScenario(
        story_id="US-001",
        scenario_id="TS-001",
        scenario_type="Positive",
        title="Successful leave request submission",
        description="Verify that an employee can successfully submit a leave request",
        preconditions=["Employee is logged in", "Employee has sufficient leave balance"],
    )


# ── Agent 1 tests ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_agent1_returns_correct_user_story(
    settings: Settings,
    sample_requirement: Requirement,
) -> None:
    """Agent 1 should return a correctly structured UserStory."""
    mock_response = {
        "story_id": "US-001",
        "as_a": "an employee",
        "i_want": "to submit leave requests online",
        "so_that": "I can manage my leave without HR",
        "acceptance_criteria": ["Can access portal", "Can select dates"],
    }
    with patch("app.agents.user_stories.call_llm", new=AsyncMock(return_value=mock_response)):
        story = await generate_user_story(sample_requirement, settings)

    assert story.requirement_id == "REQ-001"
    assert story.story_id == "US-001"
    assert story.as_a == "an employee"
    assert story.i_want == "to submit leave requests online"
    assert story.so_that == "I can manage my leave without HR"
    assert len(story.acceptance_criteria) == 2


# ── Agent 2 tests ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_agent2_returns_two_scenarios(
    settings: Settings,
    sample_user_story: UserStory,
) -> None:
    """Agent 2 should return exactly 2 scenarios: one positive, one negative."""
    mock_response = {
        "scenarios": [
            {
                "scenario_id": "TS-001",
                "scenario_type": "Positive",
                "title": "Successful submission",
                "description": "Happy path for leave submission",
                "preconditions": ["Logged in", "Has leave balance"],
            },
            {
                "scenario_id": "TS-002",
                "scenario_type": "Negative",
                "title": "Insufficient leave balance",
                "description": "Attempt to submit with no balance",
                "preconditions": ["Logged in", "No leave balance"],
            },
        ]
    }
    with patch("app.agents.test_scenarios.call_llm", new=AsyncMock(return_value=mock_response)):
        scenarios = await generate_test_scenarios(sample_user_story, settings)

    assert len(scenarios) == 2
    types = {s.scenario_type for s in scenarios}
    assert "Positive" in types
    assert "Negative" in types
    for scenario in scenarios:
        assert scenario.story_id == "US-001"


# ── Agent 3 tests ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_agent3_returns_sequential_step_numbers(
    settings: Settings,
    sample_scenario: TestScenario,
) -> None:
    """Agent 3 should return steps with sequential step numbers."""
    mock_response = {
        "steps": [
            {"step_number": 1, "action": "Navigate to leave portal", "expected_result": "Portal loads", "test_data": None},
            {"step_number": 2, "action": "Fill in leave type and dates", "expected_result": "Form accepted", "test_data": "Annual Leave, 2025-01-06"},
            {"step_number": 3, "action": "Click Submit", "expected_result": "Confirmation email sent", "test_data": None},
        ]
    }
    with patch("app.agents.test_steps.call_llm", new=AsyncMock(return_value=mock_response)):
        steps = await generate_test_steps(sample_scenario, settings)

    assert len(steps) == 3
    for i, step in enumerate(steps, start=1):
        assert step.step_number == i
        assert step.scenario_id == "TS-001"
    # Verify step_id format
    assert steps[0].step_id == "TS-001-001"
    assert steps[1].step_id == "TS-001-002"
    assert steps[2].step_id == "TS-001-003"


# ── Retry logic tests ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_retry_fires_on_429(settings: Settings) -> None:
    """call_llm should retry on HTTP 429 and succeed on the third attempt."""
    good_response_body = {
        "choices": [{"message": {"content": '{"key": "value"}'}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
    }

    call_count = 0

    async def _mock_post(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            return httpx.Response(429, text="rate limited")
        return httpx.Response(200, json=good_response_body)

    with patch("app.agents.base.asyncio.sleep", new=AsyncMock()):
        with patch("httpx.AsyncClient.post", new=AsyncMock(side_effect=_mock_post)):
            from app.agents.base import call_llm
            result = await call_llm("sys", "user", settings)

    assert call_count == 3
    assert result == {"key": "value"}


@pytest.mark.asyncio
async def test_retry_exhausted_raises_runtime_error(settings: Settings) -> None:
    """call_llm raises RuntimeError after all 3 retry attempts return 429."""
    async def _always_429(*args, **kwargs):
        return httpx.Response(429, text="rate limited")

    with patch("app.agents.base.asyncio.sleep", new=AsyncMock()):
        with patch("httpx.AsyncClient.post", new=AsyncMock(side_effect=_always_429)):
            from app.agents.base import call_llm
            with pytest.raises(RuntimeError, match="429"):
                await call_llm("sys", "user", settings)
