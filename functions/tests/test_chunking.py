"""
common/chunking.py — pure functions, no I/O beyond the byte blob handed in.
chunk_xlsx_workbook's one-chunk-per-row behavior fixes a real, documented
production regression (a packed chunk once diluted a single SKU row's
embedding badly enough that retrieval kept missing it) — this is the
regression test for that incident.
"""

from __future__ import annotations

import io

import openpyxl
import pytest

from common.chunking import TARGET_CHARS, chunk_text_document, chunk_xlsx_workbook


class TestProseChunking:
    def test_short_paragraphs_pack_into_one_chunk(self):
        text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph."
        chunks = chunk_text_document(text, doc_type="sow", source_name="doc.pdf", module=None)
        assert len(chunks) == 1
        assert "First paragraph." in chunks[0]["text"]
        assert "Third paragraph." in chunks[0]["text"]

    def test_splits_once_target_size_exceeded(self):
        para_a = "A" * 1200
        para_b = "B" * 1200
        text = f"{para_a}\n\n{para_b}"
        chunks = chunk_text_document(text, doc_type="sow", source_name="doc.pdf", module=None)
        assert len(chunks) == 2
        assert chunks[0]["chunk_index"] == 0
        assert chunks[1]["chunk_index"] == 1

    def test_overlap_tail_carries_into_next_chunk(self):
        para_a = "A" * 1200
        para_b = "B" * 1200
        text = f"{para_a}\n\n{para_b}"
        chunks = chunk_text_document(text, doc_type="sow", source_name="doc.pdf", module=None)
        # The overlap tail from the end of chunk 0 should appear at the start
        # of chunk 1's content (after the metadata prefix line).
        second_chunk_body = chunks[1]["text"].split("\n", 1)[1]
        assert second_chunk_body.startswith("A")

    def test_oversized_single_paragraph_hard_splits(self):
        text = "X" * (TARGET_CHARS * 3)
        chunks = chunk_text_document(text, doc_type="sow", source_name="doc.pdf", module=None)
        assert len(chunks) > 1
        for c in chunks:
            body = c["text"].split("\n", 1)[1]
            assert len(body) <= TARGET_CHARS

    def test_empty_text_produces_no_chunks(self):
        assert chunk_text_document("", doc_type="sow", source_name="doc.pdf", module=None) == []


class TestMetadataPrefix:
    def test_prefix_includes_doc_type_and_source(self):
        chunks = chunk_text_document("hello world", doc_type="sow", source_name="doc.pdf", module=None)
        assert chunks[0]["text"].startswith("[doc_type=sow source=doc.pdf]")

    def test_prefix_includes_module_when_given(self):
        chunks = chunk_text_document("hello world", doc_type="sow", source_name="doc.pdf", module="HCM")
        assert "module=HCM" in chunks[0]["text"].split("\n", 1)[0]

    def test_module_omitted_from_prefix_when_none(self):
        chunks = chunk_text_document("hello world", doc_type="sow", source_name="doc.pdf", module=None)
        assert "module=" not in chunks[0]["text"].split("\n", 1)[0]


class TestXlsxChunking:
    def _workbook_bytes(self, rows):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "SKUs"
        for row in rows:
            ws.append(row)
        buf = io.BytesIO()
        wb.save(buf)
        return buf.getvalue()

    def test_one_chunk_per_data_row_not_packed(self):
        data = self._workbook_bytes([
            ["SKU", "Name", "Price"],
            ["SKU-1", "Talent Optimization", "1000"],
            ["SKU-2", "Core HCM", "2000"],
            ["SKU-3", "Payroll", "3000"],
        ])
        chunks = chunk_xlsx_workbook(data, doc_type="pricing_sku", source_name="skus.xlsx", module=None)
        # Header row is metadata, not its own chunk — exactly one chunk per data row.
        assert len(chunks) == 3
        assert all(c["doc_type"] == "pricing_sku" for c in chunks)

    def test_each_row_carries_sheet_and_header_context(self):
        data = self._workbook_bytes([
            ["SKU", "Price"],
            ["SKU-1", "1000"],
        ])
        chunks = chunk_xlsx_workbook(data, doc_type="pricing_sku", source_name="skus.xlsx", module=None)
        assert "Sheet: SKUs" in chunks[0]["text"]
        assert "SKU-1" in chunks[0]["text"]
        # A row's own text is never bundled with another row's — that's the
        # exact behavior the doc string says fixed the real retrieval bug.
        assert "SKU-1" not in "".join(c["text"] for c in chunks if c is not chunks[0])

    def test_blank_rows_are_skipped(self):
        data = self._workbook_bytes([
            ["SKU", "Price"],
            ["SKU-1", "1000"],
            [None, None],
            ["SKU-2", "2000"],
        ])
        chunks = chunk_xlsx_workbook(data, doc_type="pricing_sku", source_name="skus.xlsx", module=None)
        assert len(chunks) == 2
