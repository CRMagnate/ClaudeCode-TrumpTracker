"""Pipeline orchestrator + CLI.

  python -m tracker.pipeline poll [--backfill-days N] [--limit N] [--no-alerts]
  python -m tracker.pipeline test-alert

Order per run: ingest → prefilter → classify → store → alert P1/P2 (§9).
Everything is idempotent: re-running on the same feed adds nothing (I5).
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import alerts
from .classifier import classify_mention
from .entities import Watchlist
from .models import TRUMP_AUTHOR, MentionRecord, RawMention
from .prefilter import Prefilter
from .storage import Store, atomic_write_json
from .sources import truthsocial

log = logging.getLogger("tracker")


def load_dotenv(path: str = ".env") -> None:
    """Minimal .env loader (no extra dependency). Real env vars win."""
    p = Path(path)
    if not p.exists():
        return
    import re
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        # Strip inline comments (whitespace + #). Quoted values keep everything.
        v = v.strip()
        if v.startswith('"') and v.endswith('"') and len(v) >= 2:
            v = v[1:-1]
        else:
            v = re.split(r"\s+#", v)[0].strip()
        os.environ.setdefault(k.strip(), v)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def run_poll(backfill_days: int | None = None, limit: int | None = None,
             send_alerts: bool = True, feed: list[dict] | None = None,
             chat=None, store: Store | None = None) -> dict:
    store = store or Store()
    watchlist = Watchlist()
    prefilter = Prefilter(watchlist)

    last_seen = store.state.get("truthsocial_last_seen_id")
    if last_seen is None and backfill_days is None:
        backfill_days = 14  # first run defaults to the M1 backfill window

    counts = {"new": 0, "skipped_no_text": 0, "skipped_not_trump": 0,
              "prefiltered_out": 0, "classified_signal": 0,
              "classified_non_signal": 0, "classification_failed": 0,
              "quote_verification_failed": 0}
    priorities: list[str] = []

    if os.environ.get("SOURCE_TRUTHSOCIAL_ENABLED", "1") == "1":
        try:
            new_mentions, cursor = truthsocial.fetch_new(last_seen, backfill_days, feed=feed)
        except truthsocial.SchemaDriftError:
            raise  # §4: fail loudly, do not ingest garbage
        except Exception as e:
            # I6: source down → log and continue (alert retries still run below)
            log.error("truthsocial fetch failed: %s", e.__class__.__name__)
            new_mentions, cursor = [], last_seen
    else:
        new_mentions, cursor = [], last_seen

    classified = 0
    processed_cursor = last_seen
    for m in new_mentions:
        if store.has_mention(m["id"]):
            processed_cursor = m["id"].split(":")[1]
            continue

        if limit is not None and classified >= limit:
            # Classification budget exhausted: stop here and leave the cursor
            # at the last processed post so the next run resumes cleanly.
            log.info("classification limit %d reached; resuming next run", limit)
            break

        counts["new"] += 1
        mention = RawMention(
            id=m["id"], source=m["source"], author=m["author"],
            text=m["text"], url=m["url"], timestamp_utc=m["timestamp_utc"],
        )

        if m["empty"]:
            status, matches, err = "skipped_no_text", [], None
        elif mention.author != TRUMP_AUTHOR:
            status, matches, err = "skipped_not_trump", [], None
        else:
            passed, matches = prefilter.check(mention.text)
            store.state["prefilter_stats"]["total"] += 1
            if not passed:
                status, err = "prefiltered_out", None
            else:
                store.state["prefilter_stats"]["passed"] += 1
                classified += 1
                signal_rec, status, err = classify_mention(mention, watchlist, chat=chat)
                if signal_rec is not None:
                    store.add_signal(json.loads(signal_rec.model_dump_json()))
                    priorities.append(signal_rec.signal.priority or "?")

        counts[status] += 1
        record = MentionRecord(mention=mention, status=status,
                               prefilter_matches=matches, error=err,
                               ingested_at_utc=_now_iso())
        store.add_mention(json.loads(record.model_dump_json()))
        processed_cursor = m["id"].split(":")[1]

    if processed_cursor is not None:
        store.state["truthsocial_last_seen_id"] = processed_cursor
    elif cursor is not None and not new_mentions:
        store.state["truthsocial_last_seen_id"] = cursor

    alert_counts = {"sent": 0, "failed": 0}
    if send_alerts:
        min_conf = float(os.environ.get("ALERT_MIN_CONFIDENCE", "0"))
        alert_counts = alerts.dispatch_immediate_alerts(store, min_conf)

    store.save()

    stats = store.state["prefilter_stats"]
    rate = (stats["passed"] / stats["total"] * 100) if stats["total"] else 0.0
    summary = {**counts, "alerts": alert_counts,
               "prefilter_pass_rate_pct": round(rate, 1),
               "signal_priorities": priorities, "run_at_utc": _now_iso()}
    atomic_write_json(store.dir / "run_summary.json", summary)
    log.info("run summary: %s", json.dumps(summary))
    return summary


def run_retry_failed(limit: int | None = None, store: Store | None = None,
                     chat=None) -> dict:
    """Re-classify mentions stuck in classification_failed (e.g. a provider
    outage exhausted the failover). Updates records in place; idempotent."""
    store = store or Store()
    watchlist = Watchlist()
    counts = {"retried": 0, "classified_signal": 0, "classified_non_signal": 0,
              "classification_failed": 0, "quote_verification_failed": 0}
    for record in store.mentions:
        if record["status"] != "classification_failed":
            continue
        if limit is not None and counts["retried"] >= limit:
            break
        counts["retried"] += 1
        mention = RawMention(**record["mention"])
        signal_rec, status, err = classify_mention(mention, watchlist, chat=chat)
        if signal_rec is not None and not store.has_signal(mention.id):
            store.add_signal(json.loads(signal_rec.model_dump_json()))
        record["status"] = status
        record["error"] = err
        counts[status] += 1
    store.save()
    log.info("retry summary: %s", json.dumps(counts))
    return counts


def run_test_alert() -> None:
    """Send a live P1-formatted test alert on every configured channel (M1 DoD)."""
    rec = {
        "signal": {"mention_id": "test:0", "priority": "P1", "direction": "bullish",
                   "tickers": ["PLTR"], "entities": ["Palantir Technologies"],
                   "exact_quote": "TEST ALERT — Palantir Technologies (PLTR) has proven to have great war fighting capabilities and equipment.",
                   "confidence": 0.95},
        "url": "https://truthsocial.com/@realDonaldTrump/116380894672815869",
        "timestamp_utc": _now_iso(),
    }
    text = alerts.format_alert(rec)
    print(text, "\n")
    results = {}
    if alerts.telegram_configured():
        results["telegram"] = alerts.send_telegram(text)
    if alerts.email_configured():
        results["email"] = alerts.send_email("[P1] PLTR — test alert", text)
    if not results:
        print("No alert channels configured (set TELEGRAM_* and/or EMAIL_*/RESEND_* env vars).")
    for channel, ok in results.items():
        print(f"{channel}: {'delivered' if ok else 'FAILED'}")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    load_dotenv()
    ap = argparse.ArgumentParser(prog="tracker")
    sub = ap.add_subparsers(dest="cmd", required=True)
    poll = sub.add_parser("poll", help="ingest → classify → alert → store")
    poll.add_argument("--backfill-days", type=int, default=None)
    poll.add_argument("--limit", type=int, default=None, help="max LLM classifications this run")
    poll.add_argument("--no-alerts", action="store_true")
    sub.add_parser("test-alert", help="send a P1-formatted test alert")
    retry = sub.add_parser("retry-failed", help="re-classify classification_failed mentions")
    retry.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    if args.cmd == "poll":
        run_poll(backfill_days=args.backfill_days, limit=args.limit,
                 send_alerts=not args.no_alerts)
    elif args.cmd == "test-alert":
        run_test_alert()
    elif args.cmd == "retry-failed":
        run_retry_failed(limit=args.limit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
