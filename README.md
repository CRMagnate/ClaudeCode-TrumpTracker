# Trump Market-Signal Tracker

A $0/month, **alert-only** system that monitors Donald Trump's public statements,
detects when he names or insinuates a tradeable opportunity (stock, company, or
industry — bullish or bearish), classifies each detection by priority, alerts via
Telegram/email, renders everything on a static dashboard, and tracks each signal's
subsequent market-relative performance so the strategy can be validated or
falsified **before any capital is committed**.

> This system never gives advice, never places orders, and never integrates with
> a brokerage. Alerts state what was said, by whom, where, and when.

## Priority taxonomy (plain English)

| Tier | Meaning | Example |
|------|---------|---------|
| P1 — Critical | A specific public company in clearly positive/directive terms; ticker present or unambiguous | "Palantir Technologies (PLTR) has proven to have great war fighting capabilities" |
| P2 — High | A specific public company praised without explicit buy language (the insinuation tier) | "Nvidia is a tremendous company, doing an incredible job" |
| P3 — Medium | A directive toward an industry/sector, actionable via ETF/basket | "We're going all-in on American shipbuilding" |
| P4 — Low | Policy/macro statement implying winners and losers, naming no company | "100% tariffs on any country that joins BRICS" |

Any tier can be **bearish** (attacks/threats on a company or sector). Bearish
signals "win" when their excess return is negative.

P1/P2 alert immediately; P3/P4 go into the daily digest. Everything is stored and
shown on the dashboard regardless.

## One-time setup

1. **Public GitHub repo** — push this code; Actions cron requires the repo to be public for unlimited free minutes.
2. **GitHub Pages** — Settings → Pages → Deploy from branch → `main` / `/ (root)`. The dashboard is `index.html` reading `data/*.json`.
3. **Groq key** — free at console.groq.com → repo Settings → Secrets → Actions → `GROQ_API_KEY`.
4. **Gemini key** (fallback) — free at aistudio.google.com → secret `GEMINI_API_KEY`.
5. **Telegram bot** — talk to @BotFather → `/newbot` → secret `TELEGRAM_BOT_TOKEN`. Send your bot a message, then `https://api.telegram.org/bot<TOKEN>/getUpdates` → your chat id → secret `TELEGRAM_CHAT_ID`.
6. **Email** — either a Gmail app password (myaccount.google.com/apppasswords) via `EMAIL_USER`/`EMAIL_PASSWORD`/`EMAIL_TO` (+`EMAIL_SMTP_HOST`/`EMAIL_SMTP_PORT` secrets), or Resend free tier via `RESEND_API_KEY`/`RESEND_FROM`/`RESEND_TO`. Email works with no Telegram config and vice versa.

## Local run

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env   # fill in keys; .env is gitignored
make backfill          # first run: last 14 days of posts
make poll              # incremental poll
make test-alert        # send a live P1-formatted test alert
make test              # offline test suite (no keys needed)
make smoke             # a few live classifications (needs keys; never in CI)
```

## Architecture

```
tracker/
  sources/truthsocial.py   adapter → RawMention (id, source, author, text, url, timestamp_utc)
  prefilter.py             stage 1: deterministic, no LLM, high recall
  classifier.py            stage 2: LLM (Groq → Gemini failover), pydantic-validated
  entities.py              deterministic ticker resolution (never the LLM's job)
  alerts.py                Telegram + email, independent channels, per-channel retry
  storage.py               append-oriented JSON in data/, atomic writes
  pipeline.py              CLI orchestrator
data/
  state.json               cursor, alert delivery state, prefilter stats
  mentions.json            every ingested item + disposition (audit trail)
  signals.json             validated signals (what the dashboard renders)
```

### Adding/swapping a source adapter

Write `tracker/sources/<name>.py` exposing `fetch_new(...)` that emits the same
RawMention shape, wire it into `pipeline.run_poll` behind a `SOURCE_<NAME>_ENABLED`
env toggle. The paid Truth Social sources (Apify actor, ScrapeCreators) drop in by
replacing `truthsocial._fetch_feed` or pointing `TRUTHSOCIAL_ARCHIVE_URL` at a
compatible mirror.

### Extending the watchlist

Add `{"name", "variants", "ticker"}` objects to `config/entities.json`. Variants
are matched case-insensitively on word boundaries. Private companies get
`"ticker": null` (classified at most P4/macro, never a ticker).

## Operational caveats

- **Cron drift** — GitHub runs `*/5 * * * *` with ~5–15 min drift under load. Accepted.
- **Keepalive** — GitHub disables scheduled workflows after ~60 days without repo
  activity. Data commits normally self-sustain; the daily workflow additionally
  touches `data/heartbeat` so there is at least one commit per day.
- **Feed schema drift** — if the archive feed changes shape, the run fails loudly
  (`SCHEMA DRIFT` in the log) and ingests nothing rather than garbage.
- **Rate limits** — `--limit N` caps LLM calls per run; the cursor resumes cleanly.
- **Alert failures** — logged and retried next run, per channel; storage and the
  dashboard are never blocked by a failed send.

## Invariants

I1 alert-only · I2 no fabricated quotes (programmatic substring verification) ·
I3 untrusted input (delimited prompts, no interpolation into shell/commits,
textContent-only rendering) · I4 schema-or-nothing with one retry · I5 idempotent
& deduped · I6 graceful degradation · I7 $0/month · I8 secrets hygiene.

Each is enforced in code and covered by the offline test suite (`tests/`).
