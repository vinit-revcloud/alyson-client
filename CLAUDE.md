# alyson-client — notes for Claude

Alyson HR web app (TanStack Start + React 19, deployed to Vercel via Nitro `vercel` preset).
The **Alyson Notetaker** (Recall.ai meeting bot) is the priority module. Read
`notetaker-architecture.md` and `docs/ALYSON_BOT_SCHEDULING_BLOCKERS.md` before touching it.

## Commands

- `npm run dev` — app on http://localhost:3001 (loads `.env` via dotenv-cli)
- `npx tsc --noEmit -p .` — type check. Baseline has 1 pre-existing error in
  `notetaker-bot-join-report.server.ts`. Don't add new ones.
- `package-lock.json` is out of sync with `package.json`, so `npm ci` fails. Use `npm install`, and
  don't commit lockfile churn unless that's the task.
- `npm run lint` — many pre-existing prettier CRLF errors on Windows; judge only lines you changed.
- No test suite exists. Verify with type check + targeted scripts under `scripts/`.

## Three runtimes (don't confuse them)

1. **This app** on Vercel (`https://alyson-client.vercel.app`) — UI, server functions, cron routes,
   Recall calendar webhook (`/api/recall/webhooks/calendar`), transcript webhook proxy (`/webhooks/recall`).
2. **Notetaker service** on Render (`https://api-uic1.onrender.com`) — separate repo, NOT here.
   Holds live sessions **in memory** (lost on restart) and receives Recall transcript webhooks.
3. **Recall.ai** (`ap-northeast-1`) — creates bots, records, transcribes.

## How a Google Calendar meeting gets a bot

Two schedulers write to one S3 index `alyson-notetaker/unified-scheduled/index.json`
(dedupe key `meetingUrl|startISO`, optimistic concurrency via ETag, `reserving:<uuid>` placeholders
that count as in flight for 10 min only):

- **Connected calendars (Recall Calendar V2), the main path.** Anyone whose email domain is in
  `RECALL_CALENDAR_CONNECT_DOMAINS` (default `GOOGLE_WORKSPACE_DOMAIN`) or on the allowlist can click
  **Connect Google Calendar** on `/alyson-notetaker/unified-meetings`. Connecting is the opt-in:
  - on connect, `completeRecallCalendarConnect` schedules bots for the next 48h (bounded, ~20s);
  - `calendar.sync_events` webhooks → `handleRecallCalendarWebhook` handle new/changed meetings in real time;
  - the heartbeat (`.github/workflows/notetaker-heartbeat.yml`, every 5 min →
    `/api/cron/recall-calendar-sync`) sweeps every connected calendar by **start time** (14 days ahead).
  `processRecallCalendarEvent` skips meetings the owner declined, stores the owner in `calendarUserEmail`,
  and cancels our bot when a meeting is moved or deleted (>15 min before join).
- **Google DWD scan.** `scheduleAllowlistedUnifiedBots` in `src/lib/unifiedMeetingsService.ts` reads the
  primary calendars of the allowlist (`src/lib/recall/recall-calendar-allowlist.server.ts` +
  `RECALL_CALENDAR_AUTO_SCHEDULE_EMAILS`) for the next 24h, without anyone connecting. Runs from
  `/api/cron/notetaker-transcripts` (heartbeat every 15 min) and on Unified Meetings page load.

Bots are created Recall-direct (`dispatchBotWithLiveTranscripts`, `fastSchedule`) with timed 48h media
retention and a realtime transcript webhook; Notetaker session linking is best-effort. Recall dispatches a
scheduled bot at `join_at` on its own, so our servers don't need to be up at meeting time.

## Meeting notes right after the meeting

Recall sends bot status webhooks to the dashboard endpoints (same Svix app as calendar events).
`/api/recall/webhooks/calendar` forwards `bot.*` / `transcript.done` / `recording.done` to
`handleRecallBotWebhook` in `src/lib/notetaker-meeting-end.server.ts`; `/api/recall/webhooks/bot` is a
dedicated alias.

- `bot.call_ended` → persist realtime transcript, stamp `recallCallEndedAt` on bot-index (no email).
- `bot.done` / `transcript.done` / `recording.done` / `bot.fatal` → persist Recall's final transcript
  artifact (fallback: realtime lines), generate notes, send via SES. The S3 claim lock
  (`notes-email-locks/`) makes repeat events and the cron sweep send at most once.
- Fallback: the 15-min heartbeat sweep sends as soon as `recallCallEndedAt` is older than
  `NOTETAKER_NOTES_AFTER_END_MS` (default 2 min) instead of waiting 15 min of transcript silence.
- Kill switches: `NOTETAKER_NOTES_ON_MEETING_END=false` (webhook path), `NOTETAKER_NOTES_AUTO_EMAIL=false` (SES).
- Recall lifecycle lookups are cached per process; webhooks invalidate the cache, and an ended bot
  without a transcript URL is only cached for 90s.

## Known failure modes (verified Sept 2026)

- Only ~7% of scheduled bots produced a transcript over 14 days. Bots join Google Meet as **unsigned
  guests** and must be admitted within `waiting_room_timeout` (1200s). Real fix is Recall Google
  Login Groups (`google_meet.google_login_group_id`), which needs a dedicated Workspace domain + SSO.
- **Cron cadence:** Vercel Hobby only allows daily crons (`vercel.json`). Sub-daily work runs from the
  GitHub Actions heartbeat, which needs the `CRON_SECRET` repo secret and only runs from `main`.
  GitHub pauses scheduled workflows after 60 days without repo activity.
- Google OAuth refresh tokens die if the OAuth consent screen is in "Testing" mode (7 days) or the user
  revokes access. Recall then marks the calendar disconnected and the UI shows **Reconnect**.
- Recall media expires after 48h — transcripts not backfilled by then are lost.
- The local `.env` `RECALL_API_KEY` is a **different, stale workspace** (newest bot June 2026); production
  bot ids 404 with it. Get the production key from Vercel before debugging bots locally.
- The Bot Join Report counts waiting-room visits as successful joins (commit 7de05a7), so it overstates success.

## Rules

- Never run crons, `schedule-bots`, or dispatch code locally against production S3 without intent —
  it creates real, billable Recall bots.
- Server secrets must never get a `VITE_` / `NEXT_PUBLIC_` prefix.
- Pushing `main` deploys production. Work on a branch.
- `docs/claude.md` is the HR-module rebuild index, not this file.
