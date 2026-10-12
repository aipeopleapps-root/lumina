from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

from app.config import Settings, get_settings
from app.services.blob_storage import upload_bytes
from app.services.excel_reader import read_requirements
from app.services.excel_writer import build_output_workbook
from app.services.pipeline import run_pipeline

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/run/download")
async def run_and_download(
    file: UploadFile,
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    """Run the pipeline and stream the output Excel back — no blob storage needed."""
    run_id = str(uuid.uuid4())

    if not file.filename or not file.filename.lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Only .xlsx files are accepted.")

    try:
        file_bytes = await file.read()
        requirements = await read_requirements(file_bytes)

        pipeline_result = await run_pipeline(
            requirements=requirements,
            run_id=run_id,
            settings=settings,
            input_filename=file.filename,
        )

        output_bytes = build_output_workbook(pipeline_result)

        return StreamingResponse(
            iter([output_bytes]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename=results-{run_id[:8]}.xlsx"},
        )

    except ValueError as exc:
        logger.warning("Validation error for run %s: %s", run_id, exc)
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        logger.exception("Pipeline failed for run %s", run_id)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/run")
async def run_endpoint(
    file: UploadFile,
    settings: Settings = Depends(get_settings),
) -> JSONResponse:
    """Accept an .xlsx requirements file, run the AI pipeline, upload to blob storage."""
    run_id = str(uuid.uuid4())

    if not file.filename or not file.filename.lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="Only .xlsx files are accepted.")

    try:
        file_bytes = await file.read()
        requirements = await read_requirements(file_bytes)

        pipeline_result = await run_pipeline(
            requirements=requirements,
            run_id=run_id,
            settings=settings,
            input_filename=file.filename,
        )

        output_bytes = build_output_workbook(pipeline_result)
        blob_name = f"{run_id}/results.xlsx"
        output_url = await upload_bytes(
            data=output_bytes,
            blob_name=blob_name,
            container=settings.AZURE_STORAGE_OUTPUT_CONTAINER,
            settings=settings,
        )

        pipeline_result.output_blob_url = output_url

        return JSONResponse(
            content={
                "run_id": run_id,
                "status": "completed",
                "requirements_count": pipeline_result.requirements_count,
                "output_blob_url": output_url,
                "summary": {
                    "user_stories": len(pipeline_result.user_stories),
                    "test_scenarios": len(pipeline_result.test_scenarios),
                    "test_steps": len(pipeline_result.test_steps),
                },
            }
        )

    except ValueError as exc:
        logger.warning("Validation error for run %s: %s", run_id, exc)
        return JSONResponse(status_code=400, content={"error": str(exc), "run_id": run_id})
    except Exception as exc:
        logger.exception("Pipeline failed for run %s", run_id)
        return JSONResponse(status_code=500, content={"error": str(exc), "run_id": run_id})
