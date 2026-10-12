# Known defects — Process Intelligence

Running list of bugs found during manual/live testing. Not yet fixed unless noted.

## 1. Agent LLD generation gets permanently stuck at "generating"

**Found:** 2026-08-05, live testing against `WorkdayAiPlatformStack`, agent "Talent Acquisition Agent" (`agent_id=3247aa1b-3ae6-42d4-98ad-4651b5a8af68`).

**Symptom:** "Low-Level Design Document" generation never completes — UI polls forever, `pi.agents.lld_status` stays `generating`.

**Root cause:** `pi_agent_lld` worker (`lambdas/pi_agent_lld/handler.py:256-261`) makes a single non-streaming Bedrock call requesting up to 8000 output tokens (Claude Sonnet 4.5) to generate the full LLD markdown. That call blocks until the whole completion is ready. The worker Lambda's timeout is only 300s (`infra/lib/stack.ts:297`) — confirmed in CloudWatch logs: the invocation hit exactly `Billed Duration: 300577 ms ... Status: timeout`. Because it's a hard Lambda timeout (not a catchable Python exception), the `except Exception` block that would set `lld_status='failed'` (handler.py:279-281) never runs, so the row is stuck at `generating` forever. Lambda's automatic async retry (2 retries by default) re-invokes the worker from scratch, which is likely to time out the same way again.

**Proposed fix:** bump `PiAgentLldWorkerFn` timeout from 300s → 900s (Lambda's hard max) in `infra/lib/stack.ts:297`, redeploy. Consider also adding a safety net (e.g. a scheduled sweep that fails-out rows stuck in `generating` past some age) since even a 900s ceiling doesn't guarantee recovery from a genuinely stalled Bedrock call.

**Status:** not fixed. Deferred — user chose to hold off deploying while reviewing the Process Intelligence refinement spec.

---

## 2. `migrations/apply.sh` silently drops all but the first SQL statement — FIXED

**Found:** 2026-08-05, applying `migrations/005_pi_recommendations_agents_plans.sql` to the deployed cluster.

**Symptom:** Script reported "Done." after applying only 1 of 9 statements, no error surfaced. Left `pi.process_graphs.recommendations` column and `pi.agents`/`pi.plans` tables missing, which broke "AI Recommendations" (`DatabaseErrorException: column "recommendations" does not exist`) and "Agentic Workflow" proposed-agents list (`relation "pi.agents" does not exist`).

**Root cause:** `IFS=';' read -ra STMTS <<< "$STATEMENTS"` (`migrations/apply.sh:37` at the time) — plain `read` stops at the first newline regardless of `IFS`, so only the first line of the (multi-line, multi-statement) file was ever split on `;`.

**Fix applied:** changed to `IFS=';' read -d '' -ra STMTS <<< "$STATEMENTS" || true` — `-d ''` makes `read` slurp the entire input (delimiter = NUL, never found) before splitting on `;`. Verified against migration 005: now correctly yields all 9 statements. Migration 005 has been fully applied to the live cluster by running the remaining 8 statements manually.

**Status:** fixed (`migrations/apply.sh`, uncommitted).

---

## 3. Agentic Workflow generation exceeded API Gateway's 29s timeout — FIXED

**Found:** 2026-08-05, immediately after adding the six-stage taxonomy/grounding schema to `tobe_handler` (see refinement work below) and testing live "Apply & Generate."

**Symptom:** "Agentic workflow generation failed" in the UI, even though the Lambda itself completed successfully — CloudWatch showed a 42s invocation for a request the browser had already given up on.

**Root cause:** `tobe_handler` was a synchronous API Gateway route. Adding the richer schema (max_tokens 4096→8000) plus a validate-with-retry loop pushed worst-case latency past API Gateway HTTP API's hard, non-configurable 29s Lambda-proxy integration timeout.

**Fix applied:** converted to the same async trigger+worker+poll pattern already used by `pi_parse`/`pi_agent_lld` — new `PiGraphWorkerFn` Lambda (`handler.tobe_worker_handler`), `pi.process_graphs.tobe_status`/`tobe_error` columns (migration 007), frontend polls `GET .../tobe` until done/failed. Verified working end-to-end live.

**Status:** fixed.

---

## 4. Agentic Workflow `groundingRef` always null — not yet investigated

**Found:** 2026-08-05, verifying the new grounding corpus (`pi.grounding_corpus`, migration 006) after Agentic Workflow generation succeeded.

**Symptom:** every `stages[].groundingRef` in generated output is `null`, even though the corpus is populated (34 chunks across 4 ASOR/Sana docs) and a direct pgvector query against it returns clearly relevant results for a manually-tested query.

**Not yet root-caused.** Candidates: the model may not be reliably matching `[source_document]` tags against the exact string it's asked to echo back; the merged `_kb_block()` text (tenant KB + grounding corpus) may need clearer visual separation between the two sources; or the `_TOBE_SYSTEM` prompt's grounding instruction may need to be more directive about actually using the corpus, not just citing it if present.

**Status:** not fixed. Deferred — logged for follow-up.
