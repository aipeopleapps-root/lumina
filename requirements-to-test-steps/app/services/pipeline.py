from __future__ import annotations

import asyncio
import logging

from app.agents.test_scenarios import generate_test_scenarios
from app.agents.test_steps import generate_test_steps
from app.agents.user_stories import generate_user_story
from app.config import Settings
from app.models import PipelineResult, Requirement, TestScenario, TestStep, UserStory

logger = logging.getLogger(__name__)

_MAX_CONCURRENT = 5


async def run_stage_user_stories(
    requirements: list[Requirement],
    settings: Settings,
) -> list[UserStory]:
    """Stage 1: Generate and ID-assign user stories from requirements."""
    semaphore = asyncio.Semaphore(_MAX_CONCURRENT)
    logger.info("Stage 1/3: generating user stories for %d requirements", len(requirements))

    async def _task(req: Requirement) -> UserStory:
        async with semaphore:
            return await generate_user_story(req, settings)

    raw = list(await asyncio.gather(*[_task(r) for r in requirements]))
    return [
        UserStory(
            requirement_id=s.requirement_id,
            story_id=f"US-{idx:03d}",
            as_a=s.as_a,
            i_want=s.i_want,
            so_that=s.so_that,
            acceptance_criteria=s.acceptance_criteria,
        )
        for idx, s in enumerate(raw, start=1)
    ]


async def run_stage_test_scenarios(
    user_stories: list[UserStory],
    settings: Settings,
) -> list[TestScenario]:
    """Stage 2: Generate and ID-assign test scenarios from user stories."""
    semaphore = asyncio.Semaphore(_MAX_CONCURRENT)
    logger.info("Stage 2/3: generating test scenarios for %d user stories", len(user_stories))

    async def _task(story: UserStory) -> list[TestScenario]:
        async with semaphore:
            return await generate_test_scenarios(story, settings)

    nested = list(await asyncio.gather(*[_task(s) for s in user_stories]))
    result: list[TestScenario] = []
    counter = 1
    for group in nested:
        for sc in group:
            result.append(
                TestScenario(
                    story_id=sc.story_id,
                    scenario_id=f"TS-{counter:03d}",
                    scenario_type=sc.scenario_type,
                    title=sc.title,
                    description=sc.description,
                    preconditions=sc.preconditions,
                )
            )
            counter += 1
    return result


async def run_stage_test_steps(
    test_scenarios: list[TestScenario],
    settings: Settings,
) -> list[TestStep]:
    """Stage 3: Generate and ID-assign test steps from test scenarios."""
    semaphore = asyncio.Semaphore(_MAX_CONCURRENT)
    logger.info("Stage 3/3: generating test steps for %d scenarios", len(test_scenarios))

    async def _task(scenario: TestScenario) -> list[TestStep]:
        async with semaphore:
            return await generate_test_steps(scenario, settings)

    nested = list(await asyncio.gather(*[_task(sc) for sc in test_scenarios]))
    result: list[TestStep] = []
    for group in nested:
        for step in group:
            result.append(
                TestStep(
                    scenario_id=step.scenario_id,
                    step_id=f"{step.scenario_id}-{step.step_number:03d}",
                    step_number=step.step_number,
                    action=step.action,
                    expected_result=step.expected_result,
                    test_data=step.test_data,
                )
            )
    return result


async def run_pipeline(
    requirements: list[Requirement],
    run_id: str,
    settings: Settings,
    input_filename: str = "uploaded.xlsx",
) -> PipelineResult:
    """Orchestrate the full three-agent pipeline and return a PipelineResult."""
    user_stories = await run_stage_user_stories(requirements, settings)
    test_scenarios = await run_stage_test_scenarios(user_stories, settings)
    test_steps = await run_stage_test_steps(test_scenarios, settings)

    logger.info(
        "Pipeline complete: %d stories, %d scenarios, %d steps",
        len(user_stories), len(test_scenarios), len(test_steps),
    )

    return PipelineResult(
        run_id=run_id,
        input_filename=input_filename,
        status="completed",
        requirements_count=len(requirements),
        user_stories=user_stories,
        test_scenarios=test_scenarios,
        test_steps=test_steps,
    )
