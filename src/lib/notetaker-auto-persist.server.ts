import type { NotetakerSession, NotetakerTranscriptLine } from "@/lib/alyson-notetaker-functions";
import { composeTranscript, contentHash, persistMeetingToS3 } from "@/lib/notetaker-persistence.server";
import { withResolvedMeetingTitle } from "@/lib/notetaker-session-title.server";
import { runSmartMeetingNotes } from "@/lib/notetaker-smart-notes.server";
import { loadBotIndexDoc, mergeNotetakerSessions } from "@/lib/notetaker-sessions-history.server";
import { getNotesMdFromS3, getTranscriptTextFromS3, invalidateNotetakerCalendarS3Cache } from "@/lib/notetaker-s3-calendar.server";
import { registerScheduledBotInSessionsCatalog } from "@/lib/notetaker-scheduled-catalog.server";
import { getNotetakerSessionsIndexFromS3, putNotetakerSessionsIndexToS3 } from "@/lib/notetaker-sessions-s3.server";

function autoPersistEnabled() {
  return String(process.env.NOTETAKER_AUTO_PERSIST_S3 ?? "true").trim().toLowerCase() !== "false";
}

function linesFromPlainTranscript(transcriptText: string): NotetakerTranscriptLine[] {
  const baseTime = Date.now();
  return transcriptText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      const m = line.match(/^([^:]+):\s*(.+)$/);
      return {
        received_at: new Date(baseTime + i).toISOString(),
        event: "transcript",
        participant: { name: (m?.[1] || "Speaker").trim() },
        text: (m?.[2] || line).trim(),
      };
    });
}

async function notesAbsentFromS3(
  existingIndex: Awaited<ReturnType<typeof loadBotIndexDoc>>,
): Promise<boolean> {
  if (!existingIndex?.notesKey) return true;
  try {
    const md = await getNotesMdFromS3({ notesKey: String(existingIndex.notesKey) });
    return !md.trim();
  } catch {
    return true;
  }
}

async function transcriptTextForNotes(args: {
  botId: string;
  session: NotetakerSession;
  lines: NotetakerTranscriptLine[];
}): Promise<string> {
  const fromLines = composeTranscript(args.lines).transcriptText.trim();
  if (fromLines) return fromLines;

  try {
    const idx = await loadBotIndexDoc(args.botId);
    if (idx?.transcriptKey) {
      return (await getTranscriptTextFromS3({ transcriptKey: String(idx.transcriptKey) })).trim();
    }
  } catch {
    // fall through
  }
  return "";
}

async function resolveNotesForS3(args: {
  botId: string;
  session: NotetakerSession;
  lines: NotetakerTranscriptLine[];
  existingNotesMd?: string | null;
  existingNotesModel?: string;
  forceNotes?: boolean;
}): Promise<{ notesMd: string; model?: string } | null> {
  if (!args.forceNotes && args.existingNotesMd?.trim()) {
    return { notesMd: args.existingNotesMd.trim(), model: args.existingNotesModel || "existing" };
  }

  if (!args.forceNotes) {
    try {
      const idx = await loadBotIndexDoc(args.botId);
      if (idx?.notesKey) {
        const fromS3 = await getNotesMdFromS3({ notesKey: String(idx.notesKey) });
        if (fromS3.trim()) {
          return { notesMd: fromS3.trim(), model: "s3" };
        }
      }
    } catch {
      // fall through to generation
    }
  }

  const transcriptText = await transcriptTextForNotes({
    botId: args.botId,
    session: args.session,
    lines: args.lines,
  });
  if (!transcriptText) return null;

  try {
    const smart = await runSmartMeetingNotes({
      title: args.session.title || "Meeting",
      transcriptText,
    });
    if (String(smart?.notes || "").trim()) {
      return { notesMd: String(smart.notes).trim(), model: smart.model };
    }
  } catch (e) {
    if (args.forceNotes) throw e;
    // notes optional when not forced
  }

  return null;
}

async function appendSessionToS3Index(session: NotetakerSession) {
  let existing: NotetakerSession[] = [];
  try {
    const idx = await getNotetakerSessionsIndexFromS3();
    existing = idx.sessions ?? [];
  } catch {
    // no index yet
  }
  const merged = mergeNotetakerSessions(existing, [
    { ...session, status: "persisted" },
  ]);
  await putNotetakerSessionsIndexToS3({ sessions: merged });
}

export type AutoPersistResult = {
  persisted: boolean;
  skipped?: string;
  notesMd?: string | null;
  notesModel?: string;
};

const checkpointThrottle = new Map<string, { at: number; hash: string }>();

function checkpointMinMs() {
  const n = Number(process.env.NOTETAKER_CHECKPOINT_MIN_MS || 10_000);
  return Number.isFinite(n) && n >= 3_000 ? Math.min(n, 60_000) : 10_000;
}

function endedStatus(status?: string) {
  return ["ended", "completed", "disconnected", "left", "finished", "persisted"].includes(
    String(status || "").toLowerCase(),
  );
}

/**
 * Incrementally write transcript to S3 while a meeting is live (or after upstream TTL).
 * Overwrites transcript.txt when line count grows; reuses bot-index prefix.
 */
export type TranscriptPersistAction = "written" | "unchanged" | "skipped_empty" | "disabled";

async function maybeGenerateNotesAfterCheckpoint(
  session: NotetakerSession,
  lines: NotetakerTranscriptLine[],
  existingIndex: Awaited<ReturnType<typeof loadBotIndexDoc>>,
) {
  if (!endedStatus(session.status)) return;
  if (!(await notesAbsentFromS3(existingIndex))) return;
  try {
    await autoPersistEndedMeetingToS3({
      session: await withResolvedMeetingTitle(session),
      lines,
      forceNotes: true,
    });
  } catch {
    // best-effort notes after transcript is in S3
  }
}

export async function maybeCheckpointTranscriptToS3(
  session: NotetakerSession,
  lines: NotetakerTranscriptLine[],
  options?: { bypassThrottle?: boolean },
): Promise<TranscriptPersistAction> {
  if (!autoPersistEnabled()) return "disabled";

  const botId = String(session.botId || "").trim();
  if (!botId || !lines.length) return "skipped_empty";

  const transcript = composeTranscript(lines);
  const transcriptText = transcript.transcriptText.trim();
  if (!transcriptText) return "skipped_empty";

  const hash = contentHash(transcriptText);
  const existingIndex = await loadBotIndexDoc(botId);
  if (existingIndex?.transcriptHash === hash) {
    checkpointThrottle.set(botId, { at: Date.now(), hash });
    await maybeGenerateNotesAfterCheckpoint(session, lines, existingIndex);
    return "unchanged";
  }

  const prev = checkpointThrottle.get(botId);
  if (
    !options?.bypassThrottle &&
    prev?.hash === hash &&
    Date.now() - prev.at < checkpointMinMs()
  ) {
    await maybeGenerateNotesAfterCheckpoint(session, lines, existingIndex);
    return "unchanged";
  }

  const resolved = await withResolvedMeetingTitle(session);
  const result = await persistMeetingToS3({
    session: resolved,
    lines,
    notes: null,
    existingIndex: existingIndex
      ? {
          version: 1,
          botId,
          title: existingIndex.title,
          prefix: existingIndex.prefix,
          transcriptKey: existingIndex.transcriptKey,
          notesKey: existingIndex.notesKey,
          finalizedAt: existingIndex.finalizedAt,
          lineCount: existingIndex.lineCount,
          wordCount: existingIndex.wordCount,
          transcriptHash: existingIndex.transcriptHash,
          notesHash: existingIndex.notesHash,
        }
      : null,
  });

  if (result.skippedDuplicate) {
    checkpointThrottle.set(botId, { at: Date.now(), hash });
    await maybeGenerateNotesAfterCheckpoint(resolved, lines, existingIndex);
    return "unchanged";
  }

  try {
    await registerScheduledBotInSessionsCatalog({
      ...resolved,
      status: endedStatus(resolved.status) ? "persisted" : resolved.status || "in_call",
    });
    const { invalidatePersistedSessionsS3Cache } = await import("@/lib/notetaker-sessions-history.server");
    invalidatePersistedSessionsS3Cache();
  } catch {
    // best-effort catalog touch
  }

  const { touchUnifiedScheduledFromSession } = await import("@/lib/unified-scheduled-lifecycle.server");
  await touchUnifiedScheduledFromSession({
    botId,
    upstreamStatus: resolved.status,
    lineCount: lines.length,
    ended: endedStatus(resolved.status),
  });

  checkpointThrottle.set(botId, { at: Date.now(), hash });

  if (endedStatus(resolved.status)) {
    await maybeGenerateNotesAfterCheckpoint(resolved, lines, existingIndex);
  }

  return "written";
}

/**
 * Write transcript (+ optional notes) to S3 when a meeting ends.
 * Idempotent: skips if bot-index already exists unless force=true.
 */
export async function autoPersistEndedMeetingToS3(args: {
  session: NotetakerSession;
  lines: NotetakerTranscriptLine[];
  existingNotesMd?: string | null;
  existingNotesModel?: string;
  force?: boolean;
  forceNotes?: boolean;
}): Promise<AutoPersistResult> {
  if (!autoPersistEnabled()) {
    return { persisted: false, skipped: "auto_persist_disabled" };
  }

  const botId = String(args.session.botId || "").trim();
  if (!botId) return { persisted: false, skipped: "missing_bot_id" };

  const transcript = composeTranscript(args.lines);
  if (!transcript.transcriptText.trim()) {
    return { persisted: false, skipped: "empty_transcript" };
  }

  const existingIndex = await loadBotIndexDoc(botId).catch(() => null);
  const session = await withResolvedMeetingTitle(args.session);
  const transcriptHash = contentHash(transcript.transcriptText);
  const notesAbsent = await notesAbsentFromS3(existingIndex);

  const notes = await resolveNotesForS3({
    botId,
    session,
    lines: args.lines,
    existingNotesMd: args.existingNotesMd,
    existingNotesModel: args.existingNotesModel,
    forceNotes: Boolean(args.forceNotes || args.force || notesAbsent),
  });

  if (!args.force) {
    const transcriptUnchanged = existingIndex?.transcriptHash === transcriptHash;
    const notesHash = notes?.notesMd ? contentHash(notes.notesMd) : null;
    const notesUnchanged = Boolean(notes?.notesMd) && existingIndex?.notesHash === notesHash;

    if (transcriptUnchanged && notesUnchanged) {
      return {
        persisted: false,
        skipped: "unchanged",
        notesMd: notes?.notesMd ?? null,
        notesModel: notes?.model,
      };
    }

    if (transcriptUnchanged && notesAbsent && !notes?.notesMd?.trim()) {
      return { persisted: false, skipped: "notes_generation_failed" };
    }
  }

  const result = await persistMeetingToS3({
    session,
    lines: args.lines,
    notes: notes ? { notesMd: notes.notesMd, model: notes.model } : null,
    existingIndex: existingIndex
      ? {
          version: 1,
          botId,
          title: existingIndex.title,
          prefix: existingIndex.prefix,
          transcriptKey: existingIndex.transcriptKey,
          notesKey: existingIndex.notesKey,
          finalizedAt: existingIndex.finalizedAt,
          lineCount: existingIndex.lineCount,
          wordCount: existingIndex.wordCount,
          transcriptHash: existingIndex.transcriptHash,
          notesHash: existingIndex.notesHash,
        }
      : null,
  });

  if (result.skippedDuplicate) {
    return { persisted: false, skipped: "unchanged" };
  }

  try {
    await appendSessionToS3Index({
      ...session,
      status: "persisted",
    });
    const { invalidatePersistedSessionsS3Cache } = await import("@/lib/notetaker-sessions-history.server");
    invalidatePersistedSessionsS3Cache();
  } catch {
    // transcript/notes saved; index update is best-effort
  }

  const { touchUnifiedScheduledFromSession } = await import("@/lib/unified-scheduled-lifecycle.server");
  await touchUnifiedScheduledFromSession({
    botId,
    upstreamStatus: session.status || "persisted",
    lineCount: args.lines.length,
    ended: true,
  });

  if (!result.skippedDuplicate && (result.wroteTranscript || result.wroteNotes)) {
    invalidateNotetakerCalendarS3Cache();
  }

  return {
    persisted: true,
    notesMd: notes?.notesMd ?? null,
    notesModel: notes?.model,
  };
}

/** Generate + write notes.md to S3 when transcript exists but notes are missing. */
export async function ensureMeetingNotesInS3(botId: string): Promise<{
  ok: boolean;
  notesKey?: string | null;
  notesMd?: string | null;
  skipped?: string;
}> {
  if (!autoPersistEnabled()) {
    return { ok: false, skipped: "auto_persist_disabled" };
  }

  const id = String(botId || "").trim();
  if (!id) return { ok: false, skipped: "missing_bot_id" };

  const existingIndex = await loadBotIndexDoc(id).catch(() => null);
  if (!(await notesAbsentFromS3(existingIndex))) {
    try {
      const md = await getNotesMdFromS3({ notesKey: String(existingIndex!.notesKey) });
      return { ok: true, notesKey: existingIndex?.notesKey ?? null, notesMd: md };
    } catch {
      return { ok: true, notesKey: existingIndex?.notesKey ?? null };
    }
  }

  if (existingIndex?.prefix) {
    const direct = await ensureMeetingNotesByPrefix(existingIndex.prefix, id);
    if (direct.ok) return direct;
    if (direct.skipped && direct.skipped !== "notes_generation_failed") {
      // keep trying auto-persist unless hard failure
    }
  }

  if (!existingIndex?.transcriptKey && !existingIndex?.prefix) {
    return { ok: false, skipped: "no_transcript_in_s3" };
  }

  let lines: NotetakerTranscriptLine[] = [];
  try {
    const transcriptKey =
      existingIndex!.transcriptKey ||
      `alyson-notetaker/transcripts/${existingIndex!.prefix}/transcript.txt`;
    const text = await getTranscriptTextFromS3({ transcriptKey });
    lines = linesFromPlainTranscript(text);
  } catch {
    return { ok: false, skipped: "transcript_read_failed" };
  }

  if (!lines.length) return { ok: false, skipped: "empty_transcript" };

  const session: NotetakerSession = {
    botId: id,
    title: String(existingIndex!.title || "Meeting"),
    createdAt: String(existingIndex!.finalizedAt || new Date().toISOString()),
    status: "persisted",
  };

  let result: AutoPersistResult;
  try {
    result = await autoPersistEndedMeetingToS3({
      session,
      lines,
      forceNotes: true,
      force: true,
    });
  } catch (e) {
    return { ok: false, skipped: e instanceof Error ? e.message : "notes_generation_failed" };
  }

  const idx = await loadBotIndexDoc(id).catch(() => null);
  if (result.notesMd?.trim()) {
    invalidateNotetakerCalendarS3Cache();
    return { ok: true, notesKey: idx?.notesKey ?? null, notesMd: result.notesMd };
  }

  if (existingIndex?.prefix) {
    const fallback = await ensureMeetingNotesByPrefix(existingIndex.prefix, id);
    if (fallback.ok) {
      return { ok: true, notesKey: fallback.notesKey ?? null, notesMd: fallback.notesMd ?? null };
    }
    return { ok: false, skipped: fallback.skipped || "notes_generation_failed" };
  }

  return { ok: false, skipped: result.skipped || "notes_generation_failed" };
}

function titleFromPrefix(prefix: string): string {
  const parts = prefix.split("_");
  parts.pop();
  parts.pop();
  return (parts.join("_") || "Meeting").replaceAll("-", " ").trim() || "Meeting";
}

/** Generate notes from transcript path when bot-index is missing. */
export async function ensureMeetingNotesByPrefix(
  prefix: string,
  botId?: string,
): Promise<{
  ok: boolean;
  notesKey?: string;
  notesMd?: string;
  skipped?: string;
}> {
  const notesKey = `alyson-notetaker/meetingnotes/${prefix}/notes.md`;
  try {
    const existing = await getNotesMdFromS3({ notesKey });
    if (existing.trim()) return { ok: true, notesKey, notesMd: existing };
  } catch {
    // generate below
  }

  const transcriptKey = `alyson-notetaker/transcripts/${prefix}/transcript.txt`;
  let transcriptText = "";
  try {
    transcriptText = (await getTranscriptTextFromS3({ transcriptKey })).trim();
  } catch {
    return { ok: false, skipped: "transcript_read_failed" };
  }
  if (!transcriptText) return { ok: false, skipped: "empty_transcript" };

  try {
    const smart = await runSmartMeetingNotes({
      title: titleFromPrefix(prefix),
      transcriptText,
    });
    const notesMd = String(smart?.notes || "").trim();
    if (!notesMd) return { ok: false, skipped: "notes_generation_failed" };

    const { writeNotesMdForMeetingPrefix } = await import("@/lib/notetaker-persistence.server");
    await writeNotesMdForMeetingPrefix(prefix, notesMd, botId);

    const verified = (await getNotesMdFromS3({ notesKey })).trim();
    if (!verified) return { ok: false, skipped: "notes_s3_write_failed" };

    invalidateNotetakerCalendarS3Cache();
    return { ok: true, notesKey, notesMd: verified };
  } catch (e) {
    return { ok: false, skipped: e instanceof Error ? e.message : "notes_generation_failed" };
  }
}

export type BackfillNotesResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  remainingMissing: number;
  results: Array<{ prefix: string; botId: string | null; ok: boolean; skipped?: string }>;
};

/** Generate notes for every transcript in S3 that lacks notes.md. */
export async function backfillAllMissingNotesFromS3(): Promise<BackfillNotesResult> {
  const { auditNotesCoverageFromS3 } = await import("@/lib/notetaker-s3-calendar.server");
  const report = await auditNotesCoverageFromS3();
  const results: BackfillNotesResult["results"] = [];

  for (const m of report.missingNotes) {
    let r: { ok: boolean; skipped?: string };
    if (m.botId) {
      r = await ensureMeetingNotesInS3(m.botId);
    } else {
      r = await ensureMeetingNotesByPrefix(m.prefix, m.botId ?? undefined);
    }
    results.push({ prefix: m.prefix, botId: m.botId, ok: r.ok, skipped: r.skipped });
  }

  const after = await auditNotesCoverageFromS3();
  return {
    attempted: results.length,
    succeeded: results.filter((x) => x.ok).length,
    failed: results.filter((x) => !x.ok).length,
    remainingMissing: after.missingNotes.length,
    results,
  };
}
