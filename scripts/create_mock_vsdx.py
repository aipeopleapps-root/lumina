#!/usr/bin/env python3
"""
Generate a realistic mock GlobalBank Employee Onboarding process diagram (.vsdx).

The .vsdx format is an OpenXML ZIP package. The diagram has:
  - 4 swimlanes: HR Business Partner / Employee / IT / Manager
  - 12 steps including task boxes, a decision node, and a wait state
  - 11 directed connectors

Usage:
  python scripts/create_mock_vsdx.py
  # Writes: docs/GlobalBank_Onboarding_Process.vsdx
"""

from __future__ import annotations

import io
import os
import textwrap
import zipfile

# ── Visio namespace ───────────────────────────────────────────────────────────
NS = "http://schemas.microsoft.com/office/visio/2012/main"
NS_RELS = "http://schemas.openxmlformats.org/package/2006/relationships"

CONTENT_TYPES_XML = textwrap.dedent("""\
    <?xml version="1.0" encoding="utf-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml"  ContentType="application/xml"/>
      <Override PartName="/visio/document.xml"
                ContentType="application/vnd.ms-visio.drawing.main+xml"/>
      <Override PartName="/visio/pages/page1.xml"
                ContentType="application/vnd.ms-visio.page+xml"/>
    </Types>
""")

ROOT_RELS_XML = textwrap.dedent("""\
    <?xml version="1.0" encoding="utf-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1"
        Type="http://schemas.microsoft.com/visio/2010/relationships/document"
        Target="visio/document.xml"/>
    </Relationships>
""")

DOCUMENT_RELS_XML = textwrap.dedent("""\
    <?xml version="1.0" encoding="utf-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1"
        Type="http://schemas.microsoft.com/visio/2010/relationships/page"
        Target="pages/page1.xml"/>
    </Relationships>
""")

DOCUMENT_XML = textwrap.dedent(f"""\
    <?xml version="1.0" encoding="utf-8"?>
    <VisioDocument xmlns="{NS}">
      <DocumentSheet/>
      <Pages>
        <Page ID="1" NameU="Page-1">
          <Rel r:id="rId1"
               xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
        </Page>
      </Pages>
    </VisioDocument>
""")


def _escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _shape(shape_id: str, text: str, pin_x: float, pin_y: float,
           width: float = 1.5, height: float = 0.75,
           shape_type: str = "", parent: bool = False) -> str:
    """Return a <Shape> XML element string."""
    type_attr = f' Type="{shape_type}"' if shape_type else ""
    inner = ""
    if parent:
        # Group shapes don't render a box themselves
        inner = f"""
      <Shapes>
      </Shapes>"""
    return f"""    <Shape ID="{shape_id}"{type_attr}>
      <Cell N="PinX" V="{pin_x}"/>
      <Cell N="PinY" V="{pin_y}"/>
      <Cell N="Width" V="{width}"/>
      <Cell N="Height" V="{height}"/>
      <Text>{_escape(text)}</Text>{inner}
    </Shape>"""


def _group_shape(group_id: str, label: str, pin_x: float, pin_y: float,
                 width: float, height: float, children: list[str]) -> str:
    children_xml = "\n".join(children)
    return f"""    <Shape ID="{group_id}" Type="Group">
      <Cell N="PinX" V="{pin_x}"/>
      <Cell N="PinY" V="{pin_y}"/>
      <Cell N="Width" V="{width}"/>
      <Cell N="Height" V="{height}"/>
      <Text>{_escape(label)}</Text>
      <Shapes>
{children_xml}
      </Shapes>
    </Shape>"""


def _connect(from_id: str, to_id: str) -> str:
    return f'    <Connect FromSheet="{from_id}" ToSheet="{to_id}" FromCell="EndX" ToCell="BeginX"/>'


def build_page1_xml() -> str:
    """
    Build the page1.xml for GlobalBank Employee Onboarding diagram.

    Swimlanes (Group shapes at depth 0):
      Lane 10 — HR Business Partner  (top, y≈8.5)
      Lane 20 — Employee             (y≈6.5)
      Lane 30 — IT Department        (y≈4.5)
      Lane 40 — Manager              (bottom, y≈2.5)

    Steps (shape IDs 101–112):
      101  Send Offer Letter (HR BP)
      102  Accept Offer (Employee)
      103  Receive Welcome Email (Employee)
      104  Complete I-9 / Tax Forms in Workday (Employee)
      105  Background Check Complete? (HR BP) — decision
      106  Notify Rejection (HR BP)
      107  Provision Workday Account (IT)
      108  Set Up Laptop & VPN (IT)
      109  Wait: Equipment Shipping (IT) — wait state
      110  Review Onboarding Plan (Manager)
      111  Day-1 Orientation (HR BP + Employee)
      112  Complete Workday Onboarding Tasks (Employee)

    Connectors (11 edges):
      101→102, 102→103, 103→104, 104→105,
      105→106 (No branch), 105→107 (Yes branch),
      107→108, 108→109, 109→110,
      110→111, 111→112
    """

    # ── Steps ─────────────────────────────────────────────────────────────────
    # HR Business Partner lane (lane y=8.5, steps at y=8.5)
    s101 = _shape("101", "Send Offer Letter\n(Workday Recruiting)", 2.0, 8.5)
    s105 = _shape("105", "Background Check\nComplete?",             5.5, 8.5, shape_type="Decision")
    s106 = _shape("106", "Notify Candidate\nof Rejection",          7.5, 8.5)
    s111 = _shape("111", "Conduct Day-1\nOrientation",              10.5, 8.5)

    # Employee lane (y=6.5)
    s102 = _shape("102", "Accept Offer",                            3.5, 6.5)
    s103 = _shape("103", "Receive Welcome\nEmail (Workday)",        5.0, 6.5)
    s104 = _shape("104", "Complete I-9 &\nTax Forms in Workday",    6.5, 6.5)
    s112 = _shape("112", "Complete Workday\nOnboarding Tasks",      10.5, 6.5)

    # IT Department lane (y=4.5)
    s107 = _shape("107", "Provision Workday\nAccount & Email",      7.5, 4.5, width=1.8)
    s108 = _shape("108", "Set Up Laptop\n& VPN Access",             9.0, 4.5)
    s109 = _shape("109", "Wait: Equipment\nShipping (3-5 days)",    10.5, 4.5, shape_type="Delay")

    # Manager lane (y=2.5)
    s110 = _shape("110", "Review 30/60/90\nOnboarding Plan",        10.5, 2.5)

    # ── Swimlane Groups ───────────────────────────────────────────────────────
    lane_hr = _group_shape("10", "HR Business Partner", 6.0, 8.5, 12.0, 1.5, [s101, s105, s106, s111])
    lane_ee = _group_shape("20", "Employee",             6.0, 6.5, 12.0, 1.5, [s102, s103, s104, s112])
    lane_it = _group_shape("30", "IT Department",        6.0, 4.5, 12.0, 1.5, [s107, s108, s109])
    lane_mgr= _group_shape("40", "Manager",              6.0, 2.5, 12.0, 1.5, [s110])

    # ── Connectors ────────────────────────────────────────────────────────────
    connects = "\n".join([
        _connect("101", "102"),
        _connect("102", "103"),
        _connect("103", "104"),
        _connect("104", "105"),
        _connect("105", "106"),   # No branch → rejection
        _connect("105", "107"),   # Yes branch → provision
        _connect("107", "108"),
        _connect("108", "109"),
        _connect("109", "110"),
        _connect("110", "111"),
        _connect("111", "112"),
    ])

    shapes_block = "\n".join([lane_hr, lane_ee, lane_it, lane_mgr])

    # Build without textwrap.dedent — multiline shape labels break common-prefix detection
    return (
        f'<?xml version="1.0" encoding="utf-8"?>\n'
        f'<PageContents xmlns="{NS}"\n'
        f'              xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n'
        f'  <Shapes>\n'
        f'{shapes_block}\n'
        f'  </Shapes>\n'
        f'  <Connects>\n'
        f'{connects}\n'
        f'  </Connects>\n'
        f'</PageContents>\n'
    )


def create_vsdx(output_path: str) -> None:
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml",           CONTENT_TYPES_XML)
        zf.writestr("_rels/.rels",                   ROOT_RELS_XML)
        zf.writestr("visio/document.xml",            DOCUMENT_XML)
        zf.writestr("visio/_rels/document.xml.rels", DOCUMENT_RELS_XML)
        zf.writestr("visio/pages/page1.xml",         build_page1_xml())

    with open(output_path, "wb") as f:
        f.write(buf.getvalue())

    print(f"Created {output_path}  ({len(buf.getvalue()):,} bytes)")
    print("Swimlanes: HR Business Partner / Employee / IT Department / Manager")
    print("Steps: 12  |  Connectors: 11  |  Decision nodes: 1  |  Wait states: 1")


if __name__ == "__main__":
    output = os.path.join(
        os.path.dirname(os.path.dirname(__file__)),
        "docs",
        "GlobalBank_Onboarding_Process.vsdx",
    )
    create_vsdx(output)
