import { getRecallCalendar } from "@/lib/recall/recall-calendar-v2.server";
import { isCalendarConnectEmailAllowed } from "@/lib/recall/recall-calendar-allowlist.server";
import {
  getConnectedRecallCalendars,
  markRecallCalendarDisconnected,
  readRecallCalendarState,
} from "@/lib/recall/recall-calendar-state-s3.server";
import {
  MAX_NEW_BOTS_PER_SYNC,
  previewRecallCalendarPending,
  syncRecallCalendarEvents,
} from "@/lib/recall/recall-calendar-sync.server";

export type RecallCalendarSyncCronResult = {
  ok: boolean;
  calendarsProcessed: number;
  totalScheduled: number;
  totalSkipped: number;
  totalErrors: number;
  calendars: Array<{
    email: string;
    calendarId: string;
    pendingBefore: number;
    scheduled: number;
    skipped: number;
    errors: string[];
    skippedRun?: boolean;
    reason?: string;
  }>;
};

/** Automated Sync now for one allowlisted calendar (server cron + webhooks — always runs sync). */
export async function autoSyncRecallCalendarIfPending(args: {
  calendarId: string;
  ownerEmail: string;
  /** When true, skip sync if preview reports zero pending (UI-only fallback). */
  requirePending?: boolean;
  /**
   * From `calendar.sync_events.last_updated_ts` — only fetch events changed since then
   * (Recall Calendar V2 event-driven path).
   */
  updatedAtGte?: string;
  /**
   * Fast webhook path: skip pending preview, process the delta, and re-check already-tracked
   * meetings so time/link updates still get a bot.
   */
  eventDriven?: boolean;
}): Promise<{
  ran: boolean;
  pendingBefore: number;
  scheduled: number;
  skipped: number;
  errors: string[];
  reason?: string;
}> {
  const calendarId = String(args.calendarId || "").trim();
  const ownerEmail = String(args.ownerEmail || "").trim();
  const requirePending = Boolean(args.requirePending);
  const eventDriven = Boolean(args.eventDriven);
  if (!calendarId) {
    return { ran: false, pendingBefore: 0, scheduled: 0, skipped: 0, errors: [], reason: "Missing calendar id" };
  }
  if (!isCalendarConnectEmailAllowed(ownerEmail)) {
    return {
      ran: false,
      pendingBefore: 0,
      scheduled: 0,
      skipped: 0,
      errors: [],
      reason: `Auto-schedule disabled for ${ownerEmail || "unknown"}`,
    };
  }

  try {
    const cal = await getRecallCalendar(calendarId);
    if (cal.status === "disconnected") {
      // Google access was revoked or the refresh token expired — surface "Reconnect" in the UI.
      await markRecallCalendarDisconnected(calendarId).catch(() => {});
      return {
        ran: false,
        pendingBefore: 0,
        scheduled: 0,
        skipped: 0,
        errors: [],
        reason: "Calendar disconnected on Recall — owner must reconnect Google Calendar",
      };
    }
  } catch {
    return {
      ran: false,
      pendingBefore: 0,
      scheduled: 0,
      skipped: 0,
      errors: [],
      reason: "Calendar not found in Recall",
    };
  }

  let pendingBefore = 0;
  if (!eventDriven) {
    try {
      pendingBefore = (await previewRecallCalendarPending(calendarId)).pendingCount;
    } catch {
      // Non-fatal — still attempt sync when preview fails.
    }

    if (requirePending && pendingBefore === 0) {
      return {
        ran: false,
        pendingBefore: 0,
        scheduled: 0,
        skipped: 0,
        errors: [],
        reason: "No pending meetings",
      };
    }
  }

  // Small negative buffer so clock skew / equal timestamps don't drop the triggering event.
  let updatedAtGte = args.updatedAtGte?.trim() || undefined;
  if (updatedAtGte) {
    const ms = Date.parse(updatedAtGte);
    if (Number.isFinite(ms)) {
      updatedAtGte = new Date(ms - 2 * 60_000).toISOString();
    }
  }

  const sync = await syncRecallCalendarEvents({
    calendarId,
    ownerEmail,
    updatedAtGte,
    scheduleAll: true,
    // Event-driven: process every changed event (including ones already in app state).
    verifyExistingBots: eventDriven,
    maxNewBots: eventDriven ? 50 : MAX_NEW_BOTS_PER_SYNC,
  });

  return {
    ran: true,
    pendingBefore,
    scheduled: sync.scheduled,
    skipped: sync.skipped,
    errors: sync.errors,
  };
}

/** Automated Sync now for every connected calendar (anyone who clicked Connect Google Calendar). */
export async function runRecallCalendarAutoSyncCron(): Promise<RecallCalendarSyncCronResult> {
  const state = await readRecallCalendarState();
  const connections = getConnectedRecallCalendars(state).filter((c) =>
    isCalendarConnectEmailAllowed(c.email),
  );

  const result: RecallCalendarSyncCronResult = {
    ok: true,
    calendarsProcessed: 0,
    totalScheduled: 0,
    totalSkipped: 0,
    totalErrors: 0,
    calendars: [],
  };

  for (const conn of connections) {
    const run = await autoSyncRecallCalendarIfPending({
      calendarId: conn.recallCalendarId,
      ownerEmail: conn.email,
      requirePending: false,
    });

    if (!run.ran) {
      result.calendars.push({
        email: conn.email,
        calendarId: conn.recallCalendarId,
        pendingBefore: run.pendingBefore,
        scheduled: 0,
        skipped: 0,
        errors: run.errors,
        skippedRun: true,
        reason: run.reason,
      });
      continue;
    }

    result.calendarsProcessed += 1;
    result.totalScheduled += run.scheduled;
    result.totalSkipped += run.skipped;
    result.totalErrors += run.errors.length;
    if (run.errors.length) result.ok = false;

    result.calendars.push({
      email: conn.email,
      calendarId: conn.recallCalendarId,
      pendingBefore: run.pendingBefore,
      scheduled: run.scheduled,
      skipped: run.skipped,
      errors: run.errors,
    });
  }

  return result;
}

export function recallCalendarSyncCronEnabled(): boolean {
  return true;
}
