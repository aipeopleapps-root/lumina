# Go-Live Checklist

Concrete, confirmed gaps to close before this goes live for real users — not a
wishlist, everything here was found and verified during actual work on the
platform (dates/sessions noted where useful). Add to this list as new gaps
turn up; check items off in the PR that closes them rather than editing this
file silently.

## BP Workbook Generation

- [x] **Ported and wired (2026-10-01)** — a colleague's complete, working
      standalone app (`bp-generation-automation_YOURKEY.zip`) is now ported
      into `bp-workbook-api/`, a separate Node.js Azure Functions app (own
      Flex Consumption plan, `bicep/modules/bpworkbook.bicep` +
      `bpworkbookRbac.bicep`), reusing Lumina's existing Cosmos/Blob/Azure AI
      Foundry resources (not its own standalone versions) with real tenant
      isolation added via a ported `tenantContext.js` (the original had
      none). Routed through APIM at path `bp-workbook` alongside the main
      API (`apim.bicep`). Frontend component `BpWorkbookGeneration.tsx` is
      built and wired into `App.tsx` (own top-level client-scoped view,
      same pattern as Process Intelligence/Test Automation Suite) and
      `PlatformHome.tsx` (tile flipped `soon` → `live`). `npm run build`
      passes clean. 14 Node unit tests passing (`bp-workbook-api/test/`).
- [ ] **Not yet deployed to live Azure** — bicep compiles clean
      (`az bicep build`), but the actual Function App code deploy is
      blocked: Flex Consumption doesn't support `az functionapp deployment
      source config-zip` or `az functionapp deploy --type zip` (415), and
      `func azure functionapp publish` (the officially-supported path)
      could not be installed reliably in this sandbox — its Core Tools
      postinstall binary download hung/silently no-opped. Needs either a
      working `func` CLI (try from a non-sandboxed machine) or someone to
      hand-build the Flex Consumption deployment package.
- [ ] **Known payload-size risk, not yet addressed**: `generateSession`'s
      request contract (preserved unchanged from the original app) sends
      every uploaded file as base64 JSON in a single POST body. Azure API
      Management's Consumption tier has a hard ~2MB inbound payload limit
      that cannot be raised via policy — a real Econ Map `.vsdx` (plus
      optional Security Policy/Notifications/template files, all inflated
      ~33% by base64) could realistically exceed that for a large process.
      Needs either a presigned-blob-upload rework (matching Process
      Intelligence's `.vsdx` upload pattern) or a move to a higher APIM
      tier — flagged here rather than fixed, since it changes the ported
      backend's request contract and wasn't in scope for the port itself.
- [x] **Round-trip validated structurally (2026-10-01)** — generated a real
      `.docx` by calling `docxBuilder.js`'s `buildDocx()` directly with
      synthetic visio data (bypassing parse/LLM/Blob/Cosmos, none of which
      need to be live for this), then fed it through
      `functions/test_automation/docx_reader.py::read_bpw()`. **Found and
      fixed a real bug**: the two apps' Section 7 table shapes don't match
      at all (TAS expects `#`/`Step Type`/`Step Name`/`Role`; the generator
      emits `Step Order`/`Step`/`Type`/.../`Security Group`) — before the
      fix, `read_bpw()` would have silently extracted **zero steps** from
      every generated workbook (its numeric-step-number check never matches
      the generator's lettered `Step Order` values). Fixed by adding a
      second recognized table shape + column mapping to `docx_reader.py`,
      with 3 new regression tests (`functions/tests/test_docx_reader.py`,
      covering both shapes plus blank-row and `"N/A"`→`None` handling).
      Still outstanding: a genuine LLM-enriched workbook (real Econ Map,
      real AI enrichment) hasn't been round-tripped — only the structural
      table-shape compatibility is proven. Do a real one as part of the
      first live smoke run. Also note: the generated workbook's process
      name always reads as "Unknown Process" downstream (`docxBuilder.js`'s
      cover page isn't a Word "Heading"-styled paragraph, so `read_bpw()`
      can't recover it) — cosmetic, not blocking, since each workbook is
      single-process.
- [ ] No sample `.vsdx`/`.xlsx` input files were included in the shared
      zip — real (or sanitized) examples from the colleague are needed for
      actual end-to-end testing beyond unit tests.

## Process Intelligence

- [ ] **Prioritization Framework (delivery-planning artifact) is not built.**
      A separate methodology doc (`Agentic_Process_Transformation_Framework.md`
      §2.6) specifies a third generation output alongside the Mode 2 agent
      schema and the unified HTML demo: per-agent `impactScore`/
      `abilityToExecuteScore`/quadrant, a `workstreams` breakdown by the
      seven-layer architecture (Trigger/Orchestration/Reasoning/Action/Human
      Approval/Monitoring/Learning), `dependencies`, and `kpis` tied back to
      the original business outcome. Deliberately deferred (2026-08-17) —
      it's explicitly scoped by its own source doc as "a third thing," not
      part of the HTML demo or the to-be map, and it has no home in Lumina's
      UI yet (Kanban view? roadmap timeline? PM tool export? — an open
      product decision, not a Process Intelligence content decision). Trigger
      point would be the same `reviewStatus: confirmed` moment as demo
      generation, but as its own generation step with its own output, not a
      variant of the HTML.
- [ ] **Maturity progression ordering conflict, unresolved but currently
      inert.** The same framework doc flags that its stated progression
      (Current Process → AI-Augmented → AI-Assisted → AI-Powered → Agentic
      Process) swaps Augmented/Assisted versus an ordering used in earlier
      UTS demos (AI Assisted → AI Augmented → AI Powered) — and separately
      proposes collapsing `humanRoles` (3-tier) and `maturity` (0-1 float)
      into one 6-point spectrum matching Human Led/Guided/Supervised + AI
      Assisted/Augmented/Powered. Checked against the actual reference HTML
      templates (`Agent_Demo_Generator_App_Spec.md` §8/§9 and the unified
      suite in `Process_Intelligence_Unified_Demo_Generation_Spec.md` §4):
      **neither `maturity` nor `humanRoles` is actually rendered anywhere**
      in the Live Demo or How It Works tabs, so this conflict doesn't block
      demo generation today — both fields are stored in `pi.agents.demo_profile`
      unrendered. Needs a deliberate decision (not a silent pick) before either
      field is ever surfaced in a UI, per the source doc's own instruction.
- [x] **~~Abandoned Mode 1/Mode 2 RAG architecture (capability ledger, pattern
      library, gold-standard examples) — schema-only, zero code references~~
      — resolved as a deliberate pivot (go-live planning session, 2026-10-01).**
      `migrations/003_pi_schema.sql` built `pi.capability_ledger`/
      `pi.pattern_library`/`pi.anti_pattern_log`/`pi.gold_standard_examples`/
      `pi.generation_runs` for a two-mode generation system that was never
      implemented — recommendations/redesign calls use one generic RAG call
      against the tenant's own uploaded docs instead (`pi_graph.py`'s
      `_kb_block()`, `doc_type="kb"`). Decision: do not build the bespoke
      tables — instead extend the existing shared firm-knowledge base
      (`functions/common/industry_knowledge.py`, the same Cosmos container
      Ask Stuey/RFP Reimagine already use) with PI-relevant content tagged
      `app="process-intelligence"`, and have `_kb_block()` query both. Reuses
      proven infrastructure instead of building new bespoke storage. The
      unused migration tables are left in place, not dropped — this note is
      the record of why they stay unreferenced.
- [ ] **Export Diagram silently downloads raw JSON, not a presentable
      diagram.** `ProcessIntelligence.tsx`'s `handleExportDiagram` has no
      server-side rendering pipeline — confirmed its own comment says so. A
      real image/PDF export is a separate, bigger feature; for now, worth at
      least relabeling the action honestly (e.g. "Export Data") rather than
      implying a diagram export that doesn't exist.

## Test Automation Suite

- [ ] **Nightly scheduling is a saved preference with no scheduler behind
      it.** `test_automation.environments.nightly_enabled`/`nightly_run_id`
      are real, UI-settable columns, but nothing reads them — the only timer
      trigger in the app (`test_automation_reconcile_stale_executions`, every
      15 min) is a stale-execution cleanup sweep, not a nightly runner.
- [ ] **Config-workbook detection only recognises Workday Absence sheet
      names.** `input_detector.py`'s `_CONFIG_SHEET_MARKERS` is a fixed
      Absence-only allowlist (confirmed identical in the origin app,
      `requirements-to-test-steps/app/services/input_detector.py` — not a
      porting regression). A config workbook from another module silently
      misdetects as a plain Requirements file.
- [ ] **Reference-workbook scope, found but deliberately descoped for the
      current go-live effort (2026-10-01).** A reference workbook in the
      origin app (`requirements-to-test-steps/Finance_Sample_Test_Scripts_ZR.xlsx`)
      reveals real intended functionality never built: Epic/taxonomy linkage
      (a full Finance L1/L2/L3 process taxonomy), export to Zephyr (a
      test-management tool, with a precise column spec), a formal
      gap-reconciliation report, and a "Boundary" scenario type (today only
      Positive/Negative exist). Logged here as explicit backlog, not lost —
      not part of this phase.
- [ ] **`requirements-to-test-steps/` (the origin app + its only realistic
      reference workbook) was untracked in git** until the 2026-10-01
      go-live session staged it — confirm it gets committed, it was one
      `git clean -fd` away from silent loss.

## Knowledge base / Ask Stuey

- [ ] **`docs/AZURE_MIGRATION.md`'s Log went stale specifically for this app.**
      Its last dated entry is 2026-08-12, but file mtimes and in-code
      comments ("session 16", "session 17") show at least two further,
      undocumented work sessions: an admin-configurable settings subsystem
      (`functions/common/settings_registry.py`, `functions/admin_app_settings/`),
      a "Cranky Mode" persona toggle (`ask_stuey_chat/handler.py`'s
      `_SYSTEM_CRANKY`), a citation word-overlap matching fix (`_is_cited()`),
      multi-chunk-per-document retrieval (`max_chunks_per_source`), and a
      multi-app tagging schema change (`apps: list[str]` replacing a
      singular `app` field, with a `doc_apps()` back-compat shim). Found
      2026-10-01 during go-live planning — treat the code as ground truth
      for this app over the Log until the Log itself is brought current.

- [ ] **Recursive crawl for multi-page knowledge sources.** `admin_industry_docs`'s
      `/ingest-url` only follows **one hop** of same-section sub-links from the
      seed page (`_same_section_sublinks`, capped at `_MAX_SUBLINKS`) — it
      doesn't re-run link discovery on the pages it just fetched. Confirmed live
      (2026-08-17): 13 of 16 Workday course-manual pages in the knowledge base
      were table-of-contents stubs with zero real lesson content; re-ingesting
      pulled in each course's *first* lesson page only (2–33 chunks each), not
      the rest of a typically 8–12-page course. A real question about a later
      section of any of these 13 courses can still come back empty or
      TOC-only, the same failure mode already seen once for the Absence course
      (`ask_stuey_chat` correctly refusing to answer from a title page).
      **Fix shape**: extend `_fetch_and_index_page`/`_ingest_url` to recurse a
      bounded number of levels (e.g. depth 3–4, same `_same_section_sublinks`
      same-directory filter at each level, a global page-count cap to bound
      cost/time), or convert it into a small breadth-first crawl queue instead
      of the current single-level loop. Needs a decision on depth/page-count
      limits before building — a full unbounded crawl of doc.workday.com is
      not the goal, just "get every page of the one course the admin pointed
      at."
      Re-run `/manage/industry-docs/ingest-url` for all 16 course-manual seed
      URLs again once this ships, to backfill the remaining pages.

## Reliability

- [ ] **CI silently rotates the Workday-execution shared secret on every
      deploy.** `bicep/scripts/deploy.sh` auto-generates `EXECUTION_WORKER_KEY`
      with `openssl rand -hex 32` whenever it isn't already set in the
      environment, and `deploy-azure.yml` only passes the Postgres admin
      password as a secret. Bicep updates both sides (the Function App setting
      and the Container Apps Job secret) atomically so it converges, but any
      Workday-execution scenario in flight during that deploy fails its
      internal-route auth. Fix: add `EXECUTION_WORKER_KEY` as a stable GitHub
      Actions repo secret.

## Security / identity

- [ ] **`extn.tenant_id`/`extn.role` claims only verified against a
      consumer/MSA-federated test account**, never a real Deloitte work/school
      account (`bicep/modules/apim.bicep`'s own header flags this). Re-verify
      claim presence and shape against a real corporate account before the
      Deloitte-tenant re-registration — this codebase has already gotten the
      claim-naming scheme wrong once (`extn.<name>` vs. Graph's
      `extension_<appId-no-dashes>_<name>`) and only caught it by decoding a
      real issued token.

## Data model consistency

- [ ] **Two parallel audit systems.** `common/audit.py` writes
      AI-explainability rows to Postgres (`"t_<tenant>".audit_log`), used only
      by `chat`/`analyze`; `common/audit_events.py` writes to Cosmos `audit`,
      used by ~20 other handlers. Only the Cosmos one is surfaced in the Admin
      panel's Audit Log tab — the Postgres path is effectively invisible
      operationally. Decide: consolidate onto one system, or explicitly
      document why AI-explainability logging deserves a separate path and
      surface it somewhere.
- [ ] **Consultant↔client assignment data lives in two places** — Cosmos
      `config` `ASSIGN#` records (authoritative, checked by every auth
      decision in `tenant.py`) and `admin.consultant_assignments` in Postgres
      (migration 002, written separately). A natural place for drift; confirm
      whether the Postgres copy is actually read anywhere, and if not, drop it
      rather than let two sources of truth coexist silently.

## Orphaned surface area

- [ ] **`POST /change-impact` has no frontend caller and no Platform Home
      tile** — a fully implemented, deployed, APIM-exposed route
      (`functions/change_impact/`) nobody can reach from the UI. Either wire
      up a "Change Impact Advisor" tile or retire the route.
- [ ] **Two apparently-dead frontend components**: `DocumentsPanel.tsx` and
      `FolderPicker.tsx` are imported by nothing in the current tree — confirm
      they're genuinely superseded (by functionality now inlined into
      `ConsultantPanel`/`UploadModal`) and delete them, or find out why they're
      still there.

## Frontend consistency

- [ ] **No shared design-token module.** ~10 frontend files each redeclare
      their own local color/font constants with comments asserting they match
      their siblings (`FONT`, `ACCENT`, `BG`, `CARD`, etc.) — a real drift risk
      as more apps get added. Worth a shared `theme.ts` before the app count
      grows further.

## CI/CD

- [ ] **Function App code and the frontend build both still deploy
      manually** (`az functionapp deployment source config-zip`,
      `npx @azure/static-web-apps-cli deploy`) — every deploy this session was
      session-driven, not automated. `deploy-azure.yml` only runs
      `bicep`/infra. Needs both wired into GitHub Actions before this can run
      unattended.

## Operability

- [ ] **No path into the VNet for direct DB access.** Postgres and Cosmos are
      both VNet-private with no public network access, and there's currently
      no VPN Gateway, Bastion, or jump box — meaning no desktop DB client
      (Azure Data Studio, Storage Explorer, etc.) can reach either database
      today. Every DB read this session went through a Function App route
      instead. Decide on a jump-box VM (cheaper) vs. Azure Bastion (cleaner)
      before this becomes a real operational bottleneck post-launch.
