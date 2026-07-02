"""Text normalization shared by ingestion and quote verification (I2).

All source text is normalized once at ingestion; the classifier's
exact_quote is normalized the same way before the substring check, so
verification is deterministic and immune to whitespace/quote-mark drift.
"""
from __future__ import annotations

import html
import re
import unicodedata

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")

# Curly quotes/dashes → ASCII so an LLM echoing "straight" quotes still matches.
_CHAR_MAP = str.maketrans({
    "‘": "'", "’": "'", "“": '"', "”": '"',
    "–": "-", "—": "-", " ": " ",
})


def strip_html(text: str) -> str:
    """Remove tags and unescape entities. The CNN feed is plain text but the
    adapter contract (§4) requires HTML-stripping regardless of source."""
    return html.unescape(_TAG_RE.sub(" ", text))


def normalize(text: str) -> str:
    """Canonical form: NFC, mapped quote chars, collapsed whitespace."""
    text = unicodedata.normalize("NFC", text).translate(_CHAR_MAP)
    return _WS_RE.sub(" ", text).strip()


def ingest_normalize(text: str) -> str:
    return normalize(strip_html(text))


def verify_quote(quote: str, source_text: str) -> str | None:
    """I2: return the exact substring of *source_text* matching *quote*
    (case-insensitive after normalization), or None if not present.

    The returned string is always taken from the source text itself, so the
    stored exact_quote is verbatim source material even if the LLM changed
    casing.
    """
    if not quote:
        return None
    nq, ns = normalize(quote), normalize(source_text)
    idx = ns.casefold().find(nq.casefold())
    if idx < 0:
        return None
    return ns[idx: idx + len(nq)]
