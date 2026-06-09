import type { NotetakerSession, NotetakerSessionPayload } from "@/lib/alyson-notetaker-functions";
import { autoPersistEndedMeetingToS3, ensureMeetingNotesInS3, maybeCheckpointTranscriptToS3 } from "@/lib/notetaker-auto-persist.server";
import { notetakerTranscriptCronEnabled } from "@/lib/notetaker-cron-auth.server";
import {
  composeTranscript,
  contentHash,
  patchBotIndexCronStability,
} from "@/lib/notetaker-persistence.server";
import {
  ENDED_SESSION_STATUSES,
  autoPersistUnifiedScheduledBots,
} from "@/lib/notetaker-session-catalog.server";
import { withResolvedMeetingTitle } from "@/lib/notetaker-session-title.server";
import {
  listPersistedSessionsFromS3,
  loadBotIndexDoc,
  mergeSessionsIndexToS3,
  invalidatePersistedSessionsS3Cache,
} from "@/lib/notetaker-sessions-history.server";
import { listAllUnifiedScheduledBotSessions } from "@/lib/unifiedMeetingsService";
import { notetakerUpstream } from "@/lib/notetaker-upstream.server";

function normalizeSessionPayload(res: unknown, botId: string): NotetakerSessionPayload | null {
  if (!res || typeof res !== "object") return null;
  const o = res as Partial<NotetakerSessionPayload>;
  if (!o.session?.botId) return null;
  return {
    session: o.session,
    lines: Array.isArray(o.lines) ? o.lines : [],
    participantCount: Number(o.participantCount ?? 0),
    startedLabel: String(o.startedLabel ?? o.session.createdAt ?? ""),
    hasRecallConfig: Boolean(o.hasRecallConfig ?? true),
    hasGroqConfig: Boolean(o.hasGroqConfig ?? true),
    notesMd: o.notesMd,
    notesModel: o.notesModel,
  };
}

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
};

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
      if (id) botIds.add(id);
    }
  } catch (e) {
    warnings.push(`unified_scheduled: ${String(e)}`);
  }

  try {
    const s3Sessions = await listPersistedSessionsFromS3({ includeBotIndex: true });
    for (const s of s3Sessions) {
      const id = String(s.botId || "").trim();
      if (id) botIds.add(id);
    }
  } catch (e) {
    warnings.push(`s3_bot_index: ${String(e)}`);
  }

  return { botIds, warnings };
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

  const { botIds, warnings } = await collectBotIds();
  let written = 0;
  let notesWritten = 0;
  let skippedUnchanged = 0;
  let skippedFinalized = 0;
  let newlyFinalized = 0;
  let skippedEmpty = 0;
  let upstreamUnavailable = 0;
  let errors = 0;

  for (const botId of botIds) {
    try {
      const existingIndex = await loadBotIndexDoc(botId);
      if (existingIndex?.cronFinalized) {
        skippedFinalized += 1;
        continue;
      }

      let payload: NotetakerSessionPayload | null = null;
      try {
        const res = await notetakerUpstream(`/api/session/${encodeURIComponent(botId)}`);
        payload = normalizeSessionPayload(res, botId);
      } catch {
        upstreamUnavailable += 1;
        continue;
      }

      if (!payload?.lines?.length) {
        skippedEmpty += 1;
        continue;
      }

      const session = await withResolvedMeetingTitle(payload.session);
      const transcriptHash = contentHash(composeTranscript(payload.lines).transcriptText);
      const st = String(session.status || "").toLowerCase();
      const ended = ENDED_SESSION_STATUSES.has(st);

      if (ended) {
        let result = await autoPersistEndedMeetingToS3({
          session,
          lines: payload.lines,
          existingNotesMd: payload.notesMd,
          existingNotesModel: payload.notesModel,
        });
        if (result.skipped === "unchanged" || result.skipped === "notes_generation_failed") {
          const backfill = await ensureMeetingNotesInS3(botId);
          if (backfill.ok && backfill.notesMd?.trim()) {
            result = { persisted: true, notesMd: backfill.notesMd };
          }
        }
        if (result.persisted) {
          written += 1;
          if (result.notesMd?.trim()) notesWritten += 1;
        } else if (result.skipped === "unchanged") {
          skippedUnchanged += 1;
        }
      } else {
        const action = await maybeCheckpointTranscriptToS3(session, payload.lines, { bypassThrottle: true });
        if (action === "written") written += 1;
        else if (action === "unchanged") skippedUnchanged += 1;
      }

      const stability = await patchBotIndexCronStability(botId, transcriptHash, existingIndex);
      if (stability.newlyFinalized) newlyFinalized += 1;
    } catch (e) {
      errors += 1;
      warnings.push(`${botId}: ${String(e)}`);
    }
  }

  try {
    await autoPersistUnifiedScheduledBots();
  } catch (e) {
    warnings.push(`unified_persist: ${String(e)}`);
  }

  try {
    const { buildNotetakerSessionsList } = await import("@/lib/notetaker-sessions-list.server");
    const live = await buildNotetakerSessionsList();
    await mergeSessionsIndexToS3(live.sessions ?? []);
    invalidatePersistedSessionsS3Cache();
  } catch (e) {
    warnings.push(`sessions_index: ${String(e)}`);
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
    warnings: warnings.slice(0, 12),
  };
}
