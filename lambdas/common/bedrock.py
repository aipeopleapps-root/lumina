"""Bedrock client helpers — embeddings and generation."""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import boto3

log = logging.getLogger(__name__)

_EMBEDDING_MODEL_ID = os.environ["EMBEDDING_MODEL_ID"]
_GENERATION_MODEL_ID = os.environ["GENERATION_MODEL_ID"]
_EMBEDDING_DIM = int(os.environ.get("EMBEDDING_DIM", "1024"))

_bedrock = boto3.client("bedrock-runtime")


def embed(text: str) -> list[float]:
    """Return a single embedding vector for a chunk of text."""
    body = json.dumps({"inputText": text, "dimensions": _EMBEDDING_DIM, "normalize": True})
    resp = _bedrock.invoke_model(modelId=_EMBEDDING_MODEL_ID, body=body)
    payload = json.loads(resp["body"].read())
    return payload["embedding"]


def embed_batch(texts: list[str]) -> list[list[float]]:
    """Titan v2 is single-input; loop. For prod, consider Cohere multi or Titan batch."""
    return [embed(t) for t in texts]


def generate(
    system: str,
    messages: list[dict[str, Any]],
    max_tokens: int = 2048,
    temperature: float = 0.2,
) -> str:
    """
    Call Claude via the Bedrock Messages API. Returns the concatenated
    text content of the response.
    """
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "temperature": temperature,
        "system": system,
        "messages": messages,
    }
    resp = _bedrock.invoke_model(
        modelId=_GENERATION_MODEL_ID,
        body=json.dumps(body),
        contentType="application/json",
        accept="application/json",
    )
    payload = json.loads(resp["body"].read())
    parts: list[str] = []
    for block in payload.get("content", []):
        if block.get("type") == "text":
            parts.append(block["text"])
    return "".join(parts)


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
