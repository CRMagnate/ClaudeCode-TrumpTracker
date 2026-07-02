"""Pydantic models: the §4 RawMention contract, the §5 Signal schema, and
the stored record wrappers."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

TRUMP_AUTHOR = "Donald Trump"

TICKER_RE = r"^[A-Z]{1,5}$"


class RawMention(BaseModel):
    """§4 adapter contract. Every source emits exactly this."""
    id: str                    # source-prefixed stable id
    source: Literal["truthsocial", "news", "transcript"]
    author: str                # only TRUMP_AUTHOR first-person statements classify
    text: str                  # HTML-stripped, whitespace-normalized
    url: str
    timestamp_utc: str         # ISO 8601 UTC


MentionStatus = Literal[
    "prefiltered_out",        # never sent to the LLM
    "skipped_no_text",        # media-only post
    "skipped_not_trump",      # re-truth / other speaker; stored unclassified
    "classified_signal",
    "classified_non_signal",
    "classification_failed",  # I4: schema failure after one retry
    "quote_verification_failed",  # I2: LLM quote not in source text
]


class MentionRecord(BaseModel):
    """One row in data/mentions.json — the audit trail for every ingested item."""
    mention: RawMention
    status: MentionStatus
    prefilter_matches: list[str] = Field(default_factory=list)
    error: Optional[str] = None
    ingested_at_utc: str = ""


class Signal(BaseModel):
    """§5 LLM classification schema. Validated with one retry (I4)."""
    mention_id: str
    is_signal: bool
    priority: Optional[Literal["P1", "P2", "P3", "P4"]] = None
    direction: Optional[Literal["bullish", "bearish"]] = None
    asset_type: Optional[Literal["ticker", "company", "sector", "macro"]] = None
    tickers: list[str] = Field(default_factory=list)
    entities: list[str] = Field(default_factory=list)
    exact_quote: str = ""
    confidence: float = Field(ge=0.0, le=1.0)
    rationale: str = ""
    sarcasm_or_negation: bool = False

    @field_validator("tickers")
    @classmethod
    def _tickers_shape(cls, v: list[str]) -> list[str]:
        import re
        for t in v:
            if not re.match(TICKER_RE, t):
                raise ValueError(f"invalid ticker format: {t!r}")
        return v


class SignalRecord(BaseModel):
    """One row in data/signals.json: the validated signal plus provenance."""
    signal: Signal
    source: str
    author: str
    url: str
    timestamp_utc: str
    source_text: str
    llm_provider: str = ""
    classified_at_utc: str = ""
    corroborations: list[str] = Field(default_factory=list)  # M3 cross-source dedupe
