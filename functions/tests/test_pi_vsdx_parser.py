"""
pi_parse/handler.py's .vsdx parser — regression suite for the "no shapes
found in diagram" false negative on real, valid Visio swimlane exports.

Root cause (see handler.py's "Visio XML parser" section for the full
writeup): the old parser only recursed one level into Group shapes, treated
XML nesting as swimlane membership (real Visio swimlane exports don't nest
tasks inside their lane shapes at all — lanes are decorative backgrounds;
membership is spatial), and took only a shape's own first <Text> hit instead
of merging a composite node's full text. This suite exercises the fix
against three fixtures, each covering a materially different .vsdx shape:

- job_requisition_swimlane.vsdx — the reference fixture attached to this
  task: a real Workday-style swimlane export (Visio "Cross Functional
  Flowchart" template) with masters.xml-driven classification, 82 of 179
  shapes at the true page root, composite Task/IntegrationNode groups whose
  code+description live in a <Section N="Property"> Shape Data block, and
  connector-mediated edges (a Dynamic connector shape with two <Connect>
  rows, one per endpoint). All expected counts below were independently
  verified against the fixture's raw XML, not copied from the task
  description's approximate figures.
- A hand-built minimal fixture (built in-memory by this file, not
  committed as a binary) — no masters.xml, no pages.xml, no nested Group
  shapes at all: five flat top-level shapes connected directly node-to-node
  with no mediating connector shape. Confirms the parser isn't over-fit to
  the swimlane case and that every fallback path (page-part resolution
  without pages.xml, Type-attribute role classification with no masters.xml,
  Pattern-B direct connects) works on its own.
- docs/GlobalBank_Onboarding_Process.vsdx — a second real file already in
  this repo; a smoke test only (extracts without crashing, right node/edge
  counts, no dropped text), not a strict lane-assignment test — this
  particular file was hand-built without the LocPinX/LocPinY cells a real
  Visio export always emits, so its own nested-shape coordinates don't
  follow genuine Visio group-relative semantics and aren't reliable ground
  truth for that specific assertion.
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest

import pi_parse.handler as handler

_FIXTURES = Path(__file__).parent / "fixtures" / "pi_vsdx"
_JOB_REQUISITION = _FIXTURES / "job_requisition_swimlane.vsdx"
_GLOBALBANK = Path(__file__).parent.parent.parent / "docs" / "GlobalBank_Onboarding_Process.vsdx"


def _zip_with(*, page_xml: str, masters_xml: str | None = None,
              pages_xml: str | None = None, pages_rels_xml: str | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("visio/pages/page1.xml", page_xml)
        if masters_xml is not None:
            zf.writestr("visio/masters/masters.xml", masters_xml)
        if pages_xml is not None:
            zf.writestr("visio/pages/pages.xml", pages_xml)
        if pages_rels_xml is not None:
            zf.writestr("visio/pages/_rels/pages.xml.rels", pages_rels_xml)
    return buf.getvalue()


def _minimal_flat_vsdx() -> bytes:
    """No masters.xml, no pages.xml, no Group shapes anywhere — five flat
    top-level shapes (Start, two Tasks, a Decision, End) connected directly
    node-to-node via <Connect>, no mediating connector shape."""
    page_xml = """<?xml version="1.0" encoding="utf-8"?>
<PageContents xmlns="http://schemas.microsoft.com/office/visio/2012/main">
  <Shapes>
    <Shape ID="1" Type="Start"><Cell N="PinX" V="1.0"/><Cell N="PinY" V="5.0"/><Text>Start</Text></Shape>
    <Shape ID="2"><Cell N="PinX" V="3.0"/><Cell N="PinY" V="5.0"/><Text>Receive request</Text></Shape>
    <Shape ID="3" Type="Decision"><Cell N="PinX" V="5.0"/><Cell N="PinY" V="5.0"/><Text>Approved?</Text></Shape>
    <Shape ID="4"><Cell N="PinX" V="7.0"/><Cell N="PinY" V="5.0"/><Text>Process request</Text></Shape>
    <Shape ID="5" Type="End"><Cell N="PinX" V="9.0"/><Cell N="PinY" V="5.0"/><Text>End</Text></Shape>
  </Shapes>
  <Connects>
    <Connect FromSheet="1" FromCell="EndX" ToSheet="2" ToCell="BeginX"/>
    <Connect FromSheet="2" FromCell="EndX" ToSheet="3" ToCell="BeginX"/>
    <Connect FromSheet="3" FromCell="EndX" ToSheet="4" ToCell="BeginX"/>
    <Connect FromSheet="4" FromCell="EndX" ToSheet="5" ToCell="BeginX"/>
  </Connects>
</PageContents>"""
    return _zip_with(page_xml=page_xml)


@pytest.fixture(scope="module")
def job_requisition() -> dict:
    if not _JOB_REQUISITION.exists():
        pytest.skip(f"reference fixture not found at {_JOB_REQUISITION}")
    return handler._parse_vsdx_structure(_JOB_REQUISITION.read_bytes())


class TestJobRequisitionSwimlaneFixture:
    """The task's reference fixture — a real Workday-style swimlane export."""

    def test_finds_all_six_lanes_by_name(self, job_requisition):
        names = {l["name"] for l in job_requisition["lanes"]}
        assert names == {
            "Primary Recruiter", "Recruiter", "Manager +1",
            "Confidential Recruiter", "HR Partner", "Hiring Manager",
        }

    def test_lane_bands_are_contiguous_and_non_overlapping(self, job_requisition):
        bands = sorted((l["y_band"] for l in job_requisition["lanes"]), key=lambda b: b[0])
        for (lo, hi), (next_lo, _next_hi) in zip(bands, bands[1:]):
            assert lo < hi
            # Source XML values carry ~7 significant digits; float
            # arithmetic through Pin +/- Height/2 accumulates a small
            # rounding gap between adjacent bands' shared edge.
            assert abs(hi - next_lo) < 1e-4

    def test_exactly_one_start_and_one_end(self, job_requisition):
        nodes = job_requisition["nodes"]
        starts = [n for n in nodes if n["type"] == "start"]
        ends = [n for n in nodes if n["type"] == "end"]
        assert len(starts) == 1 and starts[0]["label"] == "START"
        assert len(ends) == 1 and ends[0]["label"] == "END"

    def test_eleven_task_nodes_each_with_code_and_label(self, job_requisition):
        tasks = [n for n in job_requisition["nodes"] if n["type"] == "task"]
        assert len(tasks) == 11
        for t in tasks:
            assert t["code"] and t["code"].startswith("HR-020-010-")
            assert t["label"]

    def test_decision_nodes_include_the_named_questions(self, job_requisition):
        decisions = {n["label"] for n in job_requisition["nodes"] if n["type"] == "decision"}
        assert len(decisions) == 4
        assert "Approve Requisition and Position?" in decisions
        assert "New position required?" in decisions
        assert "Not Contingent Worker and Not Confidential?" in decisions
        # Verbatim source typo (">" instead of "?") — the parser must not
        # "correct" shape text, only extract it faithfully.
        assert "Is Confidential Requisition>" in decisions

    def test_subprocess_nodes_reference_other_processes(self, job_requisition):
        subprocesses = {
            (n["code"], n["label"])
            for n in job_requisition["nodes"] if n["type"] == "subprocess"
        }
        assert len(subprocesses) == 7
        assert ("HR-020-050", "Manage Employee Referrals") in subprocesses
        assert ("HR-020-040", "External Applicants Apply") in subprocesses

    def test_every_node_assigned_to_one_of_the_six_lanes(self, job_requisition):
        lane_ids = {l["id"] for l in job_requisition["lanes"]}
        for n in job_requisition["nodes"]:
            assert n["lane"] in lane_ids

    def test_decision_edges_carry_yes_no_labels(self, job_requisition):
        labels = {e["label"] for e in job_requisition["edges"] if e["label"]}
        assert labels == {"Yes", "No"}
        assert sum(1 for e in job_requisition["edges"] if e["label"]) == 7

    def test_edges_connect_real_nodes_not_visual_connection_points(self, job_requisition):
        # Every edge endpoint must resolve to a top-level node's own ID —
        # not the inner child shape ID a connector visually snaps to
        # (this is the specific bug a naive Connect-row read falls into).
        node_ids = {n["id"] for n in job_requisition["nodes"]}
        for e in job_requisition["edges"]:
            assert e["from"] in node_ids
            assert e["to"] in node_ids

    def test_legacy_adapter_shape_matches_worker_handler_contract(self):
        legacy = handler._parse_vsdx(_JOB_REQUISITION.read_bytes())
        assert set(legacy.keys()) == {"groups", "steps", "connectors"}
        assert len(legacy["groups"]) == 6
        assert len(legacy["steps"]) == 24
        # A task's process code is folded into the label (no separate column
        # downstream) rather than silently dropped.
        assert any(s["label"].startswith("HR-020-010-") for s in legacy["steps"])


class TestMinimalFlatFixture:
    """No masters.xml, no pages.xml, no nested groups — confirms the parser
    isn't over-fit to the swimlane case."""

    def test_parses_without_any_masters_or_pages_xml(self):
        result = handler._parse_vsdx_structure(_minimal_flat_vsdx())
        assert result["lanes"] == []
        assert len(result["nodes"]) == 5
        assert len(result["edges"]) == 4

    def test_type_attribute_classifies_without_masters_xml(self):
        result = handler._parse_vsdx_structure(_minimal_flat_vsdx())
        by_id = {n["id"]: n for n in result["nodes"]}
        assert by_id["1"]["type"] == "start"
        assert by_id["3"]["type"] == "decision"
        assert by_id["5"]["type"] == "end"
        # No Type attribute at all on 2/4 — still captured as generic
        # process steps rather than silently dropped.
        assert by_id["2"]["type"] == "task"
        assert by_id["2"]["label"] == "Receive request"
        assert by_id["4"]["type"] == "task"

    def test_direct_node_to_node_connects_resolve_in_order(self):
        result = handler._parse_vsdx_structure(_minimal_flat_vsdx())
        edges = {(e["from"], e["to"]) for e in result["edges"]}
        assert edges == {("1", "2"), ("2", "3"), ("3", "4"), ("4", "5")}


class TestGlobalBankFixtureSmokeTest:
    """A second real .vsdx already in this repo. This file was hand-built
    without LocPinX/LocPinY (a real Visio export always emits them), so its
    nested shapes' coordinates don't follow genuine Visio group-relative
    semantics — a smoke test only, not a lane-assignment ground truth."""

    @pytest.fixture(scope="class")
    def result(self) -> dict:
        if not _GLOBALBANK.exists():
            pytest.skip(f"fixture not found at {_GLOBALBANK}")
        return handler._parse_vsdx_structure(_GLOBALBANK.read_bytes())

    def test_extracts_all_twelve_steps_without_dropping_any(self, result):
        assert len(result["nodes"]) == 12
        assert all(n["label"] for n in result["nodes"])

    def test_finds_all_four_lane_names_despite_no_masters_xml(self, result):
        names = {l["name"] for l in result["lanes"]}
        assert names == {"HR Business Partner", "Employee", "IT Department", "Manager"}

    def test_finds_the_sequential_edge_chain(self, result):
        assert len(result["edges"]) == 11


class TestFailsLoudlyNotSilently:
    def test_zero_text_bearing_shapes_raises_specific_diagnostic(self):
        page_xml = """<?xml version="1.0" encoding="utf-8"?>
<PageContents xmlns="http://schemas.microsoft.com/office/visio/2012/main">
  <Shapes>
    <Shape ID="1"><Cell N="PinX" V="1.0"/><Cell N="PinY" V="1.0"/></Shape>
    <Shape ID="2"><Cell N="PinX" V="2.0"/><Cell N="PinY" V="2.0"/></Shape>
  </Shapes>
</PageContents>"""
        with pytest.raises(ValueError, match=r"0 of 2 shapes have resolvable text"):
            handler._parse_vsdx_structure(_zip_with(page_xml=page_xml))

    def test_no_page_xml_at_all_raises_a_distinct_error(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("some/other/part.xml", "<x/>")
        with pytest.raises(ValueError, match="No Visio page XML found"):
            handler._parse_vsdx_structure(buf.getvalue())


class TestPageResolutionIgnoresPage1Convention:
    """pages.xml can point a page's content at any part filename — the
    resolver must follow the relationship, not assume "page1.xml"."""

    def test_resolves_non_standard_page_part_filename(self):
        pages_xml = (
            "<?xml version='1.0' encoding='utf-8'?>"
            "<Pages xmlns='http://schemas.microsoft.com/office/visio/2012/main' "
            "xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'>"
            "<Page ID='0' Name='My Diagram'><Rel r:id='rId9'/></Page>"
            "</Pages>"
        )
        pages_rels_xml = (
            "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>"
            "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>"
            "<Relationship Id='rId9' Type='http://schemas.microsoft.com/visio/2010/relationships/page' "
            "Target='unusual_part_name.xml'/>"
            "</Relationships>"
        )
        page_xml = """<?xml version="1.0" encoding="utf-8"?>
<PageContents xmlns="http://schemas.microsoft.com/office/visio/2012/main">
  <Shapes><Shape ID="1"><Cell N="PinX" V="1"/><Cell N="PinY" V="1"/><Text>Only step</Text></Shape></Shapes>
</PageContents>"""
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("visio/pages/unusual_part_name.xml", page_xml)
            zf.writestr("visio/pages/pages.xml", pages_xml)
            zf.writestr("visio/pages/_rels/pages.xml.rels", pages_rels_xml)
        result = handler._parse_vsdx_structure(buf.getvalue())
        assert result["page"] == "My Diagram"
        assert len(result["nodes"]) == 1
