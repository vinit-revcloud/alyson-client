import type { NotetakerSession } from "@/lib/alyson-notetaker-functions";
import { notetakerTranscriptCronEnabled } from "@/lib/notetaker-cron-auth.server";
import { driveSessionPersistToS3 } from "@/lib/notetaker-session-persist-drive.server";
import {
  listPersistedSessionsFromS3,
  mergeSessionsIndexToS3,
  invalidatePersistedSessionsS3Cache,
  listAllBotIndexDocs,
} from "@/lib/notetaker-sessions-history.server";
import { listAllUnifiedScheduledBotSessions } from "@/lib/unifiedMeetingsService";
import { notetakerUpstream } from "@/lib/notetaker-upstream.server";
import { runRecallMediaCleanup, type RecallMediaCleanupResult } from "@/lib/notetaker-recall-media-cleanup.server";
import { activateDueScheduledBotSessions } from "@/lib/notetaker-scheduled-bot-activation.server";

export type NotetakerTranscriptCronResult = {
  ok: boolean;
  ranAt: string;
  enabled: boolean;
  scanned: number;
  written: number;
  notesWritten: number;
  skippedUnchanged: number;
  skippedFinalized: number;
  newlyFinalized: number;
  skippedEmpty: number;
  upstreamUnavailable: number;
  errors: number;
  warnings: string[];
  recallMediaCleanup?: RecallMediaCleanupResult;
  scheduledBotActivation?: Awaited<ReturnType<typeof activateDueScheduledBotSessions>>;
  meetingIntegrity?: {
    scanned: number;
    repaired: number;
    superseded: number;
    issueCount: number;
  };
  notesAutoEmail?: {
    scanned: number;
    attempted: number;
    sent: number;
    skipped: number;
    errors: number;
  };
};

/**
 * Only meetings in this window are swept. Older bots are either finalized in S3 already or past
 * Recall's media retention (RECALL_RECORDING_RETENTION_HOURS, default 48h), so re-checking them
 * every run only burns the function time budget.
 */
function sweepLookbackMs(): number {
  const n = Number(process.env.NOTETAKER_CRON_LOOKBACK_HOURS || 72);
  return (Number.isFinite(n) && n > 0 ? n : 72) * 3_600_000;
}

function isInSweepWindow(iso: string | undefined | null): boolean {
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms)) return true; // unknown time — keep, cheap to check once
  const now = Date.now();
  return ms >= now - sweepLookbackMs() && ms <= now + 30 * 60_000;
}

/** Stop the per-bot persist loop before the serverless function is killed. */
function persistBudgetMs(): number {
  const n = Number(process.env.NOTETAKER_CRON_PERSIST_BUDGET_MS || 150_000);
  return Number.isFinite(n) && n > 0 ? n : 150_000;
}

async function collectBotIds(): Promise<{ botIds: Set<string>; warnings: string[] }> {
  const botIds = new Set<string>();
  const warnings: string[] = [];

  try {
    const data = (await notetakerUpstream("/api/sessions")) as { sessions?: NotetakerSession[] };
    for (const s of data.sessions ?? []) {
      const id = String(s.botId || "").trim();
      if (id) botIds.add(id);
    }
  } catch (e) {
    warnings.push(`upstream_sessions: ${String(e)}`);
  }

  try {
    const unified = await listAllUnifiedScheduledBotSessions();
    for (const r of unified) {
      const id = String(r.botId || "").trim();
      // Skip future bots (nothing to persist yet) and meetings older than the sweep window.
      if (id && isInSweepWindow(r.meetingStartAt || r.createdAt)) botIds.add(id);
    }
  } catch (e) {
    warnings.push(`unified_scheduled: ${String(e)}`);
  }

  try {
    const s3Sessions = await listPersistedSessionsFromS3({ includeBotIndex: true });
    for (const s of s3Sessions) {
      const id = String(s.botId || "").trim();
      if (id && isInSweepWindow(s.createdAt)) botIds.add(id);
    }
  } catch (e) {
    warnings.push(`s3_bot_index: ${String(e)}`);
  }

  return { botIds, warnings };
}

/** Recall-side transcript downloads per run. Must outpace daily bot volume or media expires (48h). */
function maxRecallBackfillsPerCron(): number {
  const n = Number(process.env.NOTETAKER_CRON_MAX_BACKFILLS || 25);
  return Number.isFinite(n) && n >= 0 ? n : 25;
}

function isCronFinalizedBot(
  botId: string,
  indexByBotId: Map<
    string,
    { cronFinalized?: boolean; transcriptKey?: string; transcriptHash?: string; recallCallEndedAt?: string | null }
  >,
): boolean {
  const index = indexByBotId.get(botId);
  return Boolean(index?.cronFinalized && index.transcriptKey && index.transcriptHash);
}

/**
 * Cron-safe transcript dump: scans every known bot, fetches upstream lines,
 * writes to S3 only when content hash changes (no duplicate dumps).
 */
export async function runNotetakerTranscriptCron(): Promise<NotetakerTranscriptCronResult> {
  const ranAt = new Date().toISOString();
  if (!notetakerTranscriptCronEnabled()) {
    return {
      ok: true,
      ranAt,
      enabled: false,
      scanned: 0,
      written: 0,
      notesWritten: 0,
      skippedUnchanged: 0,
      skippedFinalized: 0,
      newlyFinalized: 0,
      skippedEmpty: 0,
      upstreamUnavailable: 0,
      errors: 0,
      warnings: ["NOTETAKER_TRANSCRIPT_CRON_ENABLED=false"],
    };
  }

  const warnings: string[] = [];
  let scheduledBotActivation: Awaited<ReturnType<typeof activateDueScheduledBotSessions>> | undefined;
  try {
    scheduledBotActivation = await activateDueScheduledBotSessions();
  } catch (e) {
    warnings.push(`scheduled_bot_activation: ${String(e)}`);
  }

  // Scheduling bots for upcoming meetings is the most time-critical job — run it before the
  // transcript sweep so a slow sweep can never starve it (it used to run last and time out).
  try {
    const { runUnifiedMeetingsBackgroundMaintenance } = await import("@/lib/unified-meetings-background.server");
    const um = await runUnifiedMeetingsBackgroundMaintenance();
    if (um.warnings.length) warnings.push(...um.warnings);
    if (um.allowlistedBotsScheduled > 0) {
      warnings.push(`unified_meetings: scheduled ${um.allowlistedBotsScheduled} allowlisted bot(s)`);
    }
    if (um.calendarBotsScheduled > 0) {
      warnings.push(`unified_meetings: scheduled ${um.calendarBotsScheduled} calendar bot(s)`);
    }
  } catch (e) {
    warnings.push(`unified_meetings: ${String(e)}`);
  }

  const { botIds, warnings: collectWarnings } = await collectBotIds();
  warnings.push(...collectWarnings);

  let indexByBotId = new Map<
    string,
    {
      cronFinalized?: boolean;
      transcriptKey?: string;
      transcriptHash?: string;
      recallCallEndedAt?: string | null;
    }
  >();
  try {
    const docs = await listAllBotIndexDocs();
    indexByBotId = new Map(
      docs.map((doc) => [
        String(doc.botId || "").trim(),
        {
          cronFinalized: doc.cronFinalized,
          transcriptKey: doc.transcriptKey,
          transcriptHash: doc.transcriptHash,
          recallCallEndedAt: doc.recallCallEndedAt,
        },
      ]),
    );
  } catch (e) {
    warnings.push(`bot_index_prefetch: ${String(e)}`);
  }

  let written = 0;
  let notesWritten = 0;
  let skippedUnchanged = 0;
  let skippedFinalized = 0;
  let newlyFinalized = 0;
  let skippedEmpty = 0;
  let upstreamUnavailable = 0;
  let errors = 0;
  let recallBackfillsAttempted = 0;

  const loopStartedAt = Date.now();
  let budgetExhausted = 0;
  for (const botId of botIds) {
    if (Date.now() - loopStartedAt > persistBudgetMs()) {
      budgetExhausted += 1;
      continue;
    }
    try {
      const skipRecall = isCronFinalizedBot(botId, indexByBotId);
      if (skipRecall) {
        // Already finalized with a stored transcript — notes/email catch-up happens in the sweep below.
        skippedUnchanged += 1;
        skippedFinalized += 1;
        continue;
      }
      const driveResult = await driveSessionPersistToS3(botId, {
        bypassThrottle: true,
        skipRecallFetch: skipRecall,
      });
      if (driveResult === "written") {
        written += 1;
        // Notes after meeting ended + transcript idle >=15m, then SES auto-email.
        try {
          const { maybeAutoSendMeetingNotesEmail } = await import(
            "@/lib/notetaker-meeting-notes-auto-email.server"
          );
          const notes = await maybeAutoSendMeetingNotesEmail(botId);
          if (notes.notesGenerated) notesWritten += 1;
        } catch {
          // notes/email listener is best-effort
        }
        const { maybeGenerateMeetingTasksWhenReady } = await import(
          "@/lib/notetaker-meeting-list-tasks.server"
        );
        void maybeGenerateMeetingTasksWhenReady(botId);
      } else if (driveResult === "unchanged" || driveResult === "skipped_complete") {
        skippedUnchanged += 1;
        if (driveResult === "skipped_complete") skippedFinalized += 1;
        // Catch-up: ended + idle >=15m -> notes + SES auto-email.
        try {
          const { maybeAutoSendMeetingNotesEmail } = await import(
            "@/lib/notetaker-meeting-notes-auto-email.server"
          );
          const notes = await maybeAutoSendMeetingNotesEmail(botId);
          if (notes.notesGenerated) notesWritten += 1;
        } catch {
          // ignore
        }
      } else if (driveResult === "empty") {
        skippedEmpty += 1;
        if (!skipRecall && recallBackfillsAttempted < maxRecallBackfillsPerCron()) {
          recallBackfillsAttempted += 1;
          try {
            const { backfillTranscriptFromRecall } = await import("@/lib/recall/recall-transcript-backfill.server");
            const backfill = await backfillTranscriptFromRecall(botId);
            if (backfill.ok && backfill.persisted) {
              written += 1;
              skippedEmpty -= 1;
              try {
                const { maybeAutoSendMeetingNotesEmail } = await import(
                  "@/lib/notetaker-meeting-notes-auto-email.server"
                );
                const notes = await maybeAutoSendMeetingNotesEmail(botId);
                if (notes.notesGenerated) notesWritten += 1;
              } catch {
                // wait for idle window
              }
            }
          } catch {
            // backfill is best-effort
          }
        }
      } else if (driveResult === "unavailable") {
        upstreamUnavailable += 1;
      } else {
        errors += 1;
      }
    } catch (e) {
      errors += 1;
      warnings.push(`${botId}: ${String(e)}`);
    }
  }

  if (budgetExhausted > 0) {
    warnings.push(`persist_budget: ${budgetExhausted} bot(s) deferred to next run`);
  }

  // Unified bots are already in collectBotIds(); skip a second persist pass with Recall GETs.

  try {
    const { buildNotetakerSessionsList } = await import("@/lib/notetaker-sessions-list.server");
    // skipMaintenance: cron already persisted above — avoid a third full sweep.
    const live = await buildNotetakerSessionsList({ skipMaintenance: true });
    await mergeSessionsIndexToS3(live.sessions ?? []);
    invalidatePersistedSessionsS3Cache();
  } catch (e) {
    warnings.push(`sessions_index: ${String(e)}`);
  }

  let recallMediaCleanup: RecallMediaCleanupResult | undefined;
  try {
    recallMediaCleanup = await runRecallMediaCleanup();
  } catch (e) {
    warnings.push(`recall_media_cleanup: ${String(e)}`);
  }

  try {
    const { leaveEmailSyncEnabled } = await import("@/lib/leave-email-schema");
    if (leaveEmailSyncEnabled()) {
      const { runLeaveEmailSync } = await import("@/lib/leave-email-sync.server");
      const leaveSync = await runLeaveEmailSync({ lookbackDays: 30, maxMessages: 50 });
      if (leaveSync.applied > 0) {
        warnings.push(`leave_email: applied ${leaveSync.applied} leave(s) to ledger`);
      }
      if (leaveSync.duplicates > 0) {
        warnings.push(`leave_email: ${leaveSync.duplicates} already on ledger (skipped)`);
      }
      if (leaveSync.errors.length) {
        warnings.push(`leave_email: ${leaveSync.errors[0]}`);
      }
    }
  } catch (e) {
    warnings.push(`leave_email: ${String(e)}`);
  }

  let meetingIntegrity: NotetakerTranscriptCronResult["meetingIntegrity"];
  try {
    const { runNotetakerMeetingIntegrityCheck } = await import(
      "@/lib/notetaker-meeting-integrity.server"
    );
    const integrity = await runNotetakerMeetingIntegrityCheck({ repair: true });
    meetingIntegrity = {
      scanned: integrity.scanned,
      repaired: integrity.repaired,
      superseded: integrity.superseded,
      issueCount: integrity.issues.length,
    };
    if (integrity.repaired > 0 || integrity.superseded > 0) {
      warnings.push(
        `meeting_integrity: repaired=${integrity.repaired} superseded=${integrity.superseded} issues=${integrity.issues.length}`,
      );
    }
  } catch (e) {
    warnings.push(`meeting_integrity: ${String(e)}`);
  }

  let notesAutoEmail: NotetakerTranscriptCronResult["notesAutoEmail"];
  try {
    const { sweepAutoSendMeetingNotesEmails } = await import(
      "@/lib/notetaker-meeting-notes-auto-email.server"
    );
    const sweep = await sweepAutoSendMeetingNotesEmails();
    notesAutoEmail = {
      scanned: sweep.scanned,
      attempted: sweep.attempted,
      sent: sweep.sent,
      skipped: sweep.skipped,
      errors: sweep.errors,
    };
    if (sweep.sent > 0 || sweep.errors > 0) {
      warnings.push(
        `notes_auto_email: sent=${sweep.sent} attempted=${sweep.attempted} errors=${sweep.errors}`,
      );
    }
  } catch (e) {
    warnings.push(`notes_auto_email: ${String(e)}`);
  }

  return {
    ok: errors === 0,
    ranAt,
    enabled: true,
    scanned: botIds.size,
    written,
    notesWritten,
    skippedUnchanged,
    skippedFinalized,
    newlyFinalized,
    skippedEmpty,
    upstreamUnavailable,
    errors,
    warnings: warnings.slice(0, 16),
    recallMediaCleanup,
    scheduledBotActivation,
    meetingIntegrity,
    notesAutoEmail,
  };
}
