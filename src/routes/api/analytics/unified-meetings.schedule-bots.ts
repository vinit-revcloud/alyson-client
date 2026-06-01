import { createFileRoute } from "@tanstack/react-router";

// Company-wide auto-schedule (Vercel cron every 5 min + bulk POST) is intentionally disabled.
// Use per-meeting scheduling: POST /api/analytics/unified-meetings/:meetingId/schedule
// Future: selective allowlist by calendar email before re-enabling bulk/cron paths.
//
// import { scheduleEligibleUnifiedBots } from "@/lib/unifiedMeetingsService";

const DISABLED = {
  error: "Company-wide bot scheduling is disabled",
  hint: "Schedule one meeting at a time from Unified Meetings (row action), or re-enable allowlisted automation later.",
};

export const Route = createFileRoute("/api/analytics/unified-meetings/schedule-bots")({
  server: {
    handlers: {
      // Was used by Vercel Cron (GET every 5 min). Disabled — do not re-add vercel.json crons without product sign-off.
      GET: async () => Response.json(DISABLED, { status: 410 }),
      // Was used by "Schedule eligible bots" (bulk company-wide). Disabled — same as cron path.
      POST: async () => Response.json(DISABLED, { status: 410 }),
      /*
      GET: async ({ request }) => {
        try {
          const expected = process.env.ALYSON_SCHEDULE_CALENDAR_CRON_SECRET?.trim();
          if (expected) {
            const auth = request.headers.get("authorization") || "";
            if (auth !== `Bearer ${expected}`) {
              return Response.json({ error: "Unauthorized" }, { status: 401 });
            }
          }
          const result = await scheduleEligibleUnifiedBots();
          return Response.json(result);
        } catch (e) {
          const message = e instanceof Error ? e.message : "Failed to schedule bots";
          return Response.json({ error: message }, { status: 500 });
        }
      },
      POST: async () => {
        try {
          const result = await scheduleEligibleUnifiedBots();
          return Response.json(result);
        } catch (e) {
          const message = e instanceof Error ? e.message : "Failed to schedule bots";
          return Response.json({ error: message }, { status: 500 });
        }
      },
      */
    },
  },
});
