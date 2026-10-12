from __future__ import annotations

import io
import logging
from typing import Any

import openpyxl

from app.models import ConfigItem

logger = logging.getLogger(__name__)

# Sheets to skip — instructions/navigation only
_SKIP_SHEETS = {"coversheet", "instructions & contents", "staging >>>", "output >>>", "sheet20"}

# Actions that warrant test scripts; Keep and Sample do not
_TESTABLE_ACTIONS = {"add", "update", "remove"}


def _norm(value: Any) -> str:
    return str(value).strip().lower() if value is not None else ""


def _find_header_row(ws: Any) -> tuple[int, int, list[str]] | None:
    """
    Scan rows 1–25 for the actual column header row.
    Criteria: contains 'setup' or 'action' in the first five columns AND has ≥3 non-empty cells.
    This skips section-header rows (e.g. row 6 in Time Off Plans) which only have 1–2 values.
    Returns (row_index, action_col_index, header_list) or None.
    """
    for row_idx, row in enumerate(ws.iter_rows(min_row=1, max_row=25, values_only=True)):
        non_empty = sum(1 for c in row if c is not None and str(c).strip())
        if non_empty < 3:
            continue
        for col_idx in range(min(5, len(row))):
            cell = _norm(row[col_idx])
            if cell in ("setup", "action"):
                # Require the immediately adjacent column to also be non-empty.
                # This rules out sparse section-header rows (e.g. Time Off Plans row 6)
                # where "SETUP" sits at col 1 and the next populated cell is at col 29.
                next_col = col_idx + 1
                if next_col >= len(row) or row[next_col] is None or not str(row[next_col]).strip():
                    continue
                headers = [str(v).strip() if v is not None else "" for v in row]
                return row_idx, col_idx, headers
    return None


def _pick_display_name(row: tuple, headers: list[str], action_col: int, ref_col: int) -> str:
    """
    Heuristic: find the first header after action/ref columns whose name contains
    'name' or 'type', then fall back to the column immediately after ref_col.
    """
    priority_cols = [
        i for i, h in enumerate(headers)
        if i not in (action_col, ref_col) and i < len(row)
        and ("name" in h.lower() or "type" in h.lower())
        and row[i] is not None
        and str(row[i]).strip()
    ]
    if priority_cols:
        return str(row[priority_cols[0]]).strip()

    next_col = ref_col + 1
    if next_col < len(row) and row[next_col] is not None:
        return str(row[next_col]).strip()
    return ""


def _find_ref_col(headers: list[str]) -> int | None:
    """Return index of the first column whose header starts with 'reference id'."""
    for i, h in enumerate(headers):
        if h.lower().startswith("reference id"):
            return i
    return None


def _parse_sheet(ws: Any, sheet_name: str, counter: list[int]) -> list[ConfigItem]:
    """Extract testable config rows from a single worksheet."""
    result = _find_header_row(ws)
    if result is None:
        logger.debug("No header row found in sheet '%s' — skipping", sheet_name)
        return []

    header_row_idx, action_col, headers = result
    ref_col = _find_ref_col(headers)

    items: list[ConfigItem] = []
    for row in ws.iter_rows(min_row=header_row_idx + 2, values_only=True):
        # Blank row guard
        if all(c is None or str(c).strip() == "" for c in row):
            continue

        action_raw = row[action_col] if action_col < len(row) else None
        if action_raw is None:
            continue
        action = str(action_raw).strip()
        if action.lower() not in _TESTABLE_ACTIONS:
            continue

        display_name = _pick_display_name(row, headers, action_col, ref_col or 0)

        # Reference ID — fall back to display name slug if cell is blank
        ref_id = ""
        if ref_col is not None and ref_col < len(row) and row[ref_col] is not None:
            ref_id = str(row[ref_col]).strip()
        if not ref_id:
            ref_id = display_name.upper().replace(" ", "_") if display_name else f"UNKNOWN_ROW_{counter[0]}"

        # Collect remaining non-empty fields as additional context for the LLM
        additional: dict[str, str] = {}
        for col_idx, (header, cell) in enumerate(zip(headers, row)):
            if col_idx in (action_col, ref_col):
                continue
            if header and cell is not None and str(cell).strip():
                val = str(cell).strip()
                # Skip very long instruction-style text (>200 chars = instruction, not data)
                if len(val) <= 200:
                    additional[header] = val

        item_id = f"CFG-{counter[0]:03d}"
        counter[0] += 1

        items.append(
            ConfigItem(
                item_id=item_id,
                sheet_name=sheet_name,
                action=action,
                reference_id=ref_id,
                display_name=display_name or ref_id,
                additional_fields=additional,
            )
        )

    return items


async def read_config_workbook(file_bytes: bytes) -> list[ConfigItem]:
    """
    Parse an Absence Configuration Workbook xlsx and return testable ConfigItems.
    Only Add, Update, and Remove rows are included (Keep and Sample are skipped).
    """
    wb = openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True)
    counter = [1]  # mutable counter shared across sheets
    all_items: list[ConfigItem] = []

    for sheet_name in wb.sheetnames:
        if sheet_name.lower() in _SKIP_SHEETS:
            continue
        ws = wb[sheet_name]
        items = _parse_sheet(ws, sheet_name, counter)
        if items:
            logger.info("Sheet '%s': found %d testable config items", sheet_name, len(items))
        all_items.extend(items)

    logger.info("Config workbook total: %d testable items across %d sheets", len(all_items), len(wb.sheetnames))
    return all_items
