"""Shared test plumbing. All tests run offline with a mocked LLM (§11)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    """Run from repo root (config/ paths) but write data to a temp dir; make
    sure no real API keys or alert channels leak into tests."""
    monkeypatch.chdir(REPO_ROOT)
    for var in ("GROQ_API_KEY", "GEMINI_API_KEY", "TELEGRAM_BOT_TOKEN",
                "TELEGRAM_CHAT_ID", "EMAIL_USER", "EMAIL_PASSWORD", "EMAIL_TO",
                "RESEND_API_KEY", "TRACKER_DATA_DIR"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("TRACKER_DATA_DIR", str(tmp_path / "data"))
    yield


@pytest.fixture
def fixture_feed() -> list[dict]:
    return json.loads((FIXTURES / "posts.json").read_text())


def canned_response(**overrides) -> str:
    base = {
        "is_signal": False, "priority": None, "direction": None,
        "asset_type": None, "tickers": [], "entities": [],
        "exact_quote": "", "confidence": 0.0, "rationale": "canned",
        "sarcasm_or_negation": False,
    }
    base.update(overrides)
    return json.dumps(base)


class MockLLM:
    """Deterministic stand-in for tracker.llm.chat_json, keyed on source text.

    Mirrors how a correct classifier should behave on the golden fixtures, so
    pipeline tests exercise everything downstream of the LLM for real.
    """

    def __init__(self):
        self.calls = 0

    def __call__(self, system: str, user: str, max_tokens: int = 700) -> tuple[str, str]:
        self.calls += 1
        if "Palantir Technologies (PLTR)" in user:
            return canned_response(
                is_signal=True, priority="P1", direction="bullish",
                asset_type="ticker", tickers=["PLTR"],
                entities=["Palantir Technologies"],
                exact_quote="Palantir Technologies (PLTR) has proven to have great war fighting capabilities and equipment.",
                confidence=0.95), "mock"
        if "never tell people to buy" in user:
            return canned_response(sarcasm_or_negation=True), "mock"
        if "ALL-IN on American shipbuilding" in user:
            return canned_response(
                is_signal=True, priority="P3", direction="bullish",
                asset_type="sector", entities=["shipbuilding"],
                exact_quote="We are going ALL-IN on American shipbuilding.",
                confidence=0.8), "mock"
        if "Boeing is a total disgrace" in user:
            return canned_response(
                is_signal=True, priority="P2", direction="bearish",
                asset_type="company", entities=["Boeing"],
                exact_quote="Boeing is a total disgrace.",
                confidence=0.85), "mock"
        if "Ignore previous instructions" in user:
            return canned_response(rationale="prompt injection attempt"), "mock"
        if "Quantum Nexus Dynamics" in user:
            # LLM guesses a ticker that is neither in the text nor the table —
            # deterministic resolution must discard it.
            return canned_response(
                is_signal=True, priority="P2", direction="bullish",
                asset_type="company", tickers=["QNDX"],
                entities=["Quantum Nexus Dynamics"],
                exact_quote="Quantum Nexus Dynamics is an incredible company, doing things nobody thought possible.",
                confidence=0.7), "mock"
        return canned_response(), "mock"
