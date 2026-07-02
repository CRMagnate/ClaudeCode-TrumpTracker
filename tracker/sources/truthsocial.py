"""Truth Social adapter — polls the free CNN public archive (§4, Milestone 1).

Feed observed 2026-07-01: JSON array, newest first, ~34k posts back to 2022,
items = {id, created_at, content, url, media, replies_count, reblogs_count,
favourites_count}. Content is plain text (no HTML observed, but we strip
defensively). Re-truths come in two shapes:
    "RT: https://truthsocial.com/users/<author>/statuses/<id>[quoted text]"
    "RT @<author><text>"
Both are treated as non-original: stored with the extracted author, never
classified as Trump's own words (self-retruths duplicate a post that is
already in the archive under its own id).
"""
from __future__ import annotations

import logging
import os
import re

import requests

from ..models import TRUMP_AUTHOR
from ..textnorm import ingest_normalize

log = logging.getLogger(__name__)

DEFAULT_URL = "https://ix.cnn.io/data/truth-social/truth_archive.json"

REQUIRED_FIELDS = {"id", "created_at", "content", "url"}

_RT_URL_RE = re.compile(r"^RT: https?://truthsocial\.com/users/([^/]+)/statuses/\d+")
_RT_AT_RE = re.compile(r"^RT @(\w+)")


class SchemaDriftError(Exception):
    """§4: on feed schema drift, fail the run loudly — never ingest garbage."""


def _fetch_feed() -> list[dict]:
    url = os.environ.get("TRUTHSOCIAL_ARCHIVE_URL", DEFAULT_URL)
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    feed = resp.json()
    if not isinstance(feed, list):
        raise SchemaDriftError(f"SCHEMA DRIFT: feed root is {type(feed).__name__}, expected list")
    return feed


def _validate_item(item: dict) -> None:
    missing = REQUIRED_FIELDS - set(item)
    if missing:
        raise SchemaDriftError(f"SCHEMA DRIFT: feed item missing fields {sorted(missing)}: keys={sorted(item)[:10]}")


def _classify_author(text: str) -> str:
    """Original posts are Trump's own words; RT-prefixed posts belong to the
    re-truthed account (best-effort extraction; unknown → 'retruth:unknown')."""
    m = _RT_URL_RE.match(text)
    if m:
        return f"retruth:{m.group(1)}"
    m = _RT_AT_RE.match(text)
    if m:
        # Username may run into the quoted text with no separator; the exact
        # split doesn't matter — any RT is non-classifiable either way.
        return f"retruth:{m.group(1)}"
    if text.startswith("RT"):
        return "retruth:unknown"
    return TRUMP_AUTHOR


def fetch_new(last_seen_id: str | None, backfill_days: int | None = None,
              feed: list[dict] | None = None) -> tuple[list[dict], str | None]:
    """Return (new mentions oldest-first, new cursor).

    Each element: {"id","source","author","text","url","timestamp_utc","empty":bool}
    - incremental: only ids > last_seen_id (feed ids are numeric, monotonic)
    - backfill_days limits how far back the very first run reaches
    """
    from datetime import datetime, timedelta, timezone

    if feed is None:
        feed = _fetch_feed()
    if not feed:
        return [], last_seen_id

    cutoff = None
    if backfill_days is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(days=backfill_days)

    out: list[dict] = []
    max_id = int(last_seen_id) if last_seen_id else 0
    for item in feed:
        _validate_item(item)
        pid = int(item["id"])
        if last_seen_id is not None and pid <= int(last_seen_id):
            continue
        if cutoff is not None:
            ts = datetime.fromisoformat(item["created_at"].replace("Z", "+00:00"))
            if ts < cutoff:
                continue
        max_id = max(max_id, pid)
        raw = item.get("content") or ""
        text = ingest_normalize(raw)
        out.append({
            "id": f"truthsocial:{item['id']}",
            "source": "truthsocial",
            "author": _classify_author(text),
            "text": text,
            "url": item["url"],
            "timestamp_utc": item["created_at"],
            "empty": not text,
        })
    out.sort(key=lambda m: int(m["id"].split(":")[1]))
    new_cursor = str(max_id) if max_id else last_seen_id
    return out, new_cursor
