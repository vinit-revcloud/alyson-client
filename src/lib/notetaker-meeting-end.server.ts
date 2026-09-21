/**
 * "Notes right after the meeting" — driven by Recall bot status webhooks instead of cron + idle timers.
 *
 * Recall sends every workspace event to the webhook endpoints configured in its dashboard
 * (Svix). We act on:
 *   bot.call_ended            → stamp end marker, persist the realtime transcript (no email yet)
 *   bot.done / transcript.done / recording.done / bot.fatal
 *                             → persist the final transcript (Recall artifact when ready),
 *                               generate notes, send the email once (S3 claim lock dedupes)
 *   bot.in_waiting_room / bot.in_call_recording → lifecycle status for Unified Meetings
 *
 * The 15-minute heartbeat sweep remains the fallback if a webhook is missed.
 */
import { maybeAutoSendMeetingNotesEmail, type AutoMeetingNotesEmailResult } from "@/lib/notetaker-meeting-notes-auto-email.server";
import { markBotIndexRecallCallEnded } from "@/lib/notetaker-persistence.server";
import { driveSessionPersistToS3 } from "@/lib/notetaker-session-persist-drive.server";
import { loadBotIndexDoc } from "@/lib/notetaker-sessions-history.server";
import { invalidateRecallBotLifecycleCache } from "@/lib/recall/recall-bot-status.server";
import { backfillTranscriptFromRecall } from "@/lib/recall/recall-transcript-backfill.server";
import { touchUnifiedScheduledFromSession } from "@/lib/unified-scheduled-lifecycle.server";

export type RecallBotWebhookPayload = {
  event: string;
  data?: {
    data?: { code?: string; sub_code?: string | null; updated_at?: string };
    bot?: { id?: string; metadata?: Record<string, unknown> };
  };
};

/** Events that mean the meeting is over and notes can go out. */
const SEND_EVENTS = new Set(["bot.done", "transcript.done", "recording.done", "bot.fatal"]);
/** Call ended: the bot left, Recall is still producing the final transcript artifact. */
const PREP_EVENTS = new Set(["bot.call_ended"]);
/** Lifecycle-only events worth recording on the schedule row (kept small to limit S3 writes). */
const STATUS_EVENTS: Record<string, string> = {
  "bot.in_waiting_room": "waiting_room",
  "bot.in_call_recording": "in_call_recording",
};

export function isRecallBotWebhookEvent(event: string): boolean {
  return event.startsWith("bot.") || event === "transcript.done" || event === "recording.done";
}

/** NOTETAKER_NOTES_ON_MEETING_END=false turns the webhook path off (the cron sweep still runs). */
export function notesOnMeetingEndEnabled(): boolean {
  return String(process.env.NOTETAKER_NOTES_ON_MEETING_END ?? "true").trim().toLowerCase() !== "false";
}

async function transcriptLineCount(botId: string): Promise<number> {
  const index = await loadBotIndexDoc(botId).catch(() => null);
  return Number(index?.lineCount || 0) || 0;
}

export type MeetingEndResult = {
  botId: string;
  event: string;
  transcriptSource: "recall_artifact" | "realtime" | "existing" | "none";
  transcriptDetail?: string;
  email?: AutoMeetingNotesEmailResult;
};

/**
 * Persist the best available transcript for a finished meeting, then (optionally) send notes.
 * Safe to call repeatedly: persistence is hash-deduped and the email path holds an S3 claim lock.
 */
export async function finalizeMeetingAndSendNotes(
  botId: string,
  options: { event: string; endedAt?: string; sendEmail: boolean },
): Promise<MeetingEndResult> {
  const id = String(botId || "").trim();
  const result: MeetingEndResult = { botId: id, event: options.event, transcriptSource: "none" };
  if (!id) return result;
  // The webhook means Recall's bot state just changed — never reuse a stale cached lifecycle.
  invalidateRecallBotLifecycleCache(id);

  // 1) Final transcript. Recall's post-call artifact is complete (includes the last few seconds);
  //    it isn't ready at bot.call_ended, so fall back to the realtime lines the Notetaker service captured.
  if (options.sendEmail) {
    try {
      const backfill = await backfillTranscriptFromRecall(id);
      if (backfill.ok && backfill.persisted) result.transcriptSource = "recall_artifact";
      else result.transcriptDetail = backfill.reason;
    } catch (e) {
      result.transcriptDetail = e instanceof Error ? e.message : String(e);
    }
  }
  if (result.transcriptSource === "none") {
    try {
      const drive = await driveSessionPersistToS3(id, { bypassThrottle: true });
      if (drive === "written") result.transcriptSource = "realtime";
      else if (drive === "unchanged" || drive === "skipped_complete") result.transcriptSource = "existing";
      else result.transcriptDetail = [result.transcriptDetail, `realtime:${drive}`].filter(Boolean).join("; ");
    } catch (e) {
      result.transcriptDetail = [result.transcriptDetail, e instanceof Error ? e.message : String(e)]
        .filter(Boolean)
        .join("; ");
    }
  }

  // 2) End marker on bot-index so the fallback sweep also skips the 15-min idle wait.
  await markBotIndexRecallCallEnded(id, options.endedAt || new Date().toISOString()).catch(() => false);

  // 3) Notes + email (idempotent). The meeting is over, so skip the idle / ended gates.
  if (options.sendEmail) {
    result.email = await maybeAutoSendMeetingNotesEmail(id, {
      bypassIdleGate: true,
      bypassMeetingEndedGate: true,
    });
  }

  // 4) Unified Meetings lifecycle: done vs no_transcript.
  const lines = await transcriptLineCount(id);
  await touchUnifiedScheduledFromSession({ botId: id, upstreamStatus: "ended", lineCount: lines, ended: true });

  return result;
}

export async function handleRecallBotWebhook(payload: RecallBotWebhookPayload) {
  const event = String(payload?.event || "");
  const botId = String(payload?.data?.bot?.id || "").trim();
  if (!botId) return { action: "ignored", event, reason: "missing data.bot.id" };

  const status = STATUS_EVENTS[event];
  if (status) {
    await touchUnifiedScheduledFromSession({ botId, upstreamStatus: status });
    return { action: "status_recorded", event, botId, status };
  }

  const isSend = SEND_EVENTS.has(event);
  if (!isSend && !PREP_EVENTS.has(event)) return { action: "ignored", event, botId };

  if (!notesOnMeetingEndEnabled()) {
    return { action: "skipped", event, botId, reason: "NOTETAKER_NOTES_ON_MEETING_END=false" };
  }

  const endedAt = payload?.data?.data?.updated_at;
  const outcome = await finalizeMeetingAndSendNotes(botId, { event, endedAt, sendEmail: isSend });
  console.info(
    "[recall-bot-webhook]",
    JSON.stringify({
      ...outcome,
      email: outcome.email && {
        sent: outcome.email.sent,
        skipped: outcome.email.skipped,
        recipients: outcome.email.recipients?.length,
      },
    }),
  );
  return { action: isSend ? "notes_attempted" : "call_ended_prepared", ...outcome };
}
