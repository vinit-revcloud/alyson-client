import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getNotesMdFromS3, getTranscriptTextFromS3, listMeetingsFromS3, auditNotesCoverageFromS3 } from "@/lib/notetaker-s3-calendar.server";
import { ensureMeetingNotesInS3, ensureMeetingNotesByPrefix, backfillAllMissingNotesFromS3 } from "@/lib/notetaker-auto-persist.server";

const RangeInput = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const listMeetingsFromS3Range = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => RangeInput.parse(data))
  .handler(async ({ data }) => {
    const meetings = await listMeetingsFromS3({ start: data.start, end: data.end });
    return { meetings };
  });

const NotesInput = z.object({ notesKey: z.string().min(1) });

/** POST — faster and more reliable than GET for TanStack Start server fns (S3 read only). */
export const getMeetingNotesMdFromS3 = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => NotesInput.parse(data))
  .handler(async ({ data }) => {
    const notesMd = await getNotesMdFromS3({ notesKey: data.notesKey });
    return { notesMd };
  });

const TranscriptInput = z.object({ transcriptKey: z.string().min(1) });

/** POST — direct S3 read, no LLM generation. */
export const getMeetingTranscriptTextFromS3 = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => TranscriptInput.parse(data))
  .handler(async ({ data }) => {
    const transcriptText = await getTranscriptTextFromS3({ transcriptKey: data.transcriptKey });
    return { transcriptText };
  });

const EnsureNotesInput = z
  .object({
    botId: z.string().min(1).optional(),
    prefix: z.string().min(1).optional(),
  })
  .refine((d) => Boolean(d.botId || d.prefix), { message: "botId or prefix required" });

/** Generate notes from S3 transcript and persist notes.md when missing. */
export const ensureMeetingNotesInS3Fn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => EnsureNotesInput.parse(data))
  .handler(async ({ data }) => {
    if (data.botId) {
      const r = await ensureMeetingNotesInS3(data.botId);
      if (r.ok) return r;
      if (data.prefix) {
        const byPrefix = await ensureMeetingNotesByPrefix(data.prefix, data.botId);
        return { ok: byPrefix.ok, notesKey: byPrefix.notesKey, notesMd: byPrefix.notesMd, skipped: byPrefix.skipped };
      }
      return r;
    }
    const byPrefix = await ensureMeetingNotesByPrefix(String(data.prefix));
    return { ok: byPrefix.ok, notesKey: byPrefix.notesKey, notesMd: byPrefix.notesMd, skipped: byPrefix.skipped };
  });

/** Read-only audit: which transcripts lack notes.md in S3. */
export const auditNotetakerNotesCoverage = createServerFn({ method: "GET" }).handler(async () => {
  const report = await auditNotesCoverageFromS3();
  return { report };
});

const BackfillInput = z.object({
  all: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

/** Generate missing notes — `all: true` processes every transcript without notes. */
export const backfillMissingNotetakerNotes = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => BackfillInput.parse(data ?? {}))
  .handler(async ({ data }) => {
    if (data.all) {
      return backfillAllMissingNotesFromS3();
    }

    const { auditNotesCoverageFromS3 } = await import("@/lib/notetaker-s3-calendar.server");
    const report = await auditNotesCoverageFromS3();
    const limit = data.limit ?? 10;
    const results: Array<{ prefix: string; botId: string | null; ok: boolean; skipped?: string }> = [];

    for (const t of report.missingNotes.slice(0, limit)) {
      let r: { ok: boolean; skipped?: string };
      if (t.botId) {
        r = await ensureMeetingNotesInS3(String(t.botId));
      } else {
        const { ensureMeetingNotesByPrefix } = await import("@/lib/notetaker-auto-persist.server");
        r = await ensureMeetingNotesByPrefix(t.prefix, t.botId ?? undefined);
      }
      results.push({ prefix: t.prefix, botId: t.botId, ok: r.ok, skipped: r.skipped });
    }

    const after = await auditNotesCoverageFromS3();
    return {
      attempted: results.length,
      succeeded: results.filter((x) => x.ok).length,
      failed: results.filter((x) => !x.ok).length,
      remainingMissing: after.missingNotes.length,
      results,
      report: after,
    };
  });

