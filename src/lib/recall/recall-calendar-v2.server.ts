import { recallFetch, recallFetchWithRetry } from "@/lib/recall/recall-client.server";
import type { RecallCalendarEvent, RecallCalendarPlatform } from "@/lib/recall/recall-calendar-types";

type PaginatedCalendarEvents = {
  next: string | null;
  previous: string | null;
  results: RecallCalendarEvent[];
};

type RecallCalendar = {
  id: string;
  platform: RecallCalendarPlatform;
  platform_email?: string | null;
  oauth_email?: string | null;
  status: string;
};

export async function createRecallCalendar(args: {
  platform: RecallCalendarPlatform;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthRefreshToken: string;
  oauthEmail?: string;
  metadata?: Record<string, string>;
}): Promise<RecallCalendar> {
  return recallFetch<RecallCalendar>("/api/v2/calendars/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform: args.platform,
      oauth_client_id: args.oauthClientId,
      oauth_client_secret: args.oauthClientSecret,
      oauth_refresh_token: args.oauthRefreshToken,
      oauth_email: args.oauthEmail,
      metadata: args.metadata,
    }),
  });
}

export async function getRecallCalendar(calendarId: string): Promise<RecallCalendar> {
  return recallFetch<RecallCalendar>(`/api/v2/calendars/${encodeURIComponent(calendarId)}/`);
}

export async function deleteRecallCalendar(calendarId: string): Promise<void> {
  await recallFetch(`/api/v2/calendars/${encodeURIComponent(calendarId)}/`, { method: "DELETE" });
}

export type RecallCalendarEventFilter = {
  calendarId: string;
  /** Delta sync (webhooks): only events changed since this time. */
  updatedAtGte?: string;
  /** Window sync (sweeps): events starting in this range, however long ago they were created. */
  startTimeGte?: string;
  startTimeLte?: string;
};

export async function listRecallCalendarEvents(
  args: RecallCalendarEventFilter & { cursor?: string },
): Promise<PaginatedCalendarEvents> {
  if (args.cursor) {
    return recallFetch<PaginatedCalendarEvents>(args.cursor);
  }
  const params = new URLSearchParams();
  params.set("calendar_id", args.calendarId);
  if (args.updatedAtGte) params.set("updated_at__gte", args.updatedAtGte);
  if (args.startTimeGte) params.set("start_time__gte", args.startTimeGte);
  if (args.startTimeLte) params.set("start_time__lte", args.startTimeLte);
  return recallFetch<PaginatedCalendarEvents>(`/api/v2/calendar-events/?${params.toString()}`);
}

export async function listAllRecallCalendarEvents(args: RecallCalendarEventFilter): Promise<RecallCalendarEvent[]> {
  const out: RecallCalendarEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await listRecallCalendarEvents({ ...args, cursor });
    out.push(...(res.results ?? []));
    if (!res.next) break;
    cursor = res.next;
  }
  return out;
}

export async function scheduleBotForRecallCalendarEvent(args: {
  eventId: string;
  deduplicationKey: string;
  botConfig: Record<string, unknown>;
}): Promise<RecallCalendarEvent> {
  return recallFetchWithRetry<RecallCalendarEvent>(
    `/api/v2/calendar-events/${encodeURIComponent(args.eventId)}/bot/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deduplication_key: args.deduplicationKey,
        bot_config: args.botConfig,
      }),
      maxRetries: 3,
    },
  );
}

export async function removeBotFromRecallCalendarEvent(eventId: string): Promise<RecallCalendarEvent> {
  return recallFetch<RecallCalendarEvent>(`/api/v2/calendar-events/${encodeURIComponent(eventId)}/bot/`, {
    method: "DELETE",
  });
}

export function eventTitleFromRaw(event: RecallCalendarEvent): string {
  const raw = event.raw as { summary?: string; subject?: string } | undefined;
  return String(raw?.summary || raw?.subject || "Meeting").trim() || "Meeting";
}
