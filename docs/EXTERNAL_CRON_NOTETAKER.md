# Always-on scheduling for Alyson Notetaker

Vercel Hobby only runs daily crons, so a GitHub Actions workflow keeps auto-join running:
`.github/workflows/notetaker-heartbeat.yml`.

| Schedule | Endpoint | Does |
|----------|----------|------|
| every 5 min | `POST /api/cron/recall-calendar-sync` | Sweeps every connected calendar (next 14 days by start time), schedules missing bots, cancels bots for moved/deleted meetings, activates deferred bots |
| every 15 min | `POST /api/cron/notetaker-transcripts` | DWD allowlist scan, transcript persist/backfill, notes email |

Both need `Authorization: Bearer <CRON_SECRET>`.

## One-time setup

1. Merge to `main` (scheduled workflows only run from the default branch).
2. GitHub → repo Settings → Secrets and variables → Actions → New repository secret
   `CRON_SECRET` = the same value as `CRON_SECRET` on Vercel Production
   (`DAILY_REPORT_CRON_SECRET` and `NOTETAKER_TRANSCRIPT_CRON_SECRET` must match it or be unset).
3. Actions tab → "Notetaker heartbeat" → Run workflow once, and check both jobs are green.

## Real-time path

Recall calendar webhooks (`calendar.sync_events` → `/api/recall/webhooks/calendar`) schedule bots within
seconds of a Google Calendar change. The heartbeat is the safety net if a webhook is missed.

## Who gets a bot

Anyone who clicks **Connect Google Calendar** with an account in `RECALL_CALENDAR_CONNECT_DOMAINS`
(default `GOOGLE_WORKSPACE_DOMAIN`, `*` for any account). Every meeting with a video link on their
calendar gets one bot per meeting instance, except meetings they declined.

## Meeting notes right after the meeting

In Recall dashboard → Webhooks, make sure the endpoint
`https://alyson-client.vercel.app/api/recall/webhooks/calendar` (or the dedicated
`/api/recall/webhooks/bot`) is subscribed to **bot.call_ended, bot.done, bot.fatal, bot.in_waiting_room,
bot.in_call_recording, transcript.done** (or "all events"). When a meeting ends, notes are generated and
emailed within about a minute. If the webhook is missed, the 15-minute heartbeat sends them instead.
