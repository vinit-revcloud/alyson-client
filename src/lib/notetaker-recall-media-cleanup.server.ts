import {
  deleteRecallBotMedia,
  recallMediaCleanupEnabled,
  recallMediaDeleteAfterMs,
} from "@/lib/recall/recall-delete-media.server";
import { patchBotIndexRecallMediaDeleted } from "@/lib/notetaker-persistence.server";
import { getTranscriptTextFromS3 } from "@/lib/notetaker-s3-calendar.server";
import { listAllBotIndexDocs } from "@/lib/notetaker-sessions-history.server";

export type RecallMediaCleanupResult = {
  enabled: boolean;
  deleteAfterHours: number;
  scanned: number;
  eligible: number;
  deleted: number;
  skippedTooRecent: number;
  skippedAlreadyDeleted: number;
  skippedNoTranscript: number;
  skippedInProgress: number;
  errors: number;
  warnings: string[];
};

function persistAnchorIso(doc: {
  finalizedAt?: string;
  cronFinalizedAt?: string;
}): string | null {
  const anchor = String(doc.finalizedAt || doc.cronFinalizedAt || "").trim();
  if (!anchor || !Number.isFinite(Date.parse(anchor))) return null;
  return anchor;
}

function cleanupBatchSize(): number {
  const n = Number(process.env.RECALL_MEDIA_CLEANUP_BATCH_SIZE ?? "40");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 40;
}

/**
 * Delete Recall-side bot media once our S3 copy is at least N hours old (default 24h).
 * Safe to run on a schedule — skips bots still in-call or missing S3 transcripts.
 */
export async function runRecallMediaCleanup(): Promise<RecallMediaCleanupResult> {
  const deleteAfterMs = recallMediaDeleteAfterMs();
  const deleteAfterHours = deleteAfterMs / (60 * 60 * 1000);
  const empty: RecallMediaCleanupResult = {
    enabled: false,
    deleteAfterHours,
    scanned: 0,
    eligible: 0,
    deleted: 0,
    skippedTooRecent: 0,
    skippedAlreadyDeleted: 0,
    skippedNoTranscript: 0,
    skippedInProgress: 0,
    errors: 0,
    warnings: [],
  };

  if (!recallMediaCleanupEnabled()) return empty;

  const now = Date.now();
  const cutoff = now - deleteAfterMs;
  const warnings: string[] = [];
  let eligible = 0;
  let deleted = 0;
  let skippedTooRecent = 0;
  let skippedAlreadyDeleted = 0;
  let skippedNoTranscript = 0;
  let skippedInProgress = 0;
  let errors = 0;

  const docs = await listAllBotIndexDocs();
  const pending = [];
  for (const doc of docs) {
    if (doc.recallMediaDeletedAt) {
      skippedAlreadyDeleted += 1;
      continue;
    }
    const anchor = persistAnchorIso(doc);
    if (!anchor) continue;
    if (Date.parse(anchor) > cutoff) {
      skippedTooRecent += 1;
      continue;
    }
    if (!doc.transcriptKey && !doc.prefix) continue;
    pending.push(doc);
  }

  eligible = pending.length;
  const batch = pending.slice(0, cleanupBatchSize());

  for (const doc of batch) {
    const botId = String(doc.botId || "").trim();
    if (!botId) continue;

    const transcriptKey =
      doc.transcriptKey ||
      (doc.prefix ? `alyson-notetaker/transcripts/${doc.prefix}/transcript.txt` : null);
    if (!transcriptKey) {
      skippedNoTranscript += 1;
      continue;
    }

    try {
      const transcriptText = (await getTranscriptTextFromS3({ transcriptKey })).trim();
      if (!transcriptText) {
        skippedNoTranscript += 1;
        continue;
      }
    } catch {
      skippedNoTranscript += 1;
      continue;
    }

    try {
      const result = await deleteRecallBotMedia(botId);
      if (result.ok) {
        await patchBotIndexRecallMediaDeleted(botId, { deletedAt: new Date().toISOString() });
        deleted += 1;
        continue;
      }
      if (result.skipped === "bot_not_found") {
        await patchBotIndexRecallMediaDeleted(botId, { deletedAt: new Date().toISOString() });
        deleted += 1;
        continue;
      }
      if (result.skipped === "bot_in_progress" || result.skipped === "delete_in_progress") {
        skippedInProgress += 1;
        continue;
      }
      if (result.skipped === "recall_not_configured") {
        warnings.push("RECALL_API_KEY missing — cleanup disabled");
        break;
      }
    } catch (e) {
      errors += 1;
      warnings.push(`${botId}: ${String(e)}`);
    }
  }

  return {
    enabled: true,
    deleteAfterHours,
    scanned: docs.length,
    eligible,
    deleted,
    skippedTooRecent,
    skippedAlreadyDeleted,
    skippedNoTranscript,
    skippedInProgress,
    errors,
    warnings: warnings.slice(0, 12),
  };
}
