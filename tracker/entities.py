"""Watchlist loading and deterministic ticker resolution (§5).

The LLM never decides tickers. Resolution order:
  1. explicit ticker-like tokens in the source text: cashtags ($PLTR) and
     parenthesized uppercase tokens ((PLTR)), validated ^[A-Z]{1,5}$
  2. watchlist matches: entity name variants found in the text -> ticker
An LLM-suggested ticker is kept only if rule 1 or 2 independently produces it.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("TRACKER_CONFIG_DIR", "config"))

CASHTAG_RE = re.compile(r"\$([A-Za-z]{1,5})\b")
PAREN_TICKER_RE = re.compile(r"\(([A-Z]{1,5})\)")
TICKER_RE = re.compile(r"^[A-Z]{1,5}$")

# Parenthesized uppercase words that are never tickers in this corpus.
_PAREN_STOPWORDS = {"USA", "US", "UK", "EU", "CNN", "NBC", "ABC", "CBS", "FBI",
                    "CIA", "DOJ", "IRS", "NATO", "UN", "GOP", "MAGA", "AI", "TV"}


class Watchlist:
    def __init__(self, path: Path | None = None):
        path = path or CONFIG_DIR / "entities.json"
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        self.entities = raw["entities"]
        # variant (casefolded) -> (canonical name, ticker|None)
        self._by_variant: dict[str, tuple[str, str | None]] = {}
        for e in self.entities:
            for v in e["variants"]:
                self._by_variant[v.casefold()] = (e["name"], e.get("ticker"))
        # one regex over all variants, longest first, word boundaries
        variants = sorted(self._by_variant, key=len, reverse=True)
        self._pattern = re.compile(
            r"(?<!\w)(" + "|".join(re.escape(v) for v in variants) + r")(?!\w)",
            re.IGNORECASE,
        )

    def find_in_text(self, text: str) -> list[tuple[str, str | None]]:
        """Unique (canonical name, ticker) pairs found in text."""
        found: dict[str, str | None] = {}
        for m in self._pattern.finditer(text):
            name, ticker = self._by_variant[m.group(1).casefold()]
            found.setdefault(name, ticker)
        return list(found.items())

    def ticker_for(self, entity_name: str) -> str | None:
        got = self._by_variant.get(entity_name.casefold())
        return got[1] if got else None


def explicit_tickers(text: str) -> list[str]:
    """Rule 1: cashtags + parenthesized uppercase tokens present in the text."""
    out: list[str] = []
    for m in CASHTAG_RE.finditer(text):
        t = m.group(1).upper()
        if t not in out:
            out.append(t)
    for m in PAREN_TICKER_RE.finditer(text):
        t = m.group(1)
        if t not in _PAREN_STOPWORDS and t not in out:
            out.append(t)
    return [t for t in out if TICKER_RE.match(t)]


def resolve_tickers(text: str, llm_entities: list[str], watchlist: Watchlist) -> list[str]:
    """Deterministic resolution per §5; returns [] when nothing resolves."""
    explicit = explicit_tickers(text)
    if explicit:
        return explicit
    tickers: list[str] = []
    for name, ticker in watchlist.find_in_text(text):
        if ticker and ticker not in tickers:
            tickers.append(ticker)
    if not tickers:
        for ent in llm_entities:
            t = watchlist.ticker_for(ent)
            if t and t not in tickers:
                tickers.append(t)
    return tickers
