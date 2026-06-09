import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveBotJoinAt } from "@/lib/unifiedMeetingsService";
import { registerScheduledBotInSessionsCatalog } from "@/lib/notetaker-scheduled-catalog.server";
import {
  readUnifiedScheduledStateFromS3,
  writeUnifiedScheduledStateToS3,
  unifiedScheduledStateUsesS3,
  type UnifiedScheduledStateEntry,
} from "@/lib/unified-scheduled-s3.server";
import {
  eventTitleFromRaw,
  listAllRecallCalendarEvents,
  scheduleBotForRecallCalendarEvent,
} from "@/lib/recall/recall-calendar-v2.server";
import type { RecallCalendarEvent } from "@/lib/recall/recall-calendar-types";
import { updateRecallCalendarSyncMeta, readRecallCalendarState } from "@/lib/recall/recall-calendar-state-s3.server";
import { isRecallCalendarEmailAllowed } from "@/lib/recall/recall-calendar-allowlist.server";
import { recallBotRecordingConfig } from "@/lib/recall/recall-bot-config.server";

const BOT_JOIN_OFFSET_MS = 2 * 60 * 1000;

export function recallCalendarDedupeKey(event: RecallCalendarEvent): string {
  const start = String(event.start_time || "").trim();
  const url = String(event.meeting_url || "").trim();
  return `${start}-${url}`;
}

export function shouldAutoScheduleRecallEvent(event: RecallCalendarEvent): boolean {
  if (event.is_deleted) return false;
  if (!String(event.meeting_url || "").trim()) return false;
  const joinAt = resolveBotJoinAt(event.start_time, event.end_time, BOT_JOIN_OFFSET_MS);
  return Boolean(joinAt);
}

function botConfigForEvent(event: RecallCalendarEvent) {
  const botName = process.env.BOT_NAME?.trim() || "Alyson Notetaker";
  const joinAt = resolveBotJoinAt(event.start_time, event.end_time, BOT_JOIN_OFFSET_MS);
  return {
    bot_name: botName,
    // join_at allowed per-event on Calendar V2 schedule API, not in dashboard default template
    join_at: joinAt,
    ...recallBotRecordingConfig(),
    metadata: {
      source: "recall_calendar_v2",
      recall_calendar_event_id: event.id,
      recall_calendar_id: event.calendar_id,
      ical_uid: event.ical_uid,
      meeting_url: event.meeting_url,
    },
  };
}

async function persistScheduledBot(event: RecallCalendarEvent, botId: string, joinAt: string) {
  const title = eventTitleFromRaw(event);
  await registerScheduledBotInSessionsCatalog({
    botId,
    title,
    meetingUrl: event.meeting_url || undefined,
    createdAt: new Date().toISOString(),
    status: "scheduled",
  });

  if (!unifiedScheduledStateUsesS3()) return;
  const key = recallCalendarDedupeKey(event);
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
    creationSource: "notetaker_managed",
    scheduledAt: new Date().toISOString(),
    status: "scheduled",
  };
  const idx = state.scheduled.findIndex((s) => s.dedupeKey === key);
  if (idx >= 0) state.scheduled[idx] = entry;
  else state.scheduled.push(entry);
  await writeUnifiedScheduledStateToS3(state);
}

export async function processRecallCalendarEvent(event: RecallCalendarEvent): Promise<{
  action: "scheduled" | "skipped" | "deleted";
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

  const deduplicationKey = recallCalendarDedupeKey(event);
  const botConfig = botConfigForEvent(event);
  const updated = await scheduleBotForRecallCalendarEvent({
    eventId: event.id,
    deduplicationKey,
    botConfig,
  });

  const botId = updated.bots?.[0]?.bot_id || event.bots?.[0]?.bot_id;
  const joinAt = String(botConfig.join_at || event.start_time);
  if (botId) await persistScheduledBot(event, botId, joinAt);
  return { action: "scheduled", botId: botId || undefined };
}

export type RecallCalendarSyncResult = {
  calendarId: string;
  processed: number;
  scheduled: number;
  skipped: number;
  deleted: number;
  errors: string[];
  blocked?: boolean;
  ownerEmail?: string;
  reason?: string;
};

export async function syncRecallCalendarEvents(args: {
  calendarId: string;
  updatedAtGte?: string;
  ownerEmail?: string;
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

  const events = await listAllRecallCalendarEvents({
    calendarId: args.calendarId,
    updatedAtGte: args.updatedAtGte,
  });

  const result: RecallCalendarSyncResult = {
    calendarId: args.calendarId,
    processed: events.length,
    scheduled: 0,
    skipped: 0,
    deleted: 0,
    errors: [],
  };

  for (const event of events) {
    try {
      const r = await processRecallCalendarEvent(event);
      if (r.action === "scheduled") result.scheduled += 1;
      else if (r.action === "deleted") result.deleted += 1;
      else result.skipped += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`${event.id}: ${msg}`);
    }
  }

  await updateRecallCalendarSyncMeta(args.calendarId, {
    lastSyncTs: args.updatedAtGte || new Date().toISOString(),
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
