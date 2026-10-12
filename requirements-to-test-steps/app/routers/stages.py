from __future__ import annotations

import asyncio
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.agents.config_scenarios import generate_config_scenarios
from app.agents.bpw_scenarios import generate_bpw_scenarios
from app.auth import AuthUser, get_current_user
from app.config import Settings, get_settings
from app.models import (
    BPWProcess,
    BPWStep,
    ConfigItem,
    InputType,
    PipelineResult,
    TestScenario,
    TestStep,
    UserStory,
)
from app.services.bpw_reader import read_bpw
from app.services.config_workbook_reader import read_config_workbook
from app.services.excel_reader import read_requirements, read_user_stories
from app.services.excel_writer import build_output_workbook
from app.services.input_detector import detect_input_type
from app.services.pipeline import (
    run_stage_test_scenarios,
    run_stage_test_steps,
    run_stage_user_stories,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/stage")

_MAX_CONCURRENT = 5


# ── Upload — detects input type and runs first-stage processing ───────────────

@router.post("/upload")
async def upload_and_stage1(
    file: UploadFile,
    settings: Settings = Depends(get_settings),
    current_user: AuthUser = Depends(get_current_user),
) -> dict:
    """
    Parse the uploaded file, detect its type, and run the appropriate first stage.

    Returns one of:
      - {input_type:"requirements"|"user_stories", user_stories:[...]}
      - {input_type:"config_workbook", config_items:[...]}
      - {input_type:"bpw", bpw_steps:[...], bpw_context:[...]}
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided.")

    lower = file.filename.lower()
    if not (lower.endswith(".xlsx") or lower.endswith(".docx")):
        raise HTTPException(status_code=400, detail="Only .xlsx and .docx files are accepted.")

    try:
        file_bytes = await file.read()
        input_type = detect_input_type(file.filename, file_bytes)
        run_id = str(uuid.uuid4())

        if input_type == InputType.bpw:
            bpw_steps, bpw_processes = await read_bpw(file_bytes)
            return {
                "run_id": run_id,
                "filename": file.filename,
                "input_type": input_type.value,
                "bpw_steps": [s.model_dump() for s in bpw_steps],
                "bpw_context": [p.model_dump() for p in bpw_processes],
            }

        if input_type == InputType.config_workbook:
            config_items = await read_config_workbook(file_bytes)
            return {
                "run_id": run_id,
                "filename": file.filename,
                "input_type": input_type.value,
                "config_items": [c.model_dump() for c in config_items],
            }

        if input_type == InputType.user_stories:
            user_stories = await read_user_stories(file_bytes)
            return {
                "run_id": run_id,
                "filename": file.filename,
                "input_type": input_type.value,
                "requirements_count": len(user_stories),
                "user_stories": [s.model_dump() for s in user_stories],
            }

        # Default: requirements — run Agent 1
        requirements = await read_requirements(file_bytes)
        user_stories = await run_stage_user_stories(requirements, settings)
        return {
            "run_id": run_id,
            "filename": file.filename,
            "input_type": input_type.value,
            "requirements_count": len(requirements),
            "user_stories": [s.model_dump() for s in user_stories],
        }

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("Stage 1 failed for %s", file.filename)
        raise HTTPException(status_code=500, detail=str(exc))


# ── Scenarios — handles user_stories, config_items, or bpw_steps ─────────────

class Stage2Request(BaseModel):
    input_type: str = "requirements"
    user_stories: list[UserStory] = []
    config_items: list[ConfigItem] = []
    bpw_steps: list[BPWStep] = []
    bpw_context: list[BPWProcess] = []


@router.post("/scenarios")
async def stage2(
    body: Stage2Request,
    settings: Settings = Depends(get_settings),
    current_user: AuthUser = Depends(get_current_user),
) -> dict:
    """Generate test scenarios from whichever first-stage data was accepted."""
    try:
        itype = InputType(body.input_type)

        if itype == InputType.config_workbook:
            semaphore = asyncio.Semaphore(_MAX_CONCURRENT)
            logger.info("Stage 2 (config): generating scenarios for %d items", len(body.config_items))

            async def _cfg_task(item: ConfigItem) -> list[TestScenario]:
                async with semaphore:
                    return await generate_config_scenarios(item, settings)

            nested = list(await asyncio.gather(*[_cfg_task(c) for c in body.config_items]))
            scenarios = _assign_scenario_ids(nested)
            return {"test_scenarios": [sc.model_dump() for sc in scenarios]}

        if itype == InputType.bpw:
            semaphore = asyncio.Semaphore(_MAX_CONCURRENT)
            logger.info("Stage 2 (bpw): generating scenarios for %d processes", len(body.bpw_context))

            # Group steps by process_name for passing to the agent
            steps_by_process: dict[str, list[BPWStep]] = {}
            for step in body.bpw_steps:
                steps_by_process.setdefault(step.process_name, []).append(step)

            async def _bpw_task(proc: BPWProcess) -> list[TestScenario]:
                async with semaphore:
                    steps = steps_by_process.get(proc.process_name, [])
                    return await generate_bpw_scenarios(proc, steps, settings)

            nested = list(await asyncio.gather(*[_bpw_task(p) for p in body.bpw_context]))
            scenarios = _assign_scenario_ids(nested)
            return {"test_scenarios": [sc.model_dump() for sc in scenarios]}

        # requirements or user_stories — use existing Agent 2
        test_scenarios = await run_stage_test_scenarios(body.user_stories, settings)
        return {"test_scenarios": [sc.model_dump() for sc in test_scenarios]}

    except Exception as exc:
        logger.exception("Stage 2 failed")
        raise HTTPException(status_code=500, detail=str(exc))


def _assign_scenario_ids(nested: list[list[TestScenario]]) -> list[TestScenario]:
    """Flatten nested scenario lists and assign sequential TS-NNN IDs."""
    result: list[TestScenario] = []
    counter = 1
    for group in nested:
        for sc in group:
            result.append(TestScenario(
                story_id=sc.story_id,
                scenario_id=f"TS-{counter:03d}",
                scenario_type=sc.scenario_type,
                title=sc.title,
                description=sc.description,
                preconditions=sc.preconditions,
            ))
            counter += 1
    return result


# ── Steps ─────────────────────────────────────────────────────────────────────

class Stage3Request(BaseModel):
    test_scenarios: list[TestScenario]


@router.post("/steps")
async def stage3(
    body: Stage3Request,
    settings: Settings = Depends(get_settings),
    current_user: AuthUser = Depends(get_current_user),
) -> dict:
    """Run Agent 3 (Test Steps) — identical for all input types."""
    try:
        test_steps = await run_stage_test_steps(body.test_scenarios, settings)
        return {"test_steps": [s.model_dump() for s in test_steps]}
    except Exception as exc:
        logger.exception("Stage 3 failed")
        raise HTTPException(status_code=500, detail=str(exc))


# ── Export ────────────────────────────────────────────────────────────────────

class ExportRequest(BaseModel):
    run_id: str
    filename: str
    input_type: str = "requirements"
    user_stories: list[UserStory] = []
    config_items: list[ConfigItem] = []
    bpw_steps: list[BPWStep] = []
    test_scenarios: list[TestScenario]
    test_steps: list[TestStep]
    workstream: str = ""
    wave: str = ""


@router.post("/export")
async def export_excel(
    body: ExportRequest,
    settings: Settings = Depends(get_settings),
    current_user: AuthUser = Depends(get_current_user),
) -> StreamingResponse:
    """Build and stream the three-sheet Excel; also persist to blob + Cosmos."""
    itype = InputType(body.input_type)
    result = PipelineResult(
        run_id=body.run_id,
        input_filename=body.filename,
        input_type=itype,
        status="completed",
        requirements_count=len(body.user_stories) or len(body.config_items) or len(body.bpw_steps),
        user_stories=body.user_stories,
        config_items=body.config_items,
        bpw_steps=body.bpw_steps,
        test_scenarios=body.test_scenarios,
        test_steps=body.test_steps,
    )
    output_bytes = build_output_workbook(result)

    # ── Generate friendly run name + file name ────────────────────────────────
    from app.services.cosmos_store import build_run_document, make_file_name, make_run_name, save_run
    run_name = make_run_name(body.workstream, body.wave, body.input_type)
    file_name = make_file_name(body.workstream, body.wave, body.input_type)

    # ── Upload to Azure Blob Storage ──────────────────────────────────────────
    blob_url: str | None = None
    try:
        from app.services.blob_storage import upload_bytes
        blob_name = f"{body.run_id}/results.xlsx"
        blob_url = await upload_bytes(
            output_bytes,
            blob_name=blob_name,
            container=settings.AZURE_STORAGE_OUTPUT_CONTAINER,
            settings=settings,
        )
    except Exception as exc:
        logger.warning("Blob upload failed (export still completes): %s", exc)

    # ── Save run record to Cosmos ─────────────────────────────────────────────
    if settings.USE_COSMOS:
        doc = build_run_document(
            run_id=body.run_id,
            project_id=settings.PROJECT_ID,
            input_type=body.input_type,
            filename=body.filename,
            workstream=body.workstream,
            wave=body.wave,
            requirements_count=result.requirements_count,
            test_scenarios_count=len(body.test_scenarios),
            test_steps_count=len(body.test_steps),
            output_blob_url=blob_url,
            run_name=run_name,
            file_name=file_name,
            user_id=current_user.user_id,
        )
        await save_run(doc, settings)

    return StreamingResponse(
        iter([output_bytes]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{file_name}"'},
    )


@router.get("/runs")
async def get_recent_runs(settings: Settings = Depends(get_settings), current_user: AuthUser = Depends(get_current_user)) -> list[dict]:
    """Return recent pipeline runs for the current project from Cosmos."""
    if not settings.USE_COSMOS:
        return []
    from app.services.cosmos_store import get_project_runs
    return await get_project_runs(settings.PROJECT_ID, current_user.user_id, settings)


@router.get("/download/{run_id}")
async def download_run(
    run_id: str,
    fn: str | None = Query(None, description="Download filename (passed by UI)"),
    settings: Settings = Depends(get_settings),
    current_user: AuthUser = Depends(get_current_user),
) -> StreamingResponse:
    """Re-download the Excel for a previous run directly from blob storage."""
    try:
        from app.services.blob_storage import download_bytes
        blob_name = f"{run_id}/results.xlsx"
        data = await download_bytes(
            blob_name=blob_name,
            container=settings.AZURE_STORAGE_OUTPUT_CONTAINER,
            settings=settings,
        )
    except Exception as exc:
        logger.warning("Blob download failed for run %s: %s", run_id, exc)
        raise HTTPException(status_code=404, detail=f"Results for run {run_id[:8]} not found in storage.")
    filename = fn if fn else f"results-{run_id[:8]}.xlsx"
    return StreamingResponse(
        iter([data]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
