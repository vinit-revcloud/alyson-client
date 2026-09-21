import { createFileRoute } from "@tanstack/react-router";
import { assertDailyReportCronAuth } from "@/lib/resend-mail.server";
import {
  recallCalendarSyncCronEnabled,
  runRecallCalendarAutoSyncCron,
} from "@/lib/recall/recall-calendar-sync-cron.server";
import { activateDueScheduledBotSessions } from "@/lib/notetaker-scheduled-bot-activation.server";

export const Route = createFileRoute("/api/cron/recall-calendar-sync")({
  server: {
    handlers: {
      GET: async ({ request }) => runCron(request),
      POST: async ({ request }) => runCron(request),
    },
  },
});

async function runCron(request: Request) {
  const authFail = assertDailyReportCronAuth(request);
  if (authFail) return authFail;

  if (!recallCalendarSyncCronEnabled()) {
    return Response.json({ ok: true, skipped: true, reason: "Recall calendar sync cron disabled" });
  }

  // Heartbeat (every ~5 min from .github/workflows/notetaker-heartbeat.yml). Kept light on purpose:
  // the company-wide DWD scan + transcript sweep live in /api/cron/notetaker-transcripts.
  try {
    const calendars = await runRecallCalendarAutoSyncCron();
    let activation: Awaited<ReturnType<typeof activateDueScheduledBotSessions>> | { error: string };
    try {
      activation = await activateDueScheduledBotSessions();
    } catch (e) {
      activation = { error: e instanceof Error ? e.message : String(e) };
    }
    const result = { calendars, activation };
    console.info("[cron/recall-calendar-sync]", JSON.stringify(result));
    return Response.json({ ok: calendars.ok, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Recall calendar sync cron failed";
    console.error("[cron/recall-calendar-sync]", message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
