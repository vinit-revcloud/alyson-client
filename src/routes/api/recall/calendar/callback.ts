import { createFileRoute } from "@tanstack/react-router";
import { completeRecallCalendarConnect } from "@/lib/recall/recall-calendar-service.server";

function absoluteRedirect(requestUrl: string, path: string): Response {
  const target = new URL(path, requestUrl).toString();
  return Response.redirect(target, 302);
}

export const Route = createFileRoute("/api/recall/calendar/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const oauthError = url.searchParams.get("error");
        const meetingsPath = "/alyson-notetaker/unified-meetings";

        if (oauthError) {
          return absoluteRedirect(
            request.url,
            `${meetingsPath}?calendarError=${encodeURIComponent(oauthError)}`,
          );
        }
        if (!code || !state) {
          return absoluteRedirect(request.url, `${meetingsPath}?calendarError=missing_code`);
        }

        try {
          const result = await completeRecallCalendarConnect(code, state, url.origin);
          const dest = result.returnTo || meetingsPath;
          const join = dest.includes("?") ? "&" : "?";
          return absoluteRedirect(
            request.url,
            `${dest}${join}calendarConnected=1&scheduled=${result.sync.scheduled}`,
          );
        } catch (e) {
          const message = e instanceof Error ? e.message : "Calendar connect failed";
          return absoluteRedirect(
            request.url,
            `${meetingsPath}?calendarError=${encodeURIComponent(message)}`,
          );
        }
      },
    },
  },
});
