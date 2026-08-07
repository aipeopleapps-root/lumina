"""
Chunking strategy for Workday delivery artifacts.

Different source types need different chunking:
- XLSX workbooks: one chunk per sheet per logical section (rules / BP steps / mappings)
- PDFs: semantic paragraphs with overlap
- DOCX: heading-aware chunking

The common output is a list of dicts with: text, doc_type, module, source_name,
chunk_index, and optional context hints that improve retrieval.
"""

from __future__ import annotations

import io
import logging
import re
from typing import Any, Iterable

log = logging.getLogger(__name__)

# Target chunk size — Titan v2 accepts up to 8k tokens, but shorter chunks
# (~400–600 tokens) retrieve more precisely.
TARGET_CHARS = 1800
OVERLAP_CHARS = 200


def chunk_text_document(
    text: str, *, doc_type: str, source_name: str, module: str | None
) -> list[dict[str, Any]]:
    """Paragraph-aware chunking with overlap. Used for PDF and DOCX."""
    paragraphs = [p.strip() for p in re.split(r"\n{2,}", text) if p.strip()]
    chunks: list[dict[str, Any]] = []
    buf = ""
    idx = 0
    for p in paragraphs:
        if len(buf) + len(p) + 2 <= TARGET_CHARS:
            buf = f"{buf}\n\n{p}" if buf else p
        else:
            if buf:
                chunks.append(_mk_chunk(buf, idx, doc_type, source_name, module))
                idx += 1
                tail = buf[-OVERLAP_CHARS:] if len(buf) > OVERLAP_CHARS else ""
                buf = f"{tail}\n\n{p}" if tail else p
            else:
                # Single paragraph too large — hard split.
                for start in range(0, len(p), TARGET_CHARS - OVERLAP_CHARS):
                    chunks.append(
                        _mk_chunk(p[start : start + TARGET_CHARS], idx, doc_type, source_name, module)
                    )
                    idx += 1
                buf = ""
    if buf:
        chunks.append(_mk_chunk(buf, idx, doc_type, source_name, module))
    return chunks


def chunk_xlsx_workbook(
    data: bytes, *, doc_type: str, source_name: str, module: str | None
) -> list[dict[str, Any]]:
    """
    Row-block chunking for Workday workbooks. Every sheet is rendered as
    a labeled block of rows; we pack rows into target-sized chunks so
    related rows stay together.
    """
    import openpyxl  # imported lazily; lambda layer has it

    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    chunks: list[dict[str, Any]] = []
    idx = 0
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            continue
        headers = [str(h) if h is not None else "" for h in rows[0]]
        buf_lines: list[str] = [f"# Sheet: {sheet_name}", "Headers: " + " | ".join(headers)]
        buf_len = sum(len(line) + 1 for line in buf_lines)
        for row in rows[1:]:
            cells = [str(c) if c is not None else "" for c in row]
            if not any(cells):
                continue
            row_text = " | ".join(f"{h}: {v}" for h, v in zip(headers, cells) if v)
            if buf_len + len(row_text) + 1 > TARGET_CHARS and len(buf_lines) > 2:
                text = "\n".join(buf_lines)
                chunks.append(_mk_chunk(text, idx, doc_type, source_name, module, sheet=sheet_name))
                idx += 1
                buf_lines = [f"# Sheet: {sheet_name} (continued)", "Headers: " + " | ".join(headers)]
                buf_len = sum(len(line) + 1 for line in buf_lines)
            buf_lines.append(row_text)
            buf_len += len(row_text) + 1
        if len(buf_lines) > 2:
            chunks.append(
                _mk_chunk("\n".join(buf_lines), idx, doc_type, source_name, module, sheet=sheet_name)
            )
            idx += 1
    return chunks


def chunk_pdf(
    data: bytes, *, doc_type: str, source_name: str, module: str | None
) -> list[dict[str, Any]]:
    """Extract text per page, then paragraph-chunk across pages."""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    page_texts = []
    for i, page in enumerate(reader.pages):
        txt = page.extract_text() or ""
        if txt.strip():
            page_texts.append(f"[Page {i + 1}]\n{txt.strip()}")
    full = "\n\n".join(page_texts)
    return chunk_text_document(full, doc_type=doc_type, source_name=source_name, module=module)


def chunk_docx(
    data: bytes, *, doc_type: str, source_name: str, module: str | None
) -> list[dict[str, Any]]:
    """Heading-aware chunking for DOCX."""
    from docx import Document  # python-docx

    doc = Document(io.BytesIO(data))
    lines: list[str] = []
    for p in doc.paragraphs:
        if not p.text.strip():
            continue
        style = (p.style.name or "").lower() if p.style else ""
        if "heading" in style:
            lines.append("")
            lines.append(f"## {p.text}")
            lines.append("")
        else:
            lines.append(p.text)
    full = "\n".join(lines)
    return chunk_text_document(full, doc_type=doc_type, source_name=source_name, module=module)


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

def _mk_chunk(
    text: str,
    idx: int,
    doc_type: str,
    source_name: str,
    module: str | None,
    *,
    sheet: str | None = None,
) -> dict[str, Any]:
    metadata_line = f"[doc_type={doc_type} source={source_name}"
    if module:
        metadata_line += f" module={module}"
    if sheet:
        metadata_line += f" sheet={sheet}"
    metadata_line += "]"
    # Prepend metadata so the embedding captures context too.
    return {
        "chunk_index": idx,
        "doc_type": doc_type,
        "source_name": source_name,
        "module": module,
        "text": f"{metadata_line}\n{text}",
    }
