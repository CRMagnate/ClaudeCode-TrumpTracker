"""OpenAI-compatible chat client with provider failover (§3, I6).

Primary → fallback on 429 / 5xx / timeout / connection error. Providers,
models, and order come from env vars. Temperature 0, JSON response format,
small token budget. API keys never appear in logs or exceptions (I8).
"""
from __future__ import annotations

import json
import logging
import os
import time

import requests

log = logging.getLogger(__name__)

PROVIDERS = {
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "key_env": "GROQ_API_KEY",
        "model_env": "GROQ_MODEL",
        "default_model": "llama-3.3-70b-versatile",
    },
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "key_env": "GEMINI_API_KEY",
        "model_env": "GEMINI_MODEL",
        "default_model": "gemini-2.0-flash",
    },
}


class AllProvidersFailed(Exception):
    """Raised when every configured provider failed. Message is key-free (I8)."""


def _provider_order() -> list[str]:
    order = [os.environ.get("LLM_PRIMARY", "groq")]
    fb = os.environ.get("LLM_FALLBACK", "gemini")
    if fb and fb != "none" and fb not in order:
        order.append(fb)
    return [p for p in order if p in PROVIDERS]


def _call_provider(name: str, messages: list[dict], max_tokens: int) -> str:
    cfg = PROVIDERS[name]
    key = os.environ.get(cfg["key_env"], "")
    if not key:
        raise requests.ConnectionError(f"{name}: no API key configured")
    model = os.environ.get(cfg["model_env"]) or cfg["default_model"]

    for attempt in (1, 2):
        resp = requests.post(
            f"{cfg['base_url']}/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": model,
                "messages": messages,
                "temperature": 0,
                "max_tokens": max_tokens,
                "response_format": {"type": "json_object"},
            },
            timeout=60,
        )
        if resp.status_code == 429 and attempt == 1:
            # Rate limit: honor Retry-After (capped) once before failing over,
            # so a burst (e.g. backfill) doesn't burn mentions as failed.
            wait = min(float(resp.headers.get("retry-after") or 10), 30.0)
            log.info("%s rate-limited; waiting %.1fs and retrying", name, wait)
            time.sleep(wait)
            continue
        if resp.status_code == 429 or resp.status_code >= 500:
            raise requests.HTTPError(f"{name}: HTTP {resp.status_code}", response=resp)
        resp.raise_for_status()  # other 4xx = config error, don't failover silently
        return resp.json()["choices"][0]["message"]["content"]
    raise requests.HTTPError(f"{name}: HTTP 429 after retry")


def chat_json(system: str, user: str, max_tokens: int = 700) -> tuple[str, str]:
    """Return (response text, provider name). Fails over per I6."""
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    errors: list[str] = []
    for name in _provider_order():
        try:
            return _call_provider(name, messages, max_tokens), name
        except (requests.Timeout, requests.ConnectionError, requests.HTTPError) as e:
            # str(e) here never contains the API key: our messages are
            # provider-name + status only, requests errors carry the URL.
            msg = f"{name} failed: {e.__class__.__name__}: {e}"
            log.warning(msg)
            errors.append(msg)
    raise AllProvidersFailed("; ".join(errors) or "no providers configured")
