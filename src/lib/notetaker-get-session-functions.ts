import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type {
  NotetakerSession,
  NotetakerSessionPayload,
  NotetakerTranscriptLine,
} from "@/lib/alyson-notetaker-functions";
import { getPersistedSession, persistSession } from "@/lib/notetaker-datastore.server";
import { autoPersistEndedMeetingToS3 } from "@/lib/notetaker-auto-persist.server";
import { withResolvedMeetingTitle } from "@/lib/notetaker-session-title.server";
import { loadPersistedSessionPayloadFromS3 } from "@/lib/notetaker-sessions-history.server";
import { notetakerUpstream } from "@/lib/notetaker-upstream.server";

const BotIdInput = z.object({ botId: z.string().min(1) });

export type { NotetakerSessionPayload } from "@/lib/alyson-notetaker-functions";

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

async function loadSessionFallback(botId: string): Promise<NotetakerSessionPayload | null> {
  const persisted = await getPersistedSession(botId);
  if (persisted?.transcript?.transcriptText) {
    const lines = linesFromPlainTranscript(persisted.transcript.transcriptText);
    return {
      session: {
        botId: persisted.botId,
        title: persisted.title,
        meetingUrl: persisted.meetingUrl,
        botName: persisted.botName,
        createdAt: persisted.createdAt,
        status: persisted.status,
      },
      lines,
      participantCount: 0,
      startedLabel: persisted.createdAt,
      hasRecallConfig: true,
      hasGroqConfig: true,
      notesMd: persisted.notes?.notesMd ?? null,
      notesModel: persisted.notes?.model,
    };
  }

  const fromS3 = await loadPersistedSessionPayloadFromS3(botId);
  if (fromS3) return fromS3;

  return null;
}

function normalizeSessionPayload(res: unknown, botId: string): NotetakerSessionPayload {
  if (!res || typeof res !== "object") {
    throw new Error(`Notetaker API returned an empty response for bot ${botId}.`);
  }
  const o = res as Partial<NotetakerSessionPayload>;
  if (!o.session?.botId) {
    throw new Error(`Notetaker API response missing session for bot ${botId}.`);
  }
  return {
    session: o.session,
    lines: Array.isArray(o.lines) ? o.lines : [],
    participantCount: Number(o.participantCount ?? 0),
    startedLabel: String(o.startedLabel ?? o.session.createdAt ?? ""),
    hasRecallConfig: Boolean(o.hasRecallConfig ?? true),
    hasGroqConfig: Boolean(o.hasGroqConfig ?? true),
  };
}

/** S3 + local datastore only (when upstream session TTL expired). */
export const loadNotetakerSessionArchive = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => BotIdInput.parse(data))
  .handler(async ({ data }): Promise<NotetakerSessionPayload> => {
    const fallback = await loadSessionFallback(data.botId);
    if (!fallback) {
      throw new Error(`No archived transcript found for bot ${data.botId}.`);
    }
    fallback.persistedInS3 = true;
    return fallback;
  });

/** POST avoids flaky GET input handling in TanStack Start dev. */
export const getNotetakerSession = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => BotIdInput.parse(data))
  .handler(async ({ data }): Promise<NotetakerSessionPayload> => {
    try {
      const res = await notetakerUpstream(`/api/session/${encodeURIComponent(data.botId)}`);
      const typed = normalizeSessionPayload(res, data.botId);

      const needsS3Content =
        typed.lines.length === 0 ||
        ["ended", "completed", "disconnected", "left", "finished", "persisted"].includes(
          String(typed.session?.status || "").toLowerCase(),
        );
      if (needsS3Content) {
        const fromS3 = await loadPersistedSessionPayloadFromS3(data.botId);
        if (fromS3) {
          if (!typed.lines.length && fromS3.lines.length) typed.lines = fromS3.lines;
          if (!typed.notesMd && fromS3.notesMd) {
            typed.notesMd = fromS3.notesMd;
            typed.notesModel = fromS3.notesModel;
          }
          if (fromS3.persistedInS3) typed.persistedInS3 = true;
          typed.participantCount = Math.max(typed.participantCount, fromS3.participantCount);
        }
      }

      const st = String(typed.session?.status || "").toLowerCase();
      const ended = ["ended", "completed", "disconnected", "left", "finished"].includes(st);

      if (typed.session?.botId && typed.lines.length > 0) {
        if (ended) {
          const existing = await getPersistedSession(typed.session.botId);
          if (!existing?.finalizedAt) {
            let notes: { notes: string; model?: string } | null = null;
            try {
              notes = (await notetakerUpstream(`/api/session/${encodeURIComponent(data.botId)}/notes`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt: "" }),
              })) as { notes: string; model?: string };
            } catch {
              // Notes generation can fail; local persistence should still work.
            }
            await persistSession({ session: typed.session, lines: typed.lines ?? [], notes });
            if (notes?.notes) {
              typed.notesMd = notes.notes;
              typed.notesModel = notes.model;
            }
          }
        }

        try {
          const auto = await autoPersistEndedMeetingToS3({
            session: await withResolvedMeetingTitle(typed.session),
            lines: typed.lines,
            existingNotesMd: typed.notesMd,
            existingNotesModel: typed.notesModel,
          });
          if (auto.persisted) {
            typed.autoPersistedToS3 = true;
            typed.persistedInS3 = true;
            typed.session = { ...typed.session, status: "persisted" };
            if (auto.notesMd) {
              typed.notesMd = auto.notesMd;
              typed.notesModel = auto.notesModel;
            }
          } else if (auto.skipped === "already_in_s3") {
            typed.persistedInS3 = true;
            typed.session = { ...typed.session, status: typed.session.status || "persisted" };
          }
        } catch {
          // Session view must still load if S3 auto-persist fails
        }
      }

      return typed;
    } catch (upstreamErr) {
      const fallback = await loadSessionFallback(data.botId);
      if (fallback) return fallback;

      const hint =
        upstreamErr instanceof Error ? upstreamErr.message : "Notetaker API unavailable.";
      throw new Error(
        `${hint} Start the notetaker service (default port 3003) or run npm run dev:ops.`,
      );
    }
  });
