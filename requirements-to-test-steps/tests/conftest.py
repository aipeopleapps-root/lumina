from __future__ import annotations

import io
import os

import openpyxl
import pytest


@pytest.fixture(scope="session", autouse=True)
def sample_requirements_xlsx(tmp_path_factory: pytest.TempPathFactory) -> str:
    """Generate a sample_requirements.xlsx fixture file and return its path."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Requirements"
    ws.append(["Requirement ID", "Requirement", "Module", "Priority"])
    ws.append(["REQ-001", "The system shall allow employees to submit leave requests online.", "Workday HCM", "High"])
    ws.append(["REQ-002", "The system shall automatically calculate payroll deductions.", "Payroll", "High"])
    ws.append(["REQ-003", "The system shall generate monthly payroll reports.", "Payroll", "Medium"])

    fixtures_dir = os.path.dirname(__file__)
    out_path = os.path.join(fixtures_dir, "sample_requirements.xlsx")
    wb.save(out_path)
    return out_path


@pytest.fixture()
def sample_xlsx_bytes() -> bytes:
    """Return the bytes of a minimal requirements xlsx."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Requirement ID", "Requirement", "Module", "Priority"])
    ws.append(["REQ-001", "Allow employees to submit leave requests online.", "Workday HCM", "High"])
    ws.append(["REQ-002", "Automatically calculate payroll deductions.", "Payroll", "Medium"])
    ws.append(["", "Generate monthly payroll reports.", None, None])  # auto-generate ID
    ws.append([None, None, None, None])  # blank row — should be skipped
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
