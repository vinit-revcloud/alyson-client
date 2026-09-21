import { createHmac, timingSafeEqual } from "node:crypto";
import { resolvePlannedCalendarJoinAt } from "@/lib/unifiedMeetingsService";
import { buildDatedMeetingTitle } from "@/lib/notetaker-meeting-title.server";
import { registerScheduledBotInSessionsCatalog } from "@/lib/notetaker-scheduled-catalog.server";
import {
  mutateUnifiedScheduledStateInS3,
  readUnifiedScheduledStateFromS3,
  unifiedScheduledStateUsesS3,
  type UnifiedScheduledStateEntry,
} from "@/lib/unified-scheduled-s3.server";
import {
  cancelScheduledRecallBot,
  dispatchBotWithLiveTranscripts,
  ensureBotTranscriptPipeline,
} from "@/lib/notetaker-bot-dispatch.server";
import {
  abortMeetingBotReservation,
  commitMeetingBotReservation,
  isFreshReservation,
  isReservingBotId,
  meetingInstanceDedupeKey,
  resolveOrReserveMeetingBot,
} from "@/lib/meeting-bot-reserve.server";
import {
  eventTitleFromRaw,
  listAllRecallCalendarEvents,
  removeBotFromRecallCalendarEvent,
} from "@/lib/recall/recall-calendar-v2.server";
import type { RecallCalendarEvent } from "@/lib/recall/recall-calendar-types";
import { updateRecallCalendarSyncMeta, readRecallCalendarState } from "@/lib/recall/recall-calendar-state-s3.server";
import { isCalendarConnectEmailAllowed } from "@/lib/recall/recall-calendar-allowlist.server";
import { recallBotRecordingConfig, resolveRecallTranscriptWebhookUrl } from "@/lib/recall/recall-bot-config.server";
import { isActiveUnifiedScheduledStatus } from "@/lib/unified-scheduled-lifecycle.server";

const BOT_JOIN_OFFSET_MS = 2 * 60 * 1000;
const SYNC_LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;
/** Window sweeps look at events starting from this far back (meetings still in progress). */
const SYNC_START_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Don't cancel a superseded bot this close to its join time — nothing could replace it in time. */
const SUPERSEDED_CANCEL_MIN_LEAD_MS = 15 * 60 * 1000;

/** Events starting in [now - 24h, now + lookahead] — catches recurring series created long ago. */
function sweepStartWindow(lookaheadMs: number = SYNC_LOOKAHEAD_MS) {
  const now = Date.now();
  return {
    startTimeGte: new Date(now - SYNC_START_LOOKBACK_MS).toISOString(),
    startTimeLte: new Date(now + lookaheadMs).toISOString(),
  };
}
export const MAX_NEW_BOTS_PER_SYNC = 30;

function isUpcomingRecallEvent(event: RecallCalendarEvent): boolean {
  const startMs = new Date(event.start_time).getTime();
  if (!Number.isFinite(startMs)) return false;
  const now = Date.now();
  return startMs >= now - 24 * 60 * 60 * 1000 && startMs <= now + SYNC_LOOKAHEAD_MS;
}

export function recallCalendarDedupeKey(event: RecallCalendarEvent): string {
  const start = String(event.start_time || "").trim();
  const url = String(event.meeting_url || "").trim();
  return `${start}-${url}`;
}

/** Same key format as unifiedMeetingsService (url|start). One bot per meeting instance. */
export function unifiedScheduleDedupeKey(meetingUrl: string, startTime: string): string {
  return meetingInstanceDedupeKey(meetingUrl, startTime);
}

function findActiveScheduledRowForEvent(
  scheduledRows: UnifiedScheduledStateEntry[],
  event: RecallCalendarEvent,
): UnifiedScheduledStateEntry | undefined {
  const meetingUrl = String(event.meeting_url || "").trim();
  if (!meetingUrl) return undefined;
  const dedupeKey = unifiedScheduleDedupeKey(meetingUrl, event.start_time);

  const byMeeting = scheduledRows.find(
    (row) =>
      row.dedupeKey === dedupeKey &&
      isActiveUnifiedScheduledStatus(row.status) &&
      Boolean(row.recallBotId) &&
      !isReservingBotId(row.recallBotId),
  );
  if (byMeeting) return byMeeting;

  // Only a *fresh* reservation counts as in flight. Stale "reserving:" rows (dispatcher timed out
  // mid-create) used to count as scheduled forever, so those meetings never got a bot.
  const inFlight = scheduledRows.find(
    (row) =>
      row.dedupeKey === dedupeKey &&
      isActiveUnifiedScheduledStatus(row.status) &&
      isFreshReservation(row),
  );
  if (inFlight) return inFlight;

  return scheduledRows.find(
    (row) =>
      row.recallCalendarEventId === event.id &&
      isActiveUnifiedScheduledStatus(row.status) &&
      Boolean(row.recallBotId) &&
      (!isReservingBotId(row.recallBotId) || isFreshReservation(row)),
  );
}

/** Calendar owner declined this meeting (Google raw event: attendees[].self + responseStatus). */
export function ownerDeclinedRecallEvent(event: RecallCalendarEvent): boolean {
  const attendees = (event.raw as { attendees?: Array<{ self?: boolean; responseStatus?: string }> } | undefined)
    ?.attendees;
  if (!Array.isArray(attendees)) return false;
  return attendees.some((a) => a?.self === true && String(a.responseStatus || "") === "declined");
}

export function shouldAutoScheduleRecallEvent(event: RecallCalendarEvent): boolean {
  if (event.is_deleted) return false;
  if (!String(event.meeting_url || "").trim()) return false;
  if (ownerDeclinedRecallEvent(event)) return false;
  const joinAt = resolvePlannedCalendarJoinAt(event.start_time, event.end_time, BOT_JOIN_OFFSET_MS);
  return Boolean(joinAt);
}

/**
 * Bots are created Recall-direct (not via the calendar-event bot API), so Recall does NOT unschedule
 * them when a meeting is moved, re-linked or deleted. Cancel our own bot whose meeting instance no
 * longer matches this event, as long as it hasn't started joining. If another connected calendar still
 * has the meeting, its next sync/webhook schedules a fresh bot under the new key.
 */
async function releaseSupersededBotsForEvent(
  event: RecallCalendarEvent,
  scheduledRowsHint?: UnifiedScheduledStateEntry[],
): Promise<number> {
  if (!unifiedScheduledStateUsesS3()) return 0;
  const meetingUrl = String(event.meeting_url || "").trim();
  const currentKey =
    !event.is_deleted && meetingUrl ? unifiedScheduleDedupeKey(meetingUrl, event.start_time) : null;
  const cutoff = Date.now() + SUPERSEDED_CANCEL_MIN_LEAD_MS;
  const isSuperseded = (row: UnifiedScheduledStateEntry) =>
    row.recallCalendarEventId === event.id &&
    row.dedupeKey !== currentKey &&
    row.status === "scheduled" &&
    Date.parse(String(row.botJoinAt || "")) > cutoff;

  const rows = scheduledRowsHint ?? (await readUnifiedScheduledStateFromS3()).scheduled;
  if (!rows.some(isSuperseded)) return 0;

  const toCancel = await mutateUnifiedScheduledStateInS3((state) => {
    const cancel: string[] = [];
    const scheduled = state.scheduled.filter((row) => {
      if (!isSuperseded(row)) return true;
      if (!isReservingBotId(row.recallBotId)) cancel.push(row.recallBotId);
      return false;
    });
    return { state: { ...state, scheduled }, value: cancel };
  });
  for (const botId of toCancel) await cancelScheduledRecallBot(botId);
  if (toCancel.length) {
    console.info(`[recall-calendar] cancelled ${toCancel.length} superseded bot(s) for event ${event.id}`);
  }
  return toCancel.length;
}

export async function processRecallCalendarEvent(
  event: RecallCalendarEvent,
  options?: {
    refreshBotConfig?: boolean;
    /** Connected calendar owner — stored on the schedule row for attribution / filtering. */
    ownerEmail?: string;
    scheduledRowsHint?: UnifiedScheduledStateEntry[];
  },
): Promise<{
  action: "scheduled" | "skipped" | "deleted" | "refreshed";
  botId?: string;
  reason?: string;
}> {
  const released = await releaseSupersededBotsForEvent(event, options?.scheduledRowsHint).catch((e) => {
    console.warn(`[recall-calendar] superseded-bot cleanup failed for ${event.id}:`, e);
    return 0;
  });
  if (event.is_deleted) {
    return {
      action: "deleted",
      reason: released ? `Event deleted — cancelled ${released} scheduled bot(s)` : "Event deleted",
    };
  }
  if (!shouldAutoScheduleRecallEvent(event)) {
    return {
      action: "skipped",
      reason: !event.meeting_url
        ? "No meeting URL"
        : ownerDeclinedRecallEvent(event)
          ? "Calendar owner declined"
          : "Meeting ended or not joinable",
    };
  }
  const ownerEmail = String(options?.ownerEmail || "").trim().toLowerCase();

  const joinAt = resolvePlannedCalendarJoinAt(event.start_time, event.end_time, BOT_JOIN_OFFSET_MS);
  if (!joinAt) {
    return { action: "skipped", reason: "Meeting ended or not joinable" };
  }

  const hadRecallCalendarBot = Boolean(event.bots?.length);
  const baseTitle = eventTitleFromRaw(event);
  const title = buildDatedMeetingTitle(baseTitle, event.start_time);
  const meetingUrl = String(event.meeting_url);
  const dedupe = unifiedScheduleDedupeKey(meetingUrl, event.start_time);

  if (hadRecallCalendarBot) {
    try {
      await removeBotFromRecallCalendarEvent(event.id);
    } catch {
      // Drop Recall-native calendar bots — we manage one bot per meeting in app state.
    }
  }

  if (!unifiedScheduledStateUsesS3()) {
    const { botId, creationSource } = await dispatchBotWithLiveTranscripts({
      meetingUrl,
      botJoinAt: joinAt,
      title: baseTitle,
      joinOffsetMinutes: Math.round(BOT_JOIN_OFFSET_MS / 60_000),
      metadata: {
        source: "recall_calendar_v2",
        recall_calendar_event_id: event.id,
        recall_calendar_id: event.calendar_id,
        ical_uid: event.ical_uid,
        meeting_url: event.meeting_url,
        meeting_start_time: event.start_time,
        meeting_end_time: event.end_time,
        summary: title,
      },
    });
    await registerScheduledBotInSessionsCatalog({
      botId,
      title: baseTitle,
      meetingStartAt: event.start_time,
      meetingUrl,
      createdAt: new Date().toISOString(),
      status: "scheduled",
    });
    return {
      action: "scheduled",
      botId,
      reason: `Reserved via ${creationSource} — joins at ${joinAt}`,
    };
  }

  const reservation = await resolveOrReserveMeetingBot({
    dedupeKey: dedupe,
    buildPlaceholder: () => ({
      dedupeKey: dedupe,
      googleEventId: event.platform_id || event.id,
      iCalUID: event.ical_uid || "",
      calendarUserEmail: ownerEmail,
      title,
      meetingUrl,
      startTime: event.start_time,
      endTime: event.end_time,
      botJoinAt: joinAt,
      recallBotId: "",
      recallCalendarEventId: event.id,
      scheduledAt: new Date().toISOString(),
      lastStatusAt: new Date().toISOString(),
      transcriptWebhookUrl: resolveRecallTranscriptWebhookUrl(),
      status: "scheduled",
    }),
  });

  if (reservation.kind === "existing") {
    await ensureBotTranscriptPipeline({
      botId: reservation.botId,
      title: baseTitle,
      meetingUrl,
      botJoinAt: joinAt,
      metadata: {
        source: "recall_calendar_v2",
        recall_calendar_event_id: event.id,
        recall_calendar_id: event.calendar_id,
        meeting_start_time: event.start_time,
      },
    });
    return {
      action: "skipped",
      botId: reservation.botId,
      reason: "Bot already scheduled for this meeting link + start time (one bot per meeting)",
    };
  }

  try {
    const { botId, creationSource } = await dispatchBotWithLiveTranscripts({
      meetingUrl,
      botJoinAt: joinAt,
      title: baseTitle,
      joinOffsetMinutes: Math.round(BOT_JOIN_OFFSET_MS / 60_000),
      metadata: {
        source: "recall_calendar_v2",
        recall_calendar_event_id: event.id,
        recall_calendar_id: event.calendar_id,
        ical_uid: event.ical_uid,
        meeting_url: event.meeting_url,
        meeting_start_time: event.start_time,
        meeting_end_time: event.end_time,
        summary: title,
      },
    });

    await commitMeetingBotReservation({
      dedupeKey: dedupe,
      slotId: reservation.slotId,
      botId,
      entry: {
        dedupeKey: dedupe,
        googleEventId: event.platform_id || event.id,
        iCalUID: event.ical_uid || "",
        calendarUserEmail: ownerEmail,
        title,
        meetingUrl,
        startTime: event.start_time,
        endTime: event.end_time,
        botJoinAt: joinAt,
        recallBotId: botId,
        recallCalendarEventId: event.id,
        creationSource,
        scheduledAt: new Date().toISOString(),
        lastStatusAt: new Date().toISOString(),
        transcriptWebhookUrl: resolveRecallTranscriptWebhookUrl(),
        status: "scheduled",
      },
    });

    await registerScheduledBotInSessionsCatalog({
      botId,
      title: baseTitle,
      meetingStartAt: event.start_time,
      meetingUrl,
      createdAt: new Date().toISOString(),
      status: "scheduled",
    });

    return {
      action: "scheduled",
      botId,
      reason: `Reserved via ${creationSource} — joins at ${joinAt}`,
    };
  } catch (e) {
    await abortMeetingBotReservation({ dedupeKey: dedupe, slotId: reservation.slotId }).catch(() => {});
    throw e;
  }
}

export type RecallCalendarSyncResult = {
  calendarId: string;
  processed: number;
  scheduled: number;
  skipped: number;
  deleted: number;
  errors: string[];
  scheduledEventIds?: string[];
  blocked?: boolean;
  ownerEmail?: string;
  reason?: string;
  transcriptWebhookUrl?: string;
};

export type RecallCalendarPendingEvent = {
  eventId: string;
  title: string;
  startTime: string;
  endTime: string;
  meetingUrl: string;
  /** Legacy Recall Calendar bot and/or app-managed bot. */
  hasBot: boolean;
  /** Reserved via Smart schedule / Sync now (persisted in S3 — drives UI badge). */
  scheduledInApp: boolean;
  botJoinAt?: string;
  scheduledAt?: string;
  lifecycleStatus?: string;
  upstreamStatus?: string;
  transcriptLineCount?: number;
  botId?: string;
};

export type RecallCalendarPendingPreview = {
  calendarId: string;
  pendingCount: number;
  needsConfigRefreshCount: number;
  upcomingWithLink: number;
  events: RecallCalendarPendingEvent[];
  transcriptWebhookUrl: string;
};

export async function previewRecallCalendarPending(calendarId: string): Promise<RecallCalendarPendingPreview> {
  const events = await listAllRecallCalendarEvents({ calendarId, ...sweepStartWindow() });
  const relevant = events.filter((event) => !event.is_deleted && isUpcomingRecallEvent(event));
  const pending: RecallCalendarPendingEvent[] = [];

  let scheduledRows: UnifiedScheduledStateEntry[] = [];
  if (unifiedScheduledStateUsesS3()) {
    try {
      const state = await readUnifiedScheduledStateFromS3();
      scheduledRows = state.scheduled;
    } catch {
      // preview still works from Recall calendar event bots
    }
  }

  for (const event of relevant) {
    if (!shouldAutoScheduleRecallEvent(event)) continue;
    const stateRow = findActiveScheduledRowForEvent(scheduledRows, event);
    const scheduledInApp = Boolean(stateRow);
    const hasBot = Boolean(event.bots?.length) || scheduledInApp;
    pending.push({
      eventId: event.id,
      title: eventTitleFromRaw(event),
      startTime: event.start_time,
      endTime: event.end_time,
      meetingUrl: String(event.meeting_url || ""),
      hasBot,
      scheduledInApp,
      botJoinAt: stateRow?.botJoinAt,
      scheduledAt: stateRow?.scheduledAt,
      lifecycleStatus: stateRow?.status,
      upstreamStatus: stateRow?.upstreamStatus,
      transcriptLineCount: stateRow?.transcriptLineCount,
      botId: stateRow?.recallBotId || event.bots?.[0]?.bot_id,
    });
  }

  pending.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

  return {
    calendarId,
    pendingCount: pending.filter((e) => !e.scheduledInApp).length,
    needsConfigRefreshCount: pending.filter((e) => e.hasBot && !e.scheduledInApp).length,
    upcomingWithLink: pending.length,
    events: pending,
    transcriptWebhookUrl: resolveRecallTranscriptWebhookUrl(),
  };
}

function hasBotForCurrentInstance(
  event: RecallCalendarEvent,
  scheduledRows: UnifiedScheduledStateEntry[],
): boolean {
  const meetingUrl = String(event.meeting_url || "").trim();
  if (!meetingUrl) return false;
  const key = unifiedScheduleDedupeKey(meetingUrl, event.start_time);
  return scheduledRows.some(
    (row) =>
      row.dedupeKey === key &&
      isActiveUnifiedScheduledStatus(row.status) &&
      Boolean(row.recallBotId) &&
      (!isReservingBotId(row.recallBotId) || isFreshReservation(row)),
  );
}

export async function syncRecallCalendarEvents(args: {
  calendarId: string;
  updatedAtGte?: string;
  ownerEmail?: string;
  /** Re-apply bot_config (recording + transcript webhooks) on events that already have a bot. Default: true. */
  refreshBotConfig?: boolean;
  /** Schedule only these Recall calendar event ids (still respects allowlist + join rules). */
  eventIds?: string[];
  /** Sync now: reserve bots for every upcoming schedulable meeting (same path as Smart schedule). */
  scheduleAll?: boolean;
  /** When true with scheduleAll, also verify transcript pipeline on bots already in app state. */
  verifyExistingBots?: boolean;
  /** Cap how many *new* bots are created in this run (existing bots can still be refreshed). */
  maxNewBots?: number;
  /** Window sweeps only: how far ahead to look (default 14 days). */
  lookaheadMs?: number;
}): Promise<RecallCalendarSyncResult> {
  const state = await readRecallCalendarState();
  const conn = state.connections.find((c) => c.recallCalendarId === args.calendarId);
  const ownerEmail = args.ownerEmail || conn?.email || "";

  if (!isCalendarConnectEmailAllowed(ownerEmail)) {
    return {
      calendarId: args.calendarId,
      processed: 0,
      scheduled: 0,
      skipped: 0,
      deleted: 0,
      errors: [],
      blocked: true,
      ownerEmail,
      reason: `Auto-schedule disabled for ${ownerEmail || "unknown calendar"}`,
    };
  }

  // Webhook deltas pass updatedAtGte. Everything else sweeps by *start time* so recurring meetings
  // created weeks ago (never "updated" recently) still get a bot.
  const updatedAtGte = args.updatedAtGte;
  const syncedAt = new Date().toISOString();
  const events = await listAllRecallCalendarEvents(
    updatedAtGte
      ? { calendarId: args.calendarId, updatedAtGte }
      : { calendarId: args.calendarId, ...sweepStartWindow(args.lookaheadMs) },
  );

  const eventIdFilter =
    args.eventIds?.length ? new Set(args.eventIds.map((id) => String(id).trim()).filter(Boolean)) : null;

  let scheduledRows: UnifiedScheduledStateEntry[] = [];
  if (unifiedScheduledStateUsesS3()) {
    try {
      const state = await readUnifiedScheduledStateFromS3();
      scheduledRows = state.scheduled;
    } catch {
      // continue without S3 dedupe hints
    }
  }

  let relevantEvents = events
    .filter((event) => {
      if (eventIdFilter && !eventIdFilter.has(event.id)) return false;
      if (args.scheduleAll) {
        // Deleted events stay in so their already-scheduled bots get cancelled.
        if (event.is_deleted) return isUpcomingRecallEvent(event);
        return isUpcomingRecallEvent(event) && shouldAutoScheduleRecallEvent(event);
      }
      return event.is_deleted || isUpcomingRecallEvent(event);
    })
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  const scheduleBots = Boolean(args.eventIds?.length) || Boolean(args.scheduleAll);

  if (args.scheduleAll && !args.verifyExistingBots) {
    // Skip only meetings whose *current* link + start already has a bot. Matching by event id alone
    // hid moved meetings (old bot row still carried the event id), so they were never rescheduled.
    relevantEvents = relevantEvents.filter(
      (event) => event.is_deleted || !hasBotForCurrentInstance(event, scheduledRows),
    );
  }

  const maxNewBots =
    args.maxNewBots ?? (args.scheduleAll ? relevantEvents.length : MAX_NEW_BOTS_PER_SYNC);
  const refreshBotConfig =
    args.scheduleAll ? false : args.refreshBotConfig !== false;

  const result: RecallCalendarSyncResult = {
    calendarId: args.calendarId,
    processed: relevantEvents.length,
    scheduled: 0,
    skipped: 0,
    deleted: 0,
    errors: [],
    scheduledEventIds: [],
    transcriptWebhookUrl: resolveRecallTranscriptWebhookUrl(),
    reason: scheduleBots
      ? undefined
      : "Calendar list refreshed — use Smart schedule to reserve bots for selected meetings",
  };

  if (!scheduleBots) {
    result.skipped = relevantEvents.length;
    await updateRecallCalendarSyncMeta(args.calendarId, {
      lastSyncTs: updatedAtGte ?? syncedAt,
      lastSyncSummary: {
        scheduled: 0,
        skipped: result.skipped,
        processed: result.processed,
        errors: 0,
      },
    });
    return result;
  }

  let newBotsScheduled = 0;
  for (const event of relevantEvents) {
    try {
      if (
        !event.is_deleted &&
        shouldAutoScheduleRecallEvent(event) &&
        !event.bots?.length &&
        newBotsScheduled >= maxNewBots
      ) {
        result.skipped += 1;
        continue;
      }
      const r = await processRecallCalendarEvent(event, {
        refreshBotConfig,
        ownerEmail,
        scheduledRowsHint: scheduledRows,
      });
      if (r.action === "scheduled" || r.action === "refreshed") {
        result.scheduled += 1;
        result.scheduledEventIds!.push(event.id);
        if (r.action === "scheduled") newBotsScheduled += 1;
      } else if (r.action === "deleted") result.deleted += 1;
      else result.skipped += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`${event.id}: ${msg}`);
    }
  }

  await updateRecallCalendarSyncMeta(args.calendarId, {
    lastSyncTs: updatedAtGte ?? syncedAt,
    lastSyncSummary: {
      scheduled: result.scheduled,
      skipped: result.skipped,
      processed: result.processed,
      errors: result.errors.length,
    },
  });

  return result;
}

export function signOAuthState(payload: { nonce: string; returnTo?: string }): string {
  const secret = process.env.RECALL_API_KEY?.trim() || process.env.CRON_SECRET?.trim() || "dev";
  const json = JSON.stringify(payload);
  const sig = createHmac("sha256", secret).update(json).digest("hex");
  return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString("base64url");
}

export function verifyOAuthState(token: string): { nonce: string; returnTo?: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
      p?: { nonce?: string; returnTo?: string };
      s?: string;
    };
    if (!parsed.p?.nonce || !parsed.s) return null;
    const secret = process.env.RECALL_API_KEY?.trim() || process.env.CRON_SECRET?.trim() || "dev";
    const json = JSON.stringify(parsed.p);
    const expected = createHmac("sha256", secret).update(json).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(parsed.s);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return { nonce: parsed.p.nonce, returnTo: parsed.p.returnTo };
  } catch {
    return null;
  }
}
