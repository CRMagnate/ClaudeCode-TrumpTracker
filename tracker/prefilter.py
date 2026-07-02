"""Stage-1 deterministic prefilter (§5). No LLM. High recall by design."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from .entities import CASHTAG_RE, PAREN_TICKER_RE, Watchlist

CONFIG_DIR = Path(os.environ.get("TRACKER_CONFIG_DIR", "config"))


class Prefilter:
    def __init__(self, watchlist: Watchlist, keywords_path: Path | None = None):
        self.watchlist = watchlist
        path = keywords_path or CONFIG_DIR / "keywords.json"
        kws = json.loads(Path(path).read_text(encoding="utf-8"))["keywords"]
        self._kw_pattern = re.compile(
            r"(?<!\w)(" + "|".join(re.escape(k) for k in sorted(kws, key=len, reverse=True)) + r")(?!\w)",
            re.IGNORECASE,
        )

    def check(self, text: str) -> tuple[bool, list[str]]:
        """(passes, matched tokens) — matches are logged for auditability."""
        matches: list[str] = []
        for m in CASHTAG_RE.finditer(text):
            matches.append(f"cashtag:${m.group(1)}")
        for m in PAREN_TICKER_RE.finditer(text):
            matches.append(f"paren:{m.group(1)}")
        for name, _ in self.watchlist.find_in_text(text):
            matches.append(f"entity:{name}")
        kw = self._kw_pattern.search(text)
        if kw:
            matches.append(f"keyword:{kw.group(1).lower()}")
        return (bool(matches), matches)
