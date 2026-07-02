"""Regression: .env parsing must strip inline comments (caused a full
backfill failure: LLM_PRIMARY='groq   # groq | gemini' matched no provider)."""
from __future__ import annotations

import os

from tracker.pipeline import load_dotenv


def test_inline_comments_stripped(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text(
        "LLM_PRIMARY=groq                # groq | gemini\n"
        "PLAIN=value\n"
        'QUOTED="keep # everything"\n'
        "# full comment line\n"
        "EMPTY=\n"
    )
    for k in ("LLM_PRIMARY", "PLAIN", "QUOTED", "EMPTY"):
        monkeypatch.delenv(k, raising=False)
    load_dotenv(str(env))
    assert os.environ["LLM_PRIMARY"] == "groq"
    assert os.environ["PLAIN"] == "value"
    assert os.environ["QUOTED"] == "keep # everything"
    assert os.environ["EMPTY"] == ""
