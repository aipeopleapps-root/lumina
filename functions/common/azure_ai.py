"""Azure AI Foundry / Azure OpenAI client helpers — embeddings and generation."""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

import requests
from azure.identity import DefaultAzureCredential
from openai import AzureOpenAI

log = logging.getLogger(__name__)

# Retry only on transient failures (rate limiting, momentary unavailability, a dropped
# connection) — never on a persistent failure (400/401/403/404, i.e. a bad request or the model
# not being deployed at all), where retrying just delays an error that won't resolve itself.
# Exponential backoff, same delay schedule as requirements-to-test-steps/app/agents/base.py's
# proven 429-retry logic (this app's own origin/sibling codebase) — ported here since every one
# of Lumina's AI-calling apps (Process Intelligence, Test Automation Suite, Ask Stuey, RFP
# Reimagine) routes through this one function, so fixing it once covers all of them.
_RETRY_STATUS_CODES = {429, 503}
_RETRY_DELAYS = [2, 4, 8]

_EMBEDDING_MODEL_NAME = os.environ["EMBEDDING_MODEL_NAME"]
_GENERATION_MODEL_NAME = os.environ["GENERATION_MODEL_NAME"]
_EMBEDDING_DIM = int(os.environ.get("EMBEDDING_DIM", "1024"))

_credential = DefaultAzureCredential()

# Claude is deployed on the Foundry account as an Anthropic-format model.
# Confirmed live against the real deployment that neither azure-ai-inference's
# unified `/models/chat/completions` route nor the OpenAI-compatible
# `/openai/deployments/{name}/chat/completions` shim are reliable for it (the
# former 404s outright, the latter alternates between working and 404 across
# otherwise-identical calls). Anthropic's own native `/anthropic/v1/messages`
# passthrough route is the one that responds correctly and consistently, so
# generation calls a raw REST request against it directly rather than going
# through either SDK's chat-completions abstraction.
_FOUNDRY_ENDPOINT = os.environ["AZURE_AI_FOUNDRY_ENDPOINT"].rstrip("/")
_FOUNDRY_API_VERSION = os.environ.get("AZURE_AI_FOUNDRY_API_VERSION", "2024-05-01-preview")
_ANTHROPIC_VERSION = "2023-06-01"


def _foundry_token() -> str:
    return _credential.get_token("https://cognitiveservices.azure.com/.default").token


_openai_client = AzureOpenAI(
    azure_endpoint=os.environ["AZURE_OPENAI_ENDPOINT"],
    azure_ad_token_provider=lambda: _credential.get_token(
        "https://cognitiveservices.azure.com/.default"
    ).token,
    api_version=os.environ.get("AZURE_OPENAI_API_VERSION", "2024-06-01"),
)


def embed(text: str) -> list[float]:
    """Return a single embedding vector for a chunk of text."""
    resp = _openai_client.embeddings.create(
        model=_EMBEDDING_MODEL_NAME,
        input=text,
        dimensions=_EMBEDDING_DIM,
    )
    return resp.data[0].embedding


def embed_batch(texts: list[str]) -> list[list[float]]:
    """Azure OpenAI accepts list input natively — one call for the whole batch."""
    if not texts:
        return []
    resp = _openai_client.embeddings.create(
        model=_EMBEDDING_MODEL_NAME,
        input=texts,
        dimensions=_EMBEDDING_DIM,
    )
    return [d.embedding for d in resp.data]


def _to_content_items(content: Any) -> Any:
    """
    Pass through a vendor-neutral content payload largely unchanged — callers
    already build multimodal messages using Anthropic's own Messages API
    block shape (`{"type": "text"/"image"/"document", "source": {"type":
    "base64", "media_type": ..., "data": ...}}`), which is what the native
    `/anthropic/v1/messages` route expects directly. Only "document" blocks
    need normalizing: Anthropic has no distinct document type for anything
    but PDFs passed as base64, which is already the shape callers use, so
    "document" is just relabeled "image" — Claude accepts PDF pages as images.
    """
    if isinstance(content, str):
        return content

    items: list[Any] = []
    for block in content:
        block_type = block.get("type")
        if block_type == "text":
            items.append({"type": "text", "text": block["text"]})
        elif block_type in ("image", "document"):
            items.append({"type": "image", "source": block["source"]})
        else:
            raise ValueError(f"unsupported content block type: {block_type!r}")
    return items


def _to_anthropic_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in messages:
        role = m.get("role") or "user"
        out.append({"role": role, "content": _to_content_items(m.get("content"))})
    return out


def generate(
    system: str,
    messages: list[dict[str, Any]],
    max_tokens: int = 2048,
    temperature: float = 0.2,
) -> str:
    """
    Call Claude via Azure AI Foundry's native Anthropic Messages API
    passthrough. Returns the text content of the response.

    Retries with exponential backoff on 429/503 and on a dropped connection/timeout
    (see _RETRY_STATUS_CODES/_RETRY_DELAYS above); any other non-2xx response raises
    immediately via raise_for_status(), unretried.
    """
    last_exc: Exception | None = None
    for attempt, delay in enumerate([0] + _RETRY_DELAYS, start=1):
        if delay:
            log.warning("azure_ai.generate: retrying (attempt %d) in %ds", attempt, delay)
            time.sleep(delay)
        try:
            resp = requests.post(
                f"{_FOUNDRY_ENDPOINT}/anthropic/v1/messages",
                params={"api-version": _FOUNDRY_API_VERSION},
                headers={
                    "Authorization": f"Bearer {_foundry_token()}",
                    "anthropic-version": _ANTHROPIC_VERSION,
                    "Content-Type": "application/json",
                },
                json={
                    "model": _GENERATION_MODEL_NAME,
                    "system": system,
                    "messages": _to_anthropic_messages(messages),
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                },
                timeout=120,
            )
        except (requests.ConnectionError, requests.Timeout) as exc:
            last_exc = exc
            continue
        if resp.status_code in _RETRY_STATUS_CODES:
            last_exc = requests.HTTPError(f"{resp.status_code} {resp.reason}", response=resp)
            continue
        resp.raise_for_status()
        data = resp.json()
        return "".join(
            block.get("text", "") for block in data.get("content", []) if block.get("type") == "text"
        )
    assert last_exc is not None
    raise last_exc


def generate_json(
    system: str,
    user_prompt: str,
    *,
    max_tokens: int = 2048,
    temperature: float = 0.1,
) -> dict[str, Any]:
    """
    Structured output helper. Instructs Claude to respond with raw JSON,
    strips any accidental code fences, and parses.
    """
    strict_system = (
        system
        + "\n\nRespond with a single JSON object. No preamble, no markdown "
          "code fences, no explanation outside the JSON."
    )
    raw = generate(
        strict_system,
        [{"role": "user", "content": user_prompt}],
        max_tokens=max_tokens,
        temperature=temperature,
    ).strip()
    # Defensive: strip ```json fences if the model added them anyway.
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:].lstrip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        log.error("failed to parse Claude JSON response: %s", raw[:500])
        raise ValueError("model did not return valid JSON") from exc
