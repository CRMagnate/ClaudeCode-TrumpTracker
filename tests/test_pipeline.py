"""End-to-end pipeline tests on the golden fixtures — offline, mocked LLM."""
from __future__ import annotations

import json
from pathlib import Path

from tracker.pipeline import run_poll
from tracker.storage import Store

from conftest import MockLLM


def _store(tmp_path=None) -> Store:
    return Store()  # TRACKER_DATA_DIR is pointed at a tmp dir by conftest


def test_palantir_fixture_is_p1_bullish_pltr(fixture_feed):
    """M1 DoD acceptance test: the canonical P1 example."""
    store = _store()
    run_poll(feed=fixture_feed, chat=MockLLM(), store=store, send_alerts=False,
             backfill_days=100000)
    pltr = [s for s in store.signals
            if s["signal"]["mention_id"] == "truthsocial:116380894672815869"]
    assert len(pltr) == 1
    sig = pltr[0]["signal"]
    assert sig["priority"] == "P1"
    assert sig["direction"] == "bullish"
    assert sig["tickers"] == ["PLTR"]
    assert sig["exact_quote"] in pltr[0]["source_text"]  # I2 end-to-end


def test_sarcasm_and_injection_produce_no_actionable_signal(fixture_feed):
    store = _store()
    run_poll(feed=fixture_feed, chat=MockLLM(), store=store, send_alerts=False,
             backfill_days=100000)
    signal_ids = {s["signal"]["mention_id"] for s in store.signals}
    assert "truthsocial:900000000000000002" not in signal_ids  # negation
    assert "truthsocial:900000000000000007" not in signal_ids  # injection


def test_fixture_dispositions(fixture_feed):
    store = _store()
    run_poll(feed=fixture_feed, chat=MockLLM(), store=store, send_alerts=False,
             backfill_days=100000)
    by_id = {m["mention"]["id"]: m for m in store.mentions}
    assert by_id["truthsocial:900000000000000005"]["status"] == "prefiltered_out"   # rally
    assert by_id["truthsocial:900000000000000006"]["status"] == "skipped_not_trump" # re-truth
    assert by_id["truthsocial:900000000000000006"]["mention"]["author"].startswith("retruth:")
    assert by_id["truthsocial:900000000000000009"]["status"] == "skipped_no_text"   # media-only
    assert by_id["truthsocial:900000000000000004"]["status"] == "classified_signal" # bearish
    bearish = next(s for s in store.signals
                   if s["signal"]["mention_id"] == "truthsocial:900000000000000004")
    assert bearish["signal"]["direction"] == "bearish"
    assert bearish["signal"]["tickers"] == ["BA"]  # resolved via entities table


def test_llm_guessed_ticker_is_discarded(fixture_feed):
    """§5: never accept a ticker that is in neither the text nor the table."""
    store = _store()
    run_poll(feed=fixture_feed, chat=MockLLM(), store=store, send_alerts=False,
             backfill_days=100000)
    rec = next(s for s in store.signals
               if s["signal"]["mention_id"] == "truthsocial:900000000000000008")
    assert rec["signal"]["tickers"] == []
    assert rec["signal"]["entities"] == ["Quantum Nexus Dynamics"]


def test_rerun_is_idempotent(fixture_feed):
    """I5: re-running on the same data yields zero duplicates."""
    store = _store()
    first = run_poll(feed=fixture_feed, chat=MockLLM(), store=store,
                     send_alerts=False, backfill_days=100000)
    n_mentions, n_signals = len(store.mentions), len(store.signals)
    assert first["classified_signal"] > 0

    store2 = Store()  # fresh instance, same persisted data dir
    mock2 = MockLLM()
    second = run_poll(feed=fixture_feed, chat=mock2, store=store2,
                      send_alerts=False, backfill_days=100000)
    assert len(store2.mentions) == n_mentions
    assert len(store2.signals) == n_signals
    assert second["new"] == 0
    assert mock2.calls == 0  # nothing was re-classified either


def test_prefilter_pass_rate_logged(fixture_feed):
    store = _store()
    summary = run_poll(feed=fixture_feed, chat=MockLLM(), store=store,
                       send_alerts=False, backfill_days=100000)
    assert "prefilter_pass_rate_pct" in summary
    stats = store.state["prefilter_stats"]
    assert stats["total"] > 0 and 0 < stats["passed"] <= stats["total"]


def test_classification_limit_resumes_cleanly(fixture_feed):
    """A --limit run must not advance the cursor past unprocessed posts."""
    store = _store()
    run_poll(feed=fixture_feed, chat=MockLLM(), store=store, send_alerts=False,
             backfill_days=100000, limit=1)
    assert len(store.signals) == 1  # only the Palantir post got classified

    store2 = Store()
    run_poll(feed=fixture_feed, chat=MockLLM(), store=store2, send_alerts=False,
             backfill_days=100000)
    ids = {s["signal"]["mention_id"] for s in store2.signals}
    assert "truthsocial:900000000000000004" in ids  # Boeing picked up on resume
    assert len(store2.mentions) == len(fixture_feed)
