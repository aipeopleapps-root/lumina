"""Azure AI Foundry / Azure OpenAI client helpers — embeddings and generation."""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from azure.ai.inference import ChatCompletionsClient
from azure.ai.inference.models import (
    SystemMessage,
    UserMessage,
    AssistantMessage,
    TextContentItem,
    ImageContentItem,
    ImageUrl,
)
from azure.identity import DefaultAzureCredential
from openai import AzureOpenAI

log = logging.getLogger(__name__)

_EMBEDDING_MODEL_NAME = os.environ["EMBEDDING_MODEL_NAME"]
_GENERATION_MODEL_NAME = os.environ["GENERATION_MODEL_NAME"]
_EMBEDDING_DIM = int(os.environ.get("EMBEDDING_DIM", "1024"))

_credential = DefaultAzureCredential()

_chat_client = ChatCompletionsClient(
    endpoint=os.environ["AZURE_AI_FOUNDRY_ENDPOINT"],
    credential=_credential,
)

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
    Translate a vendor-neutral content payload into azure-ai-inference SDK types.
    Plain strings pass through unchanged. Multimodal messages use the same
    block shape as Anthropic's Messages API (`{"type": "text"/"image", ...}`)
    so callers don't need to know about the underlying inference SDK —
    translated here into `TextContentItem`/`ImageContentItem`.
    """
    if isinstance(content, str):
        return content

    items: list[Any] = []
    for block in content:
        block_type = block.get("type")
        if block_type == "text":
            items.append(TextContentItem(text=block["text"]))
        elif block_type in ("image", "document"):
            # azure-ai-inference has no distinct "document" content item; PDFs
            # are passed the same way as images (base64 data URL) — needs
            # verification against the live Foundry deployment (see Phase 6 notes).
            source = block["source"]
            data_url = f"data:{source['media_type']};base64,{source['data']}"
            items.append(ImageContentItem(image_url=ImageUrl(url=data_url)))
        else:
            raise ValueError(f"unsupported content block type: {block_type!r}")
    return items


def _to_inference_messages(system: str, messages: list[dict[str, Any]]) -> list[Any]:
    out: list[Any] = [SystemMessage(content=system)]
    for m in messages:
        role = m.get("role")
        content = _to_content_items(m.get("content"))
        if role == "assistant":
            out.append(AssistantMessage(content=content))
        else:
            out.append(UserMessage(content=content))
    return out


def generate(
    system: str,
    messages: list[dict[str, Any]],
    max_tokens: int = 2048,
    temperature: float = 0.2,
) -> str:
    """
    Call Claude via Azure AI Foundry's chat completions API. Returns the
    text content of the response.
    """
    resp = _chat_client.complete(
        model=_GENERATION_MODEL_NAME,
        messages=_to_inference_messages(system, messages),
        max_tokens=max_tokens,
        temperature=temperature,
    )
    return resp.choices[0].message.content or ""


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
