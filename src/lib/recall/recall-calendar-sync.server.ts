import { createHmac, timingSafeEqual } from "node:crypto";
import { resolvePlannedCalendarJoinAt } from "@/lib/unifiedMeetingsService";
import { registerScheduledBotInSessionsCatalog } from "@/lib/notetaker-scheduled-catalog.server";
import {
  readUnifiedScheduledStateFromS3,
  writeUnifiedScheduledStateToS3,
  unifiedScheduledStateUsesS3,
  type UnifiedScheduledStateEntry,
} from "@/lib/unified-scheduled-s3.server";
import { cancelScheduledRecallBot, dispatchBotWithLiveTranscripts } from "@/lib/notetaker-bot-dispatch.server";
import {
  eventTitleFromRaw,
  listAllRecallCalendarEvents,
  removeBotFromRecallCalendarEvent,
} from "@/lib/recall/recall-calendar-v2.server";
import type { RecallCalendarEvent } from "@/lib/recall/recall-calendar-types";
import { updateRecallCalendarSyncMeta, readRecallCalendarState } from "@/lib/recall/recall-calendar-state-s3.server";
import { isRecallCalendarEmailAllowed } from "@/lib/recall/recall-calendar-allowlist.server";
import { recallBotRecordingConfig, resolveRecallTranscriptWebhookUrl } from "@/lib/recall/recall-bot-config.server";

const BOT_JOIN_OFFSET_MS = 2 * 60 * 1000;
const SYNC_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const SYNC_LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_NEW_BOTS_PER_SYNC = 30;

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

function normalizeIsoForDedupe(iso: string): string {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(iso).trim();
}

/** Same key format as unifiedMeetingsService (url|start). */
function unifiedScheduleDedupeKey(meetingUrl: string, startTime: string): string {
  return `${String(meetingUrl).trim()}|${normalizeIsoForDedupe(startTime)}`;
}

export function shouldAutoScheduleRecallEvent(event: RecallCalendarEvent): boolean {
  if (event.is_deleted) return false;
  if (!String(event.meeting_url || "").trim()) return false;
  const joinAt = resolvePlannedCalendarJoinAt(event.start_time, event.end_time, BOT_JOIN_OFFSET_MS);
  return Boolean(joinAt);
}

async function persistScheduledBot(
  event: RecallCalendarEvent,
  botId: string,
  joinAt: string,
  creationSource: "notetaker_managed" | "direct_recall_fallback" | "recall_calendar_v2",
) {
  const title = eventTitleFromRaw(event);
  await registerScheduledBotInSessionsCatalog({
    botId,
    title,
    meetingUrl: event.meeting_url || undefined,
    createdAt: new Date().toISOString(),
    status: "scheduled",
  });

  if (!unifiedScheduledStateUsesS3()) return;
  const key = unifiedScheduleDedupeKey(String(event.meeting_url), event.start_time);
  const state = await readUnifiedScheduledStateFromS3();
  const entry: UnifiedScheduledStateEntry = {
    dedupeKey: key,
    googleEventId: event.platform_id || event.id,
    iCalUID: event.ical_uid,
    calendarUserEmail: "",
    title,
    meetingUrl: String(event.meeting_url),
    startTime: event.start_time,
    endTime: event.end_time,
    botJoinAt: joinAt,
    recallBotId: botId,
    recallCalendarEventId: event.id,
    creationSource,
    scheduledAt: new Date().toISOString(),
    status: "scheduled",
  };
  const idx = state.scheduled.findIndex((s) => s.dedupeKey === key);
  if (idx >= 0) state.scheduled[idx] = entry;
  else state.scheduled.push(entry);
  await writeUnifiedScheduledStateToS3(state);
}

export async function processRecallCalendarEvent(
  event: RecallCalendarEvent,
  options?: { refreshBotConfig?: boolean },
): Promise<{
  action: "scheduled" | "skipped" | "deleted" | "refreshed";
  botId?: string;
  reason?: string;
}> {
  if (event.is_deleted) {
    return { action: "deleted", reason: "Event deleted — Recall auto-unschedules bots" };
  }
  if (!shouldAutoScheduleRecallEvent(event)) {
    return {
      action: "skipped",
      reason: !event.meeting_url ? "No meeting URL" : "Meeting ended or not joinable",
    };
  }

  const joinAt = resolvePlannedCalendarJoinAt(event.start_time, event.end_time, BOT_JOIN_OFFSET_MS);
  if (!joinAt) {
    return { action: "skipped", reason: "Meeting ended or not joinable" };
  }

  const hadRecallCalendarBot = Boolean(event.bots?.length);
  const shouldRefreshConfig = options?.refreshBotConfig !== false;

  let existingBotId: string | undefined;
  if (unifiedScheduledStateUsesS3()) {
    const state = await readUnifiedScheduledStateFromS3();
    existingBotId = state.scheduled.find(
      (row) =>
        row.recallCalendarEventId === event.id && row.status === "scheduled" && Boolean(row.recallBotId),
    )?.recallBotId;
  }

  if (existingBotId && !shouldRefreshConfig) {
    return { action: "skipped", reason: "Bot already scheduled for this event" };
  }

  // Drop Recall Calendar bots (often missing transcript webhooks) before re-creating via Notetaker.
  if (hadRecallCalendarBot) {
    try {
      await removeBotFromRecallCalendarEvent(event.id);
    } catch {
      // Non-fatal — cancel individual bot ids below.
    }
  }
  const priorBotIds = [
    ...new Set(
      [existingBotId, event.bots?.[0]?.bot_id].filter((id): id is string => Boolean(id?.trim())),
    ),
  ];
  for (const priorId of priorBotIds) {
    await cancelScheduledRecallBot(priorId);
  }

  const title = eventTitleFromRaw(event);
  const { botId, creationSource } = await dispatchBotWithLiveTranscripts({
    meetingUrl: String(event.meeting_url),
    botJoinAt: joinAt,
    title,
    joinOffsetMinutes: Math.round(BOT_JOIN_OFFSET_MS / 60_000),
    preferScheduledJoin: true,
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

  await persistScheduledBot(event, botId, joinAt, creationSource);
  const replacedPriorBot = Boolean(existingBotId || hadRecallCalendarBot);
  return {
    action: replacedPriorBot ? "refreshed" : "scheduled",
    botId,
    reason: replacedPriorBot
      ? `Re-scheduled via ${creationSource} — joins at ${joinAt}`
      : `Reserved via ${creationSource} — joins at ${joinAt}`,
  };
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
  const updatedAtGte = new Date(Date.now() - SYNC_LOOKBACK_MS).toISOString();
  const events = await listAllRecallCalendarEvents({ calendarId, updatedAtGte });
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
    const stateRow = scheduledRows.find(
      (row) =>
        row.recallCalendarEventId === event.id && row.status === "scheduled" && Boolean(row.recallBotId),
    );
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

function recallEventScheduledInApp(
  event: RecallCalendarEvent,
  scheduledRows: UnifiedScheduledStateEntry[],
): boolean {
  return scheduledRows.some(
    (row) => row.recallCalendarEventId === event.id && row.status === "scheduled" && Boolean(row.recallBotId),
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
  /** Cap how many *new* bots are created in this run (existing bots can still be refreshed). */
  maxNewBots?: number;
}): Promise<RecallCalendarSyncResult> {
  const state = await readRecallCalendarState();
  const conn = state.connections.find((c) => c.recallCalendarId === args.calendarId);
  const ownerEmail = args.ownerEmail || conn?.email || "";

  if (!isRecallCalendarEmailAllowed(ownerEmail)) {
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

  const updatedAtGte =
    args.updatedAtGte ?? new Date(Date.now() - SYNC_LOOKBACK_MS).toISOString();

  const events = await listAllRecallCalendarEvents({
    calendarId: args.calendarId,
    updatedAtGte,
  });

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
        return !event.is_deleted && isUpcomingRecallEvent(event) && shouldAutoScheduleRecallEvent(event);
      }
      return event.is_deleted || isUpcomingRecallEvent(event);
    })
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  const scheduleBots = Boolean(args.eventIds?.length) || Boolean(args.scheduleAll);

  if (args.scheduleAll) {
    relevantEvents = relevantEvents.filter((event) => !recallEventScheduledInApp(event, scheduledRows));
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
      lastSyncTs: updatedAtGte,
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
    lastSyncTs: updatedAtGte,
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
