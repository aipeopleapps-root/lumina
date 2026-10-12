"""
test_automation/docx_reader.py::read_bpw() — regression suite covering both
recognized Business Process Workbook steps-table shapes.

Two independently-built apps produce ".docx BP Workbooks" with different
Section 7 column conventions (see docs/AZURE_MIGRATION.md's 2026-10-01 entry
for the full story): the native Test Automation Suite upload path expects
`#`/`Step Type`/`Step Name`/`Role`/... headers, while the ported BP Workbook
Generation app's `docxBuilder.js` emits `Step Order`/`Step`/`Type`/
`Description`/.../`Security Group` instead. Confirmed for real against an
actual docxBuilder.js-built .docx (not just these hand-built fixtures) before
this suite was written — see that same Log entry.
"""

from __future__ import annotations

import io

from docx import Document

from test_automation.docx_reader import read_bpw


def _add_table(doc, headers, rows):
    table = doc.add_table(rows=1, cols=len(headers))
    for cell, text in zip(table.rows[0].cells, headers):
        cell.text = text
    for row_values in rows:
        row = table.add_row()
        for cell, text in zip(row.cells, row_values):
            cell.text = text
    return table


def _build_native_tas_bpw() -> bytes:
    doc = Document()
    doc.add_heading("Process: Onboard New Hire", level=1)
    _add_table(
        doc,
        ["#", "Step Type", "Step Name", "Role", "Description", "Condition"],
        [
            ["1", "Action", "Submit Request", "Employee", "Fill out the form", ""],
            ["2", "Approval", "Approve Request", "Manager", "Review and approve", "If salary > 100k"],
            ["", "", "", "", "", ""],  # blank row — must be skipped
        ],
    )
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _build_bpw_gen_output() -> bytes:
    # Mirrors bp-workbook-api/src/lib/docxBuilder.js's actual Section
    # 2/4/7 table shapes (headers + column order), not an idealized guess —
    # verified against the real generator output before writing this.
    doc = Document()
    _add_table(
        doc,
        ["Process", "Process Definition"],
        [
            ["Overview", "<Insert overview>"],
            ["Objective", "<Insert objective>"],
        ],
    )
    _add_table(
        doc,
        ["Route", "Initiator", "1st Approval", "Comments"],
        [
            ["Primary Route", "Employee", "Manager", ""],
        ],
    )
    _add_table(
        doc,
        ["Step Order", "Step", "Type", "Description", "Condition Rules", "Security Group",
         "Routing Restrictions", "Optional?", "Due Date", "Step Delay", "Workday Step"],
        [
            ["A", "HR-010-010 Submit Request", "Action", "", "N/A", "Employee", "N/A", "No", "N/A", "N/A", "Yes"],
            ["B", "HR-010-020 Approve Request", "Approval", "", "N/A", "Manager", "N/A", "No", "N/A", "N/A", "Yes"],
            ["", "", "", "", "", "", "", "", "", "", ""],  # blank row — must be skipped
        ],
    )
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def test_native_tas_shape_extracts_steps_and_skips_blank_rows():
    steps, processes = read_bpw(_build_native_tas_bpw())

    assert [s["step_name"] for s in steps] == ["Submit Request", "Approve Request"]
    assert steps[0] == {
        "process_name": "Onboard New Hire",
        "step_number": "1",
        "step_type": "Action",
        "step_name": "Submit Request",
        "role": "Employee",
        "description": "Fill out the form",
        "condition": None,
    }
    assert steps[1]["condition"] == "If salary > 100k"
    assert processes == [{
        "process_name": "Onboard New Hire",
        "overview": None,
        "objective": None,
        "business_trigger": None,
        "approval_routes": [],
    }]


def test_bpw_generation_shape_extracts_steps_with_mapped_columns():
    steps, processes = read_bpw(_build_bpw_gen_output())

    assert len(steps) == 2  # the blank row must not produce a phantom step
    assert steps[0] == {
        "process_name": "Unknown Process",  # docxBuilder.js's cover page isn't a Word "Heading" style — see note below
        "step_number": "A",
        "step_type": "Action",
        "step_name": "HR-010-010 Submit Request",
        "role": "Employee",
        "description": "",
        "condition": None,
    }
    assert steps[1]["step_number"] == "B"
    assert steps[1]["role"] == "Manager"

    assert len(processes) == 1
    assert processes[0]["approval_routes"] == [{
        "route": "Primary Route", "initiator": "Employee",
        "first_approval": "Manager", "second_approval": "", "comments": "",
    }]


def test_bpw_generation_condition_na_normalizes_to_none():
    # "N/A" is docxBuilder.js's literal placeholder for "no condition" —
    # must come through as None, not the literal string, so downstream
    # scenario generation doesn't treat it as a real condition to branch on.
    doc_bytes = _build_bpw_gen_output()
    steps, _ = read_bpw(doc_bytes)
    assert all(s["condition"] is None for s in steps)
