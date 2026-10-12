from __future__ import annotations

import io

import openpyxl
import pytest

from app.services.excel_reader import read_requirements


def _make_xlsx(headers: list, rows: list[list]) -> bytes:
    """Helper: build an xlsx bytes buffer from headers + rows."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(headers)
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


@pytest.mark.asyncio
async def test_happy_path_reads_all_columns() -> None:
    """All four columns present — parsed correctly."""
    data = _make_xlsx(
        ["Requirement ID", "Requirement", "Module", "Priority"],
        [
            ["REQ-001", "Employees can submit leave requests.", "Workday HCM", "High"],
            ["REQ-002", "Payroll deductions are calculated automatically.", "Payroll", "Medium"],
        ],
    )
    reqs = await read_requirements(data)
    assert len(reqs) == 2
    assert reqs[0].requirement_id == "REQ-001"
    assert reqs[0].requirement_text == "Employees can submit leave requests."
    assert reqs[0].module == "Workday HCM"
    assert reqs[0].priority == "High"
    assert reqs[1].requirement_id == "REQ-002"


@pytest.mark.asyncio
async def test_auto_generates_requirement_id_when_column_absent() -> None:
    """Missing Requirement ID → auto-generate REQ-{row_number:03d}."""
    data = _make_xlsx(
        ["Requirement", "Module"],
        [
            ["Allow leave requests.", "HCM"],
            ["Generate payroll reports.", "Payroll"],
        ],
    )
    reqs = await read_requirements(data)
    assert len(reqs) == 2
    # Row 2 and 3 in the worksheet (row 1 is header)
    assert reqs[0].requirement_id == "REQ-002"
    assert reqs[1].requirement_id == "REQ-003"


@pytest.mark.asyncio
async def test_auto_generates_id_when_column_present_but_empty() -> None:
    """Requirement ID column exists but cells are empty → auto-generate."""
    data = _make_xlsx(
        ["Requirement ID", "Requirement"],
        [
            ["", "Allow leave requests."],
            [None, "Generate payroll reports."],
        ],
    )
    reqs = await read_requirements(data)
    assert len(reqs) == 2
    assert reqs[0].requirement_id == "REQ-002"
    assert reqs[1].requirement_id == "REQ-003"


@pytest.mark.asyncio
async def test_raises_value_error_when_requirement_column_missing() -> None:
    """No 'Requirement' column → ValueError."""
    data = _make_xlsx(
        ["Requirement ID", "Module", "Priority"],
        [["REQ-001", "HCM", "High"]],
    )
    with pytest.raises(ValueError, match="Requirement"):
        await read_requirements(data)


@pytest.mark.asyncio
async def test_skips_blank_rows(sample_xlsx_bytes: bytes) -> None:
    """Blank rows are skipped; only rows with requirement text are returned."""
    reqs = await read_requirements(sample_xlsx_bytes)
    # conftest fixture has 3 data rows + 1 blank row
    assert len(reqs) == 3
    for req in reqs:
        assert req.requirement_text.strip() != ""


@pytest.mark.asyncio
async def test_case_insensitive_headers() -> None:
    """Headers are matched case-insensitively."""
    data = _make_xlsx(
        ["requirement id", "REQUIREMENT", "Module", "priority"],
        [["REQ-001", "Test requirement.", "HCM", "Low"]],
    )
    reqs = await read_requirements(data)
    assert len(reqs) == 1
    assert reqs[0].requirement_id == "REQ-001"
    assert reqs[0].priority == "Low"
