import {
  deleteRecallBotMedia,
  RECALL_MEDIA_DELETE_AFTER_MS,
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

const CLEANUP_BATCH_SIZE = 100;
const MAX_DELETIONS_PER_RUN = 500;

function persistAnchorIso(doc: {
  finalizedAt?: string;
  cronFinalizedAt?: string;
}): string | null {
  const anchor = String(doc.finalizedAt || doc.cronFinalizedAt || "").trim();
  if (!anchor || !Number.isFinite(Date.parse(anchor))) return null;
  return anchor;
}

/**
 * Delete Recall-side bot media once our S3 copy is at least 1 day old.
 * Safe to run on a schedule — skips bots still in-call or missing S3 transcripts.
 */
export async function runRecallMediaCleanup(): Promise<RecallMediaCleanupResult> {
  const deleteAfterHours = RECALL_MEDIA_DELETE_AFTER_MS / (60 * 60 * 1000);
  const now = Date.now();
  const cutoff = now - RECALL_MEDIA_DELETE_AFTER_MS;
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

  for (let offset = 0; offset < pending.length && deleted < MAX_DELETIONS_PER_RUN; offset += CLEANUP_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + CLEANUP_BATCH_SIZE);
    let recallUnavailable = false;

    for (const doc of batch) {
      if (deleted >= MAX_DELETIONS_PER_RUN) break;

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
          recallUnavailable = true;
          break;
        }
      } catch (e) {
        errors += 1;
        warnings.push(`${botId}: ${String(e)}`);
      }
    }

    if (recallUnavailable) break;
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
