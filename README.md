# WhatsApp Scheduler

[![CI](https://github.com/0xByteRush/whatsapp-scheduler/actions/workflows/ci.yml/badge.svg)](https://github.com/0xByteRush/whatsapp-scheduler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Schedule WhatsApp messages from your personal number: one-off or repeating, to contacts or
groups, with delivery and read receipts. It runs as a small, self-hosted, always-on service
with a web UI.

> **Disclaimer:** This project is not affiliated with, endorsed by, or connected to WhatsApp
> or Meta. It uses unofficial clients, which may violate WhatsApp's Terms of Service, and
> WhatsApp can restrict or ban numbers that use them. Use it for personal, low-volume
> messaging only. Never use it for spam or bulk messaging. You use it at your own risk.

## Quick start

```
git clone https://github.com/0xByteRush/whatsapp-scheduler.git
cd whatsapp-scheduler
cp .env.example .env        # Windows: copy .env.example .env, then edit it
npm install
npm start
```

Open http://localhost:3737 and link WhatsApp once: scan the QR code, or use **Link with your
phone number instead** under it.

Requires Node.js 22.13 or newer (SQLite is built in, so there are no native modules).

## How it sends

| `SENDER` | How | Works while PC is locked / headless | Groups | Receipts |
|---|---|---|---|---|
| `baileys` (default) | Its own linked-device session over WhatsApp's protocol ([Baileys](https://github.com/WhiskeySockets/Baileys)) | Yes | Yes | Delivered / read |
| `desktop` (Windows fallback) | Opens `whatsapp://send` in the WhatsApp Desktop app you're signed into and presses Enter | No, Windows must be unlocked | No | No |

Use `desktop` only if you can't link a new device (for example, WhatsApp says *"Can't link new
devices now"*, which usually clears within a day).

There is no official WhatsApp API for personal numbers. Both modes are unofficial, so keep
usage personal and low-volume. The pacing and daily-limit settings exist to keep your number
in good standing.

## Reliability

- **Durable queue (SQLite, WAL).** Each message is claimed atomically before it's sent, so it
  can never be sent twice.
- **Retries.** Failed sends retry after 1, 5, then 15 minutes, up to `MAX_ATTEMPTS`. Final
  failures raise an alert.
- **Crash safety.** A message that was mid-send when the process died is marked *failed*
  ("check WhatsApp"), never silently re-sent. If WhatsApp had already acknowledged it, it's
  marked *sent*.
- **Missed messages.** If the service was down at send time, a message still goes out up to
  `MISSED_GRACE_MINUTES` late. After that it's marked *missed*, so "good morning" doesn't
  arrive at 9 pm.
- **Repeats.** Daily, weekly and monthly, computed in `TZ`, so 9:00 stays 9:00 across DST.
  Monthly on the 31st falls back to the last day of shorter months.
- **Reconnects.** Exponential backoff. If WhatsApp is still down after 5 minutes, or you get
  unlinked, you get an alert.
- **Graceful shutdown.** Ctrl+C or SIGTERM lets an in-flight send finish first.

## Security

- Listens on `127.0.0.1` by default. Binding anywhere else **requires** `ADMIN_PASSWORD`.
- Sign-in uses a signed, HttpOnly, SameSite=Strict session cookie (30 days), and login
  attempts are rate-limited.
- CSRF and DNS-rebinding protection: state changes must be JSON, and unknown `Host` headers
  are rejected. Add your domain to `ALLOWED_HOSTS`.
- Security headers via helmet (CSP and others). Secrets live only in `.env` and the
  database, never in the repo.

## Alerts

Set `ALERT_NTFY_URL` to an [ntfy](https://ntfy.sh) topic URL, for example
`https://ntfy.sh/<long-random-name>`, and subscribe to it in the ntfy phone app. You'll get a
push when WhatsApp disconnects or unlinks, or when a message fails or is missed.

## Running it permanently

**Windows, at sign-in (restarts on crash):**
```
powershell -ExecutionPolicy Bypass -File scripts\windows-autostart.ps1
```
Logs go to `data\scheduler.log`. Remove the task with `-Remove`.

**Docker (VPS, NAS or home server):**
```
cp .env.example .env        # set ADMIN_PASSWORD and TZ
docker compose up -d --build
```
The port is bound to `127.0.0.1:3737`. To reach it from outside, put a reverse proxy with
HTTPS in front (for example Caddy: `reverse_proxy localhost:3737`), then set `TRUST_PROXY=1`
and `ALLOWED_HOSTS=your.domain`. Data lives in the `scheduler-data` volume, so back it up.
It contains your WhatsApp session.

Health check: `GET /healthz` returns `{ ok, whatsapp, pending }`.

## Configuration

Every setting is documented in [.env.example](.env.example).

## Development

```
npm test
```
Tests cover recurrence and DST, the job engine (no double sends, retries, missed messages,
repeats, crash recovery, daily limit) and the HTTP API (auth, CSRF, host check,
validation).

## Data

Everything is in `data/scheduler.db`: messages, contacts and the WhatsApp session. Treat it
like a password. Messages from the old `messages.json` are imported automatically on first
start.
