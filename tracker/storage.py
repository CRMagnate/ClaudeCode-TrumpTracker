"""Append-oriented JSON storage with atomic writes (§3).

Layout under data/:
  state.json     — last-seen cursor, alerted ids, pending alerts, run stats
  mentions.json  — every ingested mention + its disposition (audit trail)
  signals.json   — validated signals only (what the dashboard renders)
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

def default_data_dir() -> Path:
    """Resolved at call time so TRACKER_DATA_DIR set by tests/CLI is honored."""
    return Path(os.environ.get("TRACKER_DATA_DIR", "data"))


def atomic_write_json(path: Path, obj: Any) -> None:
    """Write temp file in the same directory, fsync, rename (§3)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def default_state() -> dict:
    return {
        "truthsocial_last_seen_id": None,
        # signal_id -> {"telegram": bool, "email": bool} (True = delivered)
        "alert_status": {},
        "prefilter_stats": {"total": 0, "passed": 0},
    }


class Store:
    def __init__(self, data_dir: Path | None = None):
        self.dir = Path(data_dir) if data_dir else default_data_dir()
        self.state: dict = {**default_state(), **load_json(self.dir / "state.json", {})}
        self.mentions: list[dict] = load_json(self.dir / "mentions.json", [])
        self.signals: list[dict] = load_json(self.dir / "signals.json", [])
        self._mention_ids = {m["mention"]["id"] for m in self.mentions}
        self._signal_ids = {s["signal"]["mention_id"] for s in self.signals}

    def has_mention(self, mention_id: str) -> bool:
        return mention_id in self._mention_ids

    def has_signal(self, mention_id: str) -> bool:
        return mention_id in self._signal_ids

    def add_mention(self, record: dict) -> bool:
        """Idempotent append (I5). Returns False if already present."""
        mid = record["mention"]["id"]
        if mid in self._mention_ids:
            return False
        self.mentions.append(record)
        self._mention_ids.add(mid)
        return True

    def add_signal(self, record: dict) -> bool:
        mid = record["signal"]["mention_id"]
        if mid in self._signal_ids:
            return False
        self.signals.append(record)
        self._signal_ids.add(mid)
        return True

    def save(self) -> None:
        atomic_write_json(self.dir / "state.json", self.state)
        atomic_write_json(self.dir / "mentions.json", self.mentions)
        atomic_write_json(self.dir / "signals.json", self.signals)
