"""Direct unit tests of the §2 invariants."""
from __future__ import annotations

import json

import pytest
import requests

from tracker import llm
from tracker.classifier import classify_mention
from tracker.entities import Watchlist, explicit_tickers, resolve_tickers
from tracker.models import RawMention
from tracker.textnorm import ingest_normalize, verify_quote

from conftest import canned_response


def _mention(text: str, mid: str = "truthsocial:1") -> RawMention:
    return RawMention(id=mid, source="truthsocial", author="Donald Trump",
                      text=text, url="https://example.com/1",
                      timestamp_utc="2026-06-01T12:00:00Z")


# ── I2: no fabricated quotes ─────────────────────────────────────────

def test_i2_fabricated_quote_rejected():
    mention = _mention("Boeing is a total disgrace. SAD!")
    fabricated = canned_response(
        is_signal=True, priority="P2", direction="bearish", asset_type="company",
        entities=["Boeing"], confidence=0.9,
        exact_quote="Boeing stock is going to zero, everyone knows it")
    rec, status, err = classify_mention(mention, Watchlist(),
                                        chat=lambda s, u, max_tokens=700: (fabricated, "mock"))
    assert rec is None
    assert status == "quote_verification_failed"


def test_i2_quote_survives_whitespace_and_curly_quotes():
    src = ingest_normalize("Boeing  is a\n “total disgrace”. SAD!")
    got = verify_quote('Boeing is a "total disgrace".', src)
    assert got == 'Boeing is a "total disgrace".'


def test_i2_stored_quote_is_taken_from_source_not_llm():
    src = "Boeing Is A Total Disgrace. SAD!"
    got = verify_quote("boeing is a total disgrace.", src)
    assert got == "Boeing Is A Total Disgrace."  # source casing wins


# ── I4: schema or nothing, one retry, never crash ────────────────────

def test_i4_invalid_then_valid_retry_succeeds():
    responses = iter([
        "this is not json at all",
        canned_response(is_signal=True, priority="P2", direction="bullish",
                        asset_type="company", entities=["Boeing"],
                        exact_quote="Boeing is doing great work", confidence=0.8),
    ])
    calls = []

    def chat(s, u, max_tokens=700):
        calls.append(u)
        return next(responses), "mock"

    rec, status, _ = classify_mention(_mention("Boeing is doing great work, tremendous!"),
                                      Watchlist(), chat=chat)
    assert status == "classified_signal"
    assert len(calls) == 2
    assert "previous response was invalid" in calls[1]


def test_i4_invalid_twice_marks_failed_without_raising():
    def chat(s, u, max_tokens=700):
        return '{"is_signal": "definitely", "confidence": "high"}', "mock"

    rec, status, err = classify_mention(_mention("Boeing is great"), Watchlist(), chat=chat)
    assert rec is None
    assert status == "classification_failed"
    assert err is not None


# ── I6: provider failover ────────────────────────────────────────────

def test_i6_groq_429_fails_over_to_gemini(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key-a")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-b")
    monkeypatch.setenv("LLM_PRIMARY", "groq")
    monkeypatch.setenv("LLM_FALLBACK", "gemini")
    seen = []

    class FakeResp:
        def __init__(self, status, content=""):
            self.status_code = status
            self._content = content
        def raise_for_status(self):
            if self.status_code >= 400:
                raise requests.HTTPError(f"HTTP {self.status_code}")
        def json(self):
            return {"choices": [{"message": {"content": self._content}}]}

    def fake_post(url, **kwargs):
        seen.append(url)
        if "groq" in url:
            return FakeResp(429)
        return FakeResp(200, '{"ok": true}')

    monkeypatch.setattr(llm.requests, "post", fake_post)
    content, provider = llm.chat_json("sys", "user")
    assert provider == "gemini"
    assert len(seen) == 2


def test_i6_all_providers_down_raises_cleanly(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key-a")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-b")

    def fake_post(url, **kwargs):
        raise requests.Timeout("timed out")

    monkeypatch.setattr(llm.requests, "post", fake_post)
    with pytest.raises(llm.AllProvidersFailed) as exc:
        llm.chat_json("sys", "user")
    # I8: the error surface must not contain the keys
    assert "test-key-a" not in str(exc.value)
    assert "test-key-b" not in str(exc.value)


# ── §5 deterministic ticker resolution ───────────────────────────────

def test_explicit_ticker_taken_as_is():
    assert explicit_tickers("Palantir Technologies (PLTR) is great, so is $NVDA") == ["NVDA", "PLTR"] or \
           explicit_tickers("Palantir Technologies (PLTR) is great, so is $NVDA") == ["PLTR", "NVDA"]


def test_paren_stopwords_not_tickers():
    assert explicit_tickers("Made in the (USA) with great (AI) technology") == []


def test_watchlist_resolution_without_explicit_ticker():
    wl = Watchlist()
    assert resolve_tickers("Boeing is a disgrace", [], wl) == ["BA"]


def test_unknown_llm_ticker_discarded():
    wl = Watchlist()
    assert resolve_tickers("Quantum Nexus Dynamics is incredible", ["Quantum Nexus Dynamics"], wl) == []
