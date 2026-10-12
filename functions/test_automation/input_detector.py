"""
Ported near-verbatim from requirements-to-test-steps/app/services/input_detector.py.
Sync (no asyncio — Azure Functions handlers here are plain blocking calls),
returns the plain string values test_automation.runs.input_type's CHECK
constraint expects instead of the source app's InputType enum.
"""

from __future__ import annotations

import io
import logging

import openpyxl

from . import xlsx_reader

log = logging.getLogger(__name__)

# Column header fingerprints for a User Stories Excel
_USER_STORY_COLS = {"as a", "i want", "so that"}


def _normalise(value: object) -> str:
    return str(value).strip().lower() if value is not None else ""


def detect_input_type(filename: str, file_bytes: bytes) -> str:
    """
    Infer the input type from the filename extension and workbook content.

    Detection order:
    1. .docx extension -> bpw
    2. .xlsx with a Setup/Action structure and testable rows -> config_workbook
    3. .xlsx with 'As a' / 'I want' / 'So that' columns -> user_stories
    4. .xlsx with 'Requirement' column (or fallback) -> requirements
    """
    lower_name = filename.lower()

    if lower_name.endswith(".docx"):
        log.info("Detected input type: bpw (docx extension)")
        return "bpw"

    if lower_name.endswith(".xlsx"):
        try:
            wb = openpyxl.load_workbook(io.BytesIO(file_bytes), read_only=True, data_only=True)
            try:
                if xlsx_reader.has_config_structure(wb):
                    log.info("Detected input type: config_workbook (Setup/Action structure)")
                    return "config_workbook"

                ws = wb.active
                first_row = next(ws.iter_rows(min_row=1, max_row=1, values_only=True), ())
                headers = {_normalise(c) for c in first_row if c is not None}
                if _USER_STORY_COLS.issubset(headers):
                    log.info("Detected input type: user_stories (column headers)")
                    return "user_stories"
            finally:
                wb.close()

        except Exception as exc:
            log.warning("Could not inspect xlsx for type detection: %s", exc)

        log.info("Detected input type: requirements (default xlsx)")
        return "requirements"

    log.warning("Unrecognised file extension for '%s', defaulting to requirements", filename)
    return "requirements"
