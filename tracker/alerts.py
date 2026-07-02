"""Alerting (§6). Telegram + email as independent channels; each activates
only if its env vars are present. I1: alerts describe what was said — never
what to do. Send failures are recorded and retried next run (I6);
delivery state lives in state.json (I5).
"""
from __future__ import annotations

import logging
import os
import smtplib
from datetime import datetime, timezone
from email.mime.text import MIMEText

import requests

log = logging.getLogger(__name__)

_GLYPH_PRIORITY = {"P1": "🔴", "P2": "🟠", "P3": "🟡", "P4": "⚪"}
_GLYPH_DIRECTION = {"bullish": "▲", "bearish": "▼"}


def _relative_age(ts_iso: str) -> str:
    ts = datetime.fromisoformat(ts_iso.replace("Z", "+00:00"))
    mins = int((datetime.now(timezone.utc) - ts).total_seconds() // 60)
    if mins < 60:
        return f"{mins} min ago"
    if mins < 60 * 24:
        return f"{mins // 60} h ago"
    return f"{mins // (60 * 24)} d ago"


def format_alert(rec: dict) -> str:
    """Lock-screen-skimmable, factual, no imperatives (I1)."""
    s = rec["signal"]
    head = f"{_GLYPH_PRIORITY.get(s['priority'], '')} {s['priority']} {_GLYPH_DIRECTION.get(s['direction'], '')} {s['direction']}"
    subject = ", ".join(s["tickers"]) or ", ".join(s["entities"]) or "—"
    ts = rec["timestamp_utc"]
    return "\n".join([
        f"{head} — {subject}",
        f"“{s['exact_quote']}”",
        f"{rec['url']}",
        f"{ts} ({_relative_age(ts)}) · confidence {s['confidence']:.2f}",
    ])


def telegram_configured() -> bool:
    return bool(os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID"))


def email_configured() -> bool:
    return bool(os.environ.get("RESEND_API_KEY")) or bool(
        os.environ.get("EMAIL_USER") and os.environ.get("EMAIL_PASSWORD") and os.environ.get("EMAIL_TO"))


def send_telegram(text: str) -> bool:
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": os.environ["TELEGRAM_CHAT_ID"], "text": text,
                  "disable_web_page_preview": True},
            timeout=30,
        )
        ok = resp.status_code == 200
        if not ok:
            log.warning("telegram send failed: HTTP %s", resp.status_code)
        return ok
    except requests.RequestException as e:
        log.warning("telegram send failed: %s", e.__class__.__name__)
        return False


def send_email(subject: str, body: str) -> bool:
    try:
        if os.environ.get("RESEND_API_KEY"):
            resp = requests.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {os.environ['RESEND_API_KEY']}"},
                json={"from": os.environ.get("RESEND_FROM", "tracker@resend.dev"),
                      "to": [os.environ.get("RESEND_TO") or os.environ.get("EMAIL_TO", "")],
                      "subject": subject, "text": body},
                timeout=30,
            )
            ok = resp.status_code in (200, 201)
            if not ok:
                log.warning("resend send failed: HTTP %s", resp.status_code)
            return ok
        msg = MIMEText(body, "plain", "utf-8")
        msg["Subject"] = subject
        msg["From"] = os.environ["EMAIL_USER"]
        msg["To"] = os.environ["EMAIL_TO"]
        host = os.environ.get("EMAIL_SMTP_HOST", "smtp.gmail.com")
        port = int(os.environ.get("EMAIL_SMTP_PORT", "465"))
        with smtplib.SMTP_SSL(host, port, timeout=30) as smtp:
            smtp.login(os.environ["EMAIL_USER"], os.environ["EMAIL_PASSWORD"])
            smtp.send_message(msg)
        return True
    except Exception as e:  # any send failure is retried next run, never fatal (I6)
        log.warning("email send failed: %s", e.__class__.__name__)
        return False


def dispatch_immediate_alerts(store, min_confidence: float = 0.0) -> dict:
    """Send P1/P2 alerts not yet delivered on every configured channel.
    Called each run, so failures self-retry (I6). Returns counts."""
    channels = {}
    if telegram_configured():
        channels["telegram"] = lambda rec: send_telegram(format_alert(rec))
    if email_configured():
        channels["email"] = lambda rec: send_email(
            f"[{rec['signal']['priority']}] {', '.join(rec['signal']['tickers']) or ', '.join(rec['signal']['entities'])}",
            format_alert(rec))

    sent = failed = 0
    status: dict = store.state.setdefault("alert_status", {})
    for rec in store.signals:
        s = rec["signal"]
        if s["priority"] not in ("P1", "P2"):
            continue
        if s["confidence"] < min_confidence:
            continue
        st = status.setdefault(s["mention_id"], {})
        for name, sender in channels.items():
            if st.get(name):
                continue  # already delivered on this channel (I5)
            if sender(rec):
                st[name] = True
                sent += 1
            else:
                st[name] = False
                failed += 1
    return {"sent": sent, "failed": failed}
