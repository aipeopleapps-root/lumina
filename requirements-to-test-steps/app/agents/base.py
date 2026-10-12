from __future__ import annotations

import asyncio
import json
import logging
import time

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)

_RETRY_DELAYS = [2, 4, 8]


async def call_llm(
    system_prompt: str,
    user_message: str,
    settings: Settings,
) -> dict:
    """Call the LLM gateway and return the parsed JSON response dict.

    Retries up to 3 times with exponential backoff on HTTP 429.
    Raises RuntimeError on any other non-2xx response.
    """
    headers = {
        "api-key": settings.LLM_GATEWAY_API_KEY,
        "Content-Type": "application/json",
    }
    payload = {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        "max_completion_tokens": settings.LLM_MAX_TOKENS,
        "response_format": {"type": "json_object"},
    }

    async with httpx.AsyncClient(timeout=settings.LLM_TIMEOUT_SECONDS) as client:
        for attempt, delay in enumerate(_RETRY_DELAYS, start=1):
            start = time.monotonic()
            response = await client.post(
                settings.LLM_GATEWAY_URL,
                headers=headers,
                json=payload,
            )
            elapsed = time.monotonic() - start

            if response.status_code == 429:
                logger.warning(
                    "LLM gateway returned 429 (attempt %d/3); retrying in %ds",
                    attempt,
                    delay,
                )
                await asyncio.sleep(delay)
                continue

            if response.status_code >= 300:
                raise RuntimeError(
                    f"LLM gateway error {response.status_code}: {response.text}"
                )

            body = response.json()
            usage = body.get("usage", {})
            logger.debug(
                "LLM call completed in %.2fs | prompt_tokens=%s completion_tokens=%s",
                elapsed,
                usage.get("prompt_tokens", "n/a"),
                usage.get("completion_tokens", "n/a"),
            )

            raw_content: str = body["choices"][0]["message"]["content"]
            try:
                return json.loads(raw_content)
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    f"LLM returned invalid JSON. Raw response: {raw_content!r}"
                ) from exc

        # All retries exhausted (last attempt was a 429)
        raise RuntimeError("LLM gateway returned 429 on all 3 attempts.")
