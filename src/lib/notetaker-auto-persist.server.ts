import type { NotetakerSession, NotetakerTranscriptLine } from "@/lib/alyson-notetaker-functions";
import { generateNotetakerNotes } from "@/lib/alyson-notetaker-functions";
import { composeTranscript, persistMeetingToS3 } from "@/lib/notetaker-persistence.server";
import { generateSmartMeetingNotes } from "@/lib/notetaker-smart-notes";
import {
  isMeetingPersistedInS3,
  mergeNotetakerSessions,
} from "@/lib/notetaker-sessions-history.server";
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

  if (!args.force) {
    try {
      if (await isMeetingPersistedInS3(botId)) {
        return { persisted: false, skipped: "already_in_s3" };
      }
    } catch {
      // proceed if S3 check fails (e.g. creds) — manual persist still available
    }
  }

  const notes = await resolveNotesForS3({
    botId,
    session: args.session,
    lines: args.lines,
    existingNotesMd: args.existingNotesMd,
    existingNotesModel: args.existingNotesModel,
    forceNotes: args.forceNotes ?? args.force,
  });

  await persistMeetingToS3({
    session: args.session,
    lines: args.lines,
    notes: notes ? { notesMd: notes.notesMd, model: notes.model } : null,
  });

  try {
    await appendSessionToS3Index({
      ...args.session,
      status: "persisted",
    });
  } catch {
    // transcript/notes saved; index update is best-effort
  }

  return {
    persisted: true,
    notesMd: notes?.notesMd ?? null,
    notesModel: notes?.model,
  };
}
