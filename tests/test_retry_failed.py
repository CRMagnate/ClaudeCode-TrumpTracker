"""retry-failed: re-classifies classification_failed mentions in place."""
from __future__ import annotations

from tracker.pipeline import run_poll, run_retry_failed
from tracker.storage import Store

from conftest import MockLLM, canned_response


def _failing_chat(s, u, max_tokens=700):
    return "not json", "mock"


def test_retry_failed_recovers_after_provider_recovery(fixture_feed):
    # First run: every LLM response is invalid -> everything prefilter-passed fails
    store = Store()
    run_poll(feed=fixture_feed, chat=_failing_chat, store=store,
             send_alerts=False, backfill_days=100000)
    failed = [m for m in store.mentions if m["status"] == "classification_failed"]
    assert failed, "expected classification failures with a broken provider"
    assert len(store.signals) == 0

    # Provider recovers: retry sweeps the failures into real classifications
    store2 = Store()
    counts = run_retry_failed(store=store2, chat=MockLLM())
    assert counts["retried"] == len(failed)
    assert counts["classification_failed"] == 0
    ids = {s["signal"]["mention_id"] for s in store2.signals}
    assert "truthsocial:116380894672815869" in ids  # Palantir recovered

    # Idempotent: nothing left to retry
    store3 = Store()
    counts2 = run_retry_failed(store=store3, chat=MockLLM())
    assert counts2["retried"] == 0
    assert len(store3.signals) == len(store2.signals)
