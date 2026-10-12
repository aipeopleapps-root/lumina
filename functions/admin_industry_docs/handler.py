"""
Admin document upload/tag/delete for the firm-wide industry-knowledge base
(functions/common/industry_knowledge.py) — distinct from ingest/handler.py's
per-tenant consultant document flow, which writes into the tenant-isolated
`vectors` container instead. This container has no tenant_id at all: every
consultant across every client engagement in a given industry shares it.

Every document uploaded here is tagged before indexing so retrieval can be
scoped correctly:

  industry  - which industry vertical this content applies to. Reuses the
              same fixed enum as ai.bicep's modelProviderIndustry /
              main.bicepparam's modelProviderIndustry param, so admins pick
              from one canonical list instead of free-typing near-duplicates
              ("Tech" vs "Technology" vs "technology") that would silently
              fragment retrieval.
  app       - which platform app's RAG this feeds (see PlatformHome.tsx's
              APP_SCOPE / AppId) — e.g. "rfp-reimagine" today,
              "blueprint-match" once that app is built. industry_knowledge.
              search() filters on this so two apps sharing an industry
              partition never bleed into each other's retrieval.
  doc_type  - what kind of content this chunk is. See VALID_DOC_TYPES below —
              rfp_excerpt/case_study/proposal_content/blueprint/
              cover_letter_template are the original rfp-reimagine/
              blueprint-match categories; pricing_sku/process_delivery/
              product_overview/workday_documentation were added once
              ask-stuey became the dominant uploader and most of its real
              content (SKU lists, cutover decks, doc.workday.com pages) was
              falling into the "other" catch-all.
  module    - optional Workday module, picked from a fixed list in the
              upload form (see WORKDAY_MODULES in AdminPanel.tsx) rather
              than free-typed — not validated server-side since it's purely
              descriptive metadata, not used to filter retrieval.

Five routes, one handler module (mirrors mfa_reset_request.handler's
rawPath-dispatch pattern — see function_app.py):
  POST /manage/industry-docs/upload-url  - SAS URL for a client-side PUT
  POST /manage/industry-docs/upload      - chunk, embed, index a tagged document
  POST /manage/industry-docs/ingest-url  - fetch a web page, chunk/embed/index it
                                            the same way (see _ingest_url) — added
                                            session 16 so Stuey can answer from
                                            Workday's own public docs
                                            (doc.workday.com), not just uploaded
                                            files. Admin-curated, not a full-site
                                            crawler: an admin pastes the one page
                                            that matters, but a hub/overview page's
                                            real content usually lives one level
                                            down (separate sub-pages), so this also
                                            follows same-section links from the
                                            seed page automatically — see
                                            _same_section_sublinks/_MAX_SUBLINKS.
                                            Each sub-page is indexed as its own
                                            document with its own citation, and a
                                            caller can pass follow_sublinks=false
                                            to ingest just the one URL as before.
  GET  /manage/industry-docs/list        - list indexed sources (grouped) + tags
  POST /manage/industry-docs/delete      - delete every chunk of one source
  POST /manage/industry-docs/update-metadata - edit an indexed document's tags
                                            in place (see _update_metadata) —
                                            everything _upload() sets except the
                                            file/content itself; re-embeds only
                                            if aliases changed.

upload-url deliberately does NOT reuse upload_url/handler.py: that handler
files everything under `tenants/{ctx.tenant_id}/uploads/...`, which for an
admin means whichever tenant they currently happen to be viewing via
x-client-tenant — misleading for a document that has nothing to do with any
one client tenant. This writes under a fixed `firm/industry-knowledge/...`
prefix instead.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse, urljoin

import lxml.html
import requests

from common import (
    tenant_from_event,
    TenantError,
    ai,
    blob,
    chunking,
    industry_knowledge,
    audit_events,
    http,
)

log = logging.getLogger(__name__)
log.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

# Mirrors ai.bicep's modelProviderIndustry ModelProviderIndustry enum values —
# see docs/AZURE_MIGRATION.md's log for why that specific casing/list is load-bearing.
VALID_INDUSTRIES = {
    "technology", "finance", "healthcare", "education", "retail",
    "manufacturing", "government", "media", "other",
}

# Explicit allowlist for /ingest-url — this endpoint does a server-side GET
# on an admin-supplied URL, which is a textbook SSRF vector if it accepted
# any host. Only Workday's own public documentation domain is permitted;
# widen deliberately if a second legitimate source ever comes up, never by
# accepting arbitrary hosts.
_ALLOWED_WEB_DOMAINS = {"doc.workday.com"}
_FETCH_TIMEOUT = 20

# A doc.workday.com "overview" page is usually a hub linking out to the real
# how-to content (e.g. an Absence overview page links to separate Time Off
# Setup / Leave of Absence Configuration pages) — indexing only the hub page
# left Stuey unable to answer questions the sub-pages actually cover. Follow
# one level of same-section links automatically rather than requiring an
# admin to notice and paste each sub-page individually. Capped and
# same-path-prefix-scoped so a hub page's nav doesn't pull in the entire site.
_MAX_SUBLINKS = 15

# Only apps that read from this firm-wide store (see PlatformHome.tsx's
# APP_SCOPE) — Process Intelligence/Test Automation/Integration
# Studio/ConfigGuard are client-scoped and use the per-tenant ingest flow
# instead, so they're deliberately not options here.
VALID_APPS = {"rfp-reimagine", "blueprint-match", "ask-stuey"}

VALID_DOC_TYPES = {
    # Original rfp-reimagine / blueprint-match categories.
    "rfp_excerpt", "case_study", "proposal_content", "blueprint", "cover_letter_template",
    # Added once ask-stuey became the dominant uploader (session 16) — its real content
    # (SKU/pricing sheets, delivery decks, product overviews, ingested doc.workday.com
    # pages) doesn't fit any of the RFP-era categories above and was all landing in "other".
    "pricing_sku", "process_delivery", "product_overview", "workday_documentation",
    "other",
}

_TEXT_EXTS = {"txt", "md"}

_CONTENT_TYPES = {
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "txt": "text/plain",
    "md": "text/markdown",
}

_UPLOAD_PREFIX = "firm/industry-knowledge/uploads"
_SAS_EXPIRES_IN = 3600


def handler(event, context):
    try:
        ctx = tenant_from_event(event)
        ctx.require_role("super_admin")
    except TenantError as e:
        return http.forbidden(str(e))

    path = event.get("rawPath", "")
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")

    if path.endswith("/upload-url") and method == "POST":
        return _upload_url(event)
    if path.endswith("/upload") and method == "POST":
        return _upload(ctx, event)
    if path.endswith("/ingest-url") and method == "POST":
        return _ingest_url(ctx, event)
    if path.endswith("/list") and method == "GET":
        return _list()
    if path.endswith("/delete") and method == "POST":
        return _delete(ctx, event)
    if path.endswith("/update-metadata") and method == "POST":
        return _update_metadata(ctx, event)
    return http.bad_request("unknown route")


def _upload_url(event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    filename = (body.get("filename") or "").strip()
    if not filename:
        return http.bad_request("filename is required")

    ext = filename.lower().rsplit(".", 1)[-1]
    content_type = _CONTENT_TYPES.get(ext, "application/octet-stream")

    upload_id = str(uuid.uuid4())
    s3_key = f"{_UPLOAD_PREFIX}/{upload_id}/{filename}"
    sas_url = blob.generate_upload_sas(s3_key, content_type, expires_in=_SAS_EXPIRES_IN)

    return http.ok({"url": sas_url, "key": s3_key, "content_type": content_type})


# Accuracy-oriented metadata — all optional, admin-set at upload/ingest time
# (see docs/AZURE_MIGRATION.md session-16 log for the reasoning behind each):
#   effective_date / is_current  - freshness. A stale pricing sheet still
#     retrieving alongside its replacement was the exact "which of these
#     3 versions is real" failure mode Stuey's own persona is built to
#     complain about — is_current lets an admin explicitly retire a
#     superseded upload without deleting it (still useful as history).
#   is_canonical  - marks the one true master copy of a recurring asset
#     (e.g. Deployments_Master Slide.pptx) so it outranks near-duplicate
#     content on ties, instead of relying on the model noticing "master"
#     in the prose.
#   aliases       - free-text synonyms/abbreviations (e.g. "TAO" for
#     Talent Optimization) folded into the chunk text before embedding —
#     this is the direct fix for a consultant's phrasing not matching a
#     document's phrasing closely enough for semantic search to catch.
#   region, reviewed, client_facing  - shown to Stuey as context so the
#     model can caveat appropriately (wrong region, unreviewed draft,
#     internal-only) rather than presenting everything with equal
#     confidence.
def _parse_metadata(body: dict) -> dict:
    is_current = body.get("is_current", True)
    if not isinstance(is_current, bool):
        is_current = str(is_current).strip().lower() not in ("false", "0", "")
    return {
        "effective_date": (body.get("effective_date") or "").strip() or None,
        "is_current": is_current,
        "is_canonical": bool(body.get("is_canonical", False)),
        "aliases": (body.get("aliases") or "").strip() or None,
        "region": (body.get("region") or "").strip() or None,
        "reviewed": bool(body.get("reviewed", False)),
        "client_facing": bool(body.get("client_facing", False)),
    }


def _parse_apps(body: dict) -> tuple[list[str], str | None]:
    """A document can feed more than one platform app at once (e.g. the same
    pricing sheet is relevant to both RFP Reimagine and Ask Stuey) — apps is
    a non-empty subset of VALID_APPS, not a single value. Returns
    (apps, error) so callers can return http.bad_request(error) uniformly."""
    apps = body.get("apps")
    if not isinstance(apps, list) or not apps:
        return [], "apps must be a non-empty list"
    apps = [str(a).strip().lower() for a in apps]
    if not set(apps).issubset(VALID_APPS):
        return [], f"apps must be a subset of: {', '.join(sorted(VALID_APPS))}"
    return apps, None


def _embed_tag_and_index(chunks, *, industry, source_name, apps, module, meta, extra=None):
    """Shared tail of _upload()/_ingest_url(): fold aliases into chunk text,
    embed, attach every metadata field, index. `extra` carries the one field
    that differs by source type (s3_key for a file, source_url for a web
    page) — see ask_stuey_chat/handler.py for how a caller picks between
    them when building a clickable link."""
    now_iso = datetime.now(timezone.utc).isoformat()
    for c in chunks:
        # Aliases are folded into the TEXT before embedding, not just stored
        # as an inert field — a synonym only helps retrieval if it's actually
        # part of what gets embedded.
        text = c["text"]
        if meta["aliases"]:
            text = f"{text}\nAlso known as: {meta['aliases']}"
        c["embedding"] = ai.embed(text)
        c["text"] = text
        c["apps"] = apps
        c["module"] = module
        c["created_at"] = now_iso
        c.update(meta)
        if extra:
            c.update(extra)
    return industry_knowledge.index_chunks(industry, source_name, chunks)


def _upload(ctx, event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    s3_key = body.get("s3_key") or ""
    industry = (body.get("industry") or "").strip().lower()
    apps, apps_error = _parse_apps(body)
    doc_type = (body.get("doc_type") or "").strip().lower()
    module = (body.get("module") or "").strip() or None
    source_name = body.get("source_name") or s3_key.rsplit("/", 1)[-1]
    meta = _parse_metadata(body)

    if not s3_key:
        return http.bad_request("s3_key is required")
    if industry not in VALID_INDUSTRIES:
        return http.bad_request(f"industry must be one of: {', '.join(sorted(VALID_INDUSTRIES))}")
    if apps_error:
        return http.bad_request(apps_error)
    if doc_type not in VALID_DOC_TYPES:
        return http.bad_request(f"doc_type must be one of: {', '.join(sorted(VALID_DOC_TYPES))}")

    data = blob.get_object_bytes(s3_key)

    ext = source_name.lower().rsplit(".", 1)[-1]
    if ext in ("xlsx", "xlsm"):
        chunks = chunking.chunk_xlsx_workbook(data, doc_type=doc_type, source_name=source_name, module=module)
    elif ext == "pdf":
        chunks = chunking.chunk_pdf(data, doc_type=doc_type, source_name=source_name, module=module)
    elif ext == "docx":
        chunks = chunking.chunk_docx(data, doc_type=doc_type, source_name=source_name, module=module)
    elif ext == "pptx":
        chunks = chunking.chunk_pptx(data, doc_type=doc_type, source_name=source_name, module=module)
    elif ext in _TEXT_EXTS:
        chunks = chunking.chunk_text_document(
            data.decode("utf-8", errors="replace"), doc_type=doc_type, source_name=source_name, module=module
        )
    else:
        return http.bad_request(f"unsupported file extension: {ext}")

    if not chunks:
        return http.bad_request("no content extracted from file")

    indexed = _embed_tag_and_index(
        chunks, industry=industry, source_name=source_name, apps=apps, module=module,
        meta=meta, extra={"s3_key": s3_key},
    )

    log.info(
        "indexed %d industry-knowledge chunks industry=%s apps=%s source=%s current=%s canonical=%s",
        indexed, industry, apps, source_name, meta["is_current"], meta["is_canonical"],
    )

    audit_events.write(
        ctx,
        "document.upload",
        ip=audit_events.get_ip(event),
        resource_type="industry_knowledge_document",
        resource_id=source_name,
        resource_name=source_name,
        details={"industry": industry, "apps": apps, "doc_type": doc_type, "module": module, "chunks_indexed": indexed, **meta},
    )

    return http.ok({
        "source_name": source_name,
        "industry": industry,
        "apps": apps,
        "doc_type": doc_type,
        "module": module,
        "chunks_indexed": indexed,
        "is_current": meta["is_current"],
        "is_canonical": meta["is_canonical"],
    })


def _parse_html_page(html: str, base_url: str) -> tuple[str, str | None, list[str]]:
    """Returns (readable_text, page_title, same_section_links). Link discovery
    happens BEFORE the chrome-stripping pass below — a doc site's sidebar/nav
    is exactly where a hub page's links to its real sub-pages usually live,
    even though that same chrome is boilerplate we don't want polluting the
    page's own text embedding. Strips script/style/nav/header/footer before
    extracting text for that latter reason."""
    doc = lxml.html.fromstring(html)
    title_els = doc.xpath("//title")
    title = title_els[0].text_content().strip() if title_els else None

    links = []
    for a in doc.xpath("//a[@href]"):
        href = a.get("href")
        if not href or href.startswith("#") or href.lower().startswith(("mailto:", "tel:", "javascript:")):
            continue
        links.append(urljoin(base_url, href))

    for el in doc.xpath(
        "//script | //style | //nav | //header | //footer "
        "| //*[@role='navigation'] | //*[contains(@class, 'sidebar')] | //*[contains(@class, 'cookie')]"
    ):
        el.drop_tree()
    text = doc.text_content()
    lines = [ln.strip() for ln in text.splitlines()]
    lines = [ln for ln in lines if ln]
    return "\n\n".join(lines), title, links


def _same_section_sublinks(links: list[str], base_url: str) -> list[str]:
    """Filters discovered links down to the ones worth auto-following: same
    allowlisted host, same directory (or a subdirectory of it) as the seed
    page, excluding the seed page itself. This is what keeps a hub page's
    site-wide nav (privacy policy, unrelated product lines, etc.) from being
    swept in — only content living alongside the page the admin chose to
    ingest gets pulled in automatically."""
    base_parsed = urlparse(base_url)
    base_dir = base_url.rsplit("/", 1)[0] + "/"
    seen: set[str] = {base_url}
    out = []
    for link in links:
        if link in seen:
            continue
        parsed = urlparse(link)
        if parsed.scheme not in ("http", "https") or parsed.hostname not in _ALLOWED_WEB_DOMAINS:
            continue
        if not link.startswith(base_dir):
            continue
        seen.add(link)
        out.append(link)
        if len(out) >= _MAX_SUBLINKS:
            break
    return out


def _fetch_and_index_page(ctx, event, url, *, industry, apps, doc_type, module, meta, source_name_override=None):
    """Fetches one page and chunks/embeds/indexes it as its own document (own
    source_name, own source_url) — a sub-page gets its own citation rather
    than being folded into the seed page's, so Stuey links to the exact page
    a fact came from. Returns (result_dict, None) on success or (None,
    reason) on failure; the seed-page caller surfaces `reason` as a 400,
    sublink ingestion just skips a page that fails."""
    try:
        resp = requests.get(
            url, timeout=_FETCH_TIMEOUT,
            headers={"User-Agent": "Mozilla/5.0 (compatible; LuminaKnowledgeBase/1.0)"},
        )
        resp.raise_for_status()
    except Exception as e:
        return None, f"failed to fetch that page: {e}"

    text, title, links = _parse_html_page(resp.text, url)
    if not text.strip():
        return None, "no readable content extracted from that page — it may require login"

    source_name = source_name_override or title or url
    chunks = chunking.chunk_text_document(text, doc_type=doc_type, source_name=source_name, module=module)
    if not chunks:
        return None, "no content extracted from that page"

    indexed = _embed_tag_and_index(
        chunks, industry=industry, source_name=source_name, apps=apps, module=module,
        meta=meta, extra={"source_url": url},
    )

    log.info(
        "indexed %d industry-knowledge chunks (web) industry=%s apps=%s source=%s url=%s",
        indexed, industry, apps, source_name, url,
    )

    audit_events.write(
        ctx,
        "document.upload",
        ip=audit_events.get_ip(event),
        resource_type="industry_knowledge_document",
        resource_id=source_name,
        resource_name=source_name,
        details={"industry": industry, "apps": apps, "doc_type": doc_type, "module": module,
                 "chunks_indexed": indexed, "source_url": url, **meta},
    )

    return {"source_name": source_name, "chunks_indexed": indexed, "source_url": url, "links": links}, None


def _ingest_url(ctx, event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    url = (body.get("url") or "").strip()
    industry = (body.get("industry") or "").strip().lower()
    apps, apps_error = _parse_apps(body)
    doc_type = (body.get("doc_type") or "").strip().lower()
    module = (body.get("module") or "").strip() or None
    meta = _parse_metadata(body)
    follow_sublinks = body.get("follow_sublinks", True)

    if not url:
        return http.bad_request("url is required")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or parsed.hostname not in _ALLOWED_WEB_DOMAINS:
        return http.bad_request(f"url must be on one of: {', '.join(sorted(_ALLOWED_WEB_DOMAINS))}")
    if industry not in VALID_INDUSTRIES:
        return http.bad_request(f"industry must be one of: {', '.join(sorted(VALID_INDUSTRIES))}")
    if apps_error:
        return http.bad_request(apps_error)
    if doc_type not in VALID_DOC_TYPES:
        return http.bad_request(f"doc_type must be one of: {', '.join(sorted(VALID_DOC_TYPES))}")

    source_name_override = (body.get("source_name") or "").strip() or None
    result, error = _fetch_and_index_page(
        ctx, event, url, industry=industry, apps=apps, doc_type=doc_type, module=module,
        meta=meta, source_name_override=source_name_override,
    )
    if result is None:
        return http.bad_request(error)

    # Follow one level of same-section sublinks so a hub/overview page's real
    # how-to content (usually separate pages) gets indexed too, not just the
    # hub's own text — see _same_section_sublinks and _MAX_SUBLINKS above.
    sublinks_indexed = []
    if follow_sublinks:
        for link in _same_section_sublinks(result["links"], url):
            sub_result, _sub_error = _fetch_and_index_page(
                ctx, event, link, industry=industry, apps=apps, doc_type=doc_type, module=module, meta=meta,
            )
            if sub_result:
                sublinks_indexed.append({
                    "source_name": sub_result["source_name"],
                    "source_url": link,
                    "chunks_indexed": sub_result["chunks_indexed"],
                })

    return http.ok({
        "source_name": result["source_name"],
        "industry": industry,
        "apps": apps,
        "doc_type": doc_type,
        "module": module,
        "chunks_indexed": result["chunks_indexed"],
        "source_url": url,
        "sublinks_indexed": sublinks_indexed,
    })


def _list():
    """One row per uploaded source document (grouped from its chunks), not per chunk."""
    sources: dict[str, dict] = {}
    for ind in industry_knowledge.list_industries():
        for item in industry_knowledge.query_all(ind):
            key = f"{item['industry']}::{item['source_name']}"
            row = sources.get(key)
            if row is None:
                row = sources[key] = {
                    "source_name": item.get("source_name"),
                    "industry": item.get("industry"),
                    "apps": industry_knowledge.doc_apps(item),
                    "doc_type": item.get("doc_type"),
                    "module": item.get("module") or "",
                    "chunk_count": 0,
                    "created_at": item.get("created_at"),
                    "effective_date": item.get("effective_date"),
                    "is_current": item.get("is_current", True),
                    "is_canonical": item.get("is_canonical", False),
                    "aliases": item.get("aliases") or "",
                    "region": item.get("region") or "",
                    "reviewed": item.get("reviewed", False),
                    "client_facing": item.get("client_facing", False),
                    "source_url": item.get("source_url") or "",
                }
            row["chunk_count"] += 1
    documents = sorted(sources.values(), key=lambda d: d.get("created_at") or "", reverse=True)
    return http.ok({"documents": documents})


def _delete(ctx, event):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    industry = (body.get("industry") or "").strip().lower()
    source_name = body.get("source_name") or ""
    if not industry or not source_name:
        return http.bad_request("industry and source_name are required")

    deleted = industry_knowledge.delete_source(industry, source_name)

    audit_events.write(
        ctx,
        "document.delete",
        ip=audit_events.get_ip(event),
        resource_type="industry_knowledge_document",
        resource_id=source_name,
        resource_name=source_name,
        details={"industry": industry, "chunks_deleted": deleted},
    )

    return http.ok({"source_name": source_name, "chunks_deleted": deleted})


def _update_metadata(ctx, event):
    """Edits an already-indexed document's admin-set tags in place — the
    counterpart to _upload()'s metadata fields, for fixing a typo or
    updating a doc's status without deleting and re-uploading the whole
    file. Applies to every chunk of the source document (metadata is
    denormalized per-chunk, same as upload). Re-embeds only if `aliases`
    actually changed, since aliases are folded into the embedded text
    itself (see _embed_tag_and_index) — every other field here is read at
    retrieval/prompt time and doesn't touch the vector, so editing them is
    just a field update, no re-embed needed."""
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return http.bad_request("invalid JSON body")

    industry = (body.get("industry") or "").strip().lower()
    source_name = (body.get("source_name") or "").strip()
    if not source_name:
        return http.bad_request("source_name is required")
    if industry not in VALID_INDUSTRIES:
        return http.bad_request(f"industry must be one of: {', '.join(sorted(VALID_INDUSTRIES))}")

    apps, apps_error = _parse_apps(body)
    if apps_error:
        return http.bad_request(apps_error)

    doc_type = (body.get("doc_type") or "").strip().lower()
    if doc_type not in VALID_DOC_TYPES:
        return http.bad_request(f"doc_type must be one of: {', '.join(sorted(VALID_DOC_TYPES))}")

    module = (body.get("module") or "").strip() or None
    meta = _parse_metadata(body)
    new_aliases = meta["aliases"] or ""

    chunks = industry_knowledge.get_source_chunks(industry, source_name)
    if not chunks:
        return http.bad_request("no matching document found")

    reembedded = 0
    for c in chunks:
        old_aliases = c.get("aliases") or ""
        if old_aliases != new_aliases:
            suffix = f"\nAlso known as: {old_aliases}"
            base_text = c["text"][: -len(suffix)] if old_aliases and c["text"].endswith(suffix) else c["text"]
            new_text = f"{base_text}\nAlso known as: {new_aliases}" if new_aliases else base_text
            c["text"] = new_text
            c["embedding"] = industry_knowledge.pack_vector(ai.embed(new_text))
            reembedded += 1
        c["apps"] = apps
        c["doc_type"] = doc_type
        c["module"] = module or ""
        c.update(meta)

    industry_knowledge.save_chunks(chunks)

    audit_events.write(
        ctx,
        "document.update_metadata",
        ip=audit_events.get_ip(event),
        resource_type="industry_knowledge_document",
        resource_id=source_name,
        resource_name=source_name,
        details={
            "industry": industry, "apps": apps, "doc_type": doc_type, "module": module,
            "chunks_updated": len(chunks), "chunks_reembedded": reembedded, **meta,
        },
    )

    return http.ok({
        "source_name": source_name,
        "industry": industry,
        "apps": apps,
        "doc_type": doc_type,
        "module": module,
        "chunks_updated": len(chunks),
        "chunks_reembedded": reembedded,
    })
