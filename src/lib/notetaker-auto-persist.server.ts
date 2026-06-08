import type { NotetakerSession, NotetakerTranscriptLine } from "@/lib/alyson-notetaker-functions";
import { generateNotetakerNotes } from "@/lib/alyson-notetaker-functions";
import { composeTranscript, contentHash, persistMeetingToS3 } from "@/lib/notetaker-persistence.server";
import { withResolvedMeetingTitle } from "@/lib/notetaker-session-title.server";
import { generateSmartMeetingNotes } from "@/lib/notetaker-smart-notes";
import { loadBotIndexDoc, mergeNotetakerSessions } from "@/lib/notetaker-sessions-history.server";
import { registerScheduledBotInSessionsCatalog } from "@/lib/notetaker-scheduled-catalog.server";
import { getNotetakerSessionsIndexFromS3, putNotetakerSessionsIndexToS3 } from "@/lib/notetaker-sessions-s3.server";

function autoPersistEnabled() {
  return String(process.env.NOTETAKER_AUTO_PERSIST_S3 ?? "true").trim().toLowerCase() !== "false";
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

  try {
    const res = await generateNotetakerNotes({ data: { botId: args.botId, prompt: "" } });
    if (String(res?.notes || "").trim()) {
      return { notesMd: String(res.notes).trim(), model: res.model };
    }
  } catch {
    // fall through to smart notes
  }

  const transcript = composeTranscript(args.lines);
  if (!transcript.transcriptText.trim()) return null;

  try {
    const smart = await generateSmartMeetingNotes({
      data: { title: args.session.title || "Meeting", transcriptText: transcript.transcriptText },
    });
    if (String(smart?.notes || "").trim()) {
      return { notesMd: String(smart.notes).trim(), model: smart.model };
    }
  } catch {
    // notes optional
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
    return "unchanged";
  }

  const prev = checkpointThrottle.get(botId);
  if (
    !options?.bypassThrottle &&
    prev?.hash === hash &&
    Date.now() - prev.at < checkpointMinMs()
  ) {
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

  checkpointThrottle.set(botId, { at: Date.now(), hash });
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

  const notes =
    args.force || args.forceNotes || !existingIndex?.notesKey
      ? await resolveNotesForS3({
          botId,
          session,
          lines: args.lines,
          existingNotesMd: args.existingNotesMd,
          existingNotesModel: args.existingNotesModel,
          forceNotes: args.forceNotes ?? args.force,
        })
      : args.existingNotesMd?.trim()
        ? { notesMd: args.existingNotesMd.trim(), model: args.existingNotesModel || "existing" }
        : null;

  if (!args.force) {
    const notesHash = notes?.notesMd ? contentHash(notes.notesMd) : null;
    const transcriptUnchanged = existingIndex?.transcriptHash === transcriptHash;
    const notesUnchanged = !notes?.notesMd || existingIndex?.notesHash === notesHash;
    if (transcriptUnchanged && notesUnchanged) {
      return { persisted: false, skipped: "unchanged" };
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

  return {
    persisted: true,
    notesMd: notes?.notesMd ?? null,
    notesModel: notes?.model,
  };
}
