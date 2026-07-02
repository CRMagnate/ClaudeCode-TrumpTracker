# Decisions log

One line per judgment call, per the freedom contract (§13).

- 2026-07-01: Data files are JSON arrays (`mentions.json`, `signals.json`) plus a dict `state.json`; append + atomic temp-file rename; in-memory id sets rebuilt on load for dedupe.
- 2026-07-01: All `RT`-prefixed posts (both observed formats: `RT: <status url>` and `RT @user…`) are stored as `skipped_not_trump` and never classified — self-retruths duplicate an original post already ingested under its own id.
- 2026-07-01: Author for re-truths is recorded as `retruth:<username>` (best-effort extraction); only exact `Donald Trump` is classifiable.
- 2026-07-01: Quote verification is case-insensitive after normalization (NFC, curly→straight quotes, collapsed whitespace), and the stored `exact_quote` is re-extracted from the source text, so it is verbatim source material even if the LLM changed casing.
- 2026-07-01: Deterministic ticker resolution implemented as: explicit cashtags/parenthesized tickers in text win; else watchlist-name matches in text; else watchlist lookup of LLM-named entities; LLM-guessed tickers are otherwise discarded.
- 2026-07-01: Parenthesized-ticker extraction has a stopword list (USA, AI, CNN, FBI…) to avoid obvious false tickers; cashtags have no stopwords.
- 2026-07-01: Prefilter matches are recorded per mention (`prefilter_matches`) and the cumulative pass-rate is kept in `state.json` for auditing.
- 2026-07-01: `--limit N` caps LLM calls per run; when hit, the cursor stays at the last processed post so the next run resumes without gaps.
- 2026-07-01: Alert delivery state is per-channel (`alert_status[signal_id][channel]`), so a Telegram success + email failure retries only email next run.
- 2026-07-01: Non-signal LLM responses may omit `confidence` (defaulted to 0.0); full schema is enforced for signals.
- 2026-07-01: Dashboard lives at the repo root (`index.html` + `assets/`), served by Pages from the main branch root so it can fetch `data/*.json` relatively with no copy step.
- 2026-07-01: Groq default model `llama-3.3-70b-versatile`, Gemini default `gemini-2.0-flash`; both overridable via env.
- 2026-07-01: HTTP 4xx other than 429 from a provider does NOT fail over (it's a config error, e.g. bad key) — it fails the classification loudly instead.
- 2026-07-01: Feed items are processed oldest-first so the persisted cursor always trails completed work.
- 2026-07-01: Dashboard v2: KPI strip, pill filters, client-side search, SVG sparklines; bearish returns are win-colored (green = winning short) matching §7's inverted evaluation; Inter/JetBrains Mono via Google Fonts (graceful system-font fallback).
