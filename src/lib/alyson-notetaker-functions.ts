import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { persistSession } from "@/lib/notetaker-datastore.server";
import { buildNotetakerSessionsList } from "@/lib/notetaker-sessions-list.server";
import { notetakerUpstream } from "@/lib/notetaker-upstream.server";

const BotIdInput = z.object({ botId: z.string().min(1) });
const CreateBotInput = z.object({
  meeting_url: z.string().min(1),
  bot_name: z.string().min(1),
  title: z.string().optional(),
  // Optional: JPEG base64 (no data: prefix) to show as bot video tile.
  avatar_jpeg_b64: z.string().min(1).max(1_835_008).optional(),
});
const NotesInput = z.object({ botId: z.string().min(1), prompt: z.string().optional() });

async function upstream(path: string, init?: RequestInit) {
  return notetakerUpstream(path, init);
}

export type NotetakerSession = {
  botId: string;
  title: string;
  meetingUrl?: string;
  botName?: string;
  createdAt: string;
  status?: string;
};

export type NotetakerTranscriptLine = {
  received_at: string;
  event: string;
  text?: string;
  participant?: { id?: string; name?: string } | null;
  initials?: string;
  clock?: string;
};

export type NotetakerSessionPayload = {
  session: NotetakerSession;
  lines: NotetakerTranscriptLine[];
  participantCount: number;
  startedLabel: string;
  hasRecallConfig: boolean;
  hasGroqConfig: boolean;
  notesMd?: string | null;
  notesModel?: string;
  persistedInS3?: boolean;
  /** Set when this request auto-wrote the meeting to S3 */
  autoPersistedToS3?: boolean;
};

export const listNotetakerSessions = createServerFn({ method: "GET" }).handler(async () => {
  return buildNotetakerSessionsList();
});

export { getNotetakerSession } from "@/lib/notetaker-get-session-functions";

export const finalizeNotetakerSession = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => BotIdInput.parse(data))
  .handler(async ({ data }) => {
    const res = (await upstream(`/api/session/${encodeURIComponent(data.botId)}`)) as {
      session: NotetakerSession;
      lines: NotetakerTranscriptLine[];
    };
    let notes: { notes: string; model?: string } | null = null;
    try {
      notes = (await upstream(`/api/session/${encodeURIComponent(data.botId)}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "" }),
      })) as any;
    } catch {
      // ignore
    }
    const persisted = await persistSession({ session: res.session, lines: res.lines ?? [], notes });
    return { persisted };
  });

export const createNotetakerRecallBot = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => CreateBotInput.parse(data))
  .handler(async ({ data }) => {
    const payload: any = { meeting_url: data.meeting_url, bot_name: data.bot_name, title: data.title ?? "Live meeting" };
    if (data.avatar_jpeg_b64) {
      payload.automatic_video_output = {
        in_call_recording: { kind: "jpeg", b64_data: data.avatar_jpeg_b64 },
        in_call_not_recording: { kind: "jpeg", b64_data: data.avatar_jpeg_b64 },
      };
    }
    const res = (await upstream("/api/create-bot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })) as { botId?: string; id?: string };

    const botId = String(res?.botId || res?.id || "").trim();
    if (botId) {
      const { registerScheduledBotInSessionsCatalog } = await import("@/lib/notetaker-scheduled-catalog.server");
      await registerScheduledBotInSessionsCatalog({
        botId,
        title: data.title?.trim() || "Live meeting",
        meetingUrl: data.meeting_url,
        createdAt: new Date().toISOString(),
        status: "scheduled",
      });
    }

    return res;
  });

export const generateNotetakerNotes = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => NotesInput.parse(data))
  .handler(async ({ data }) => {
    const res = await upstream(`/api/session/${encodeURIComponent(data.botId)}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: data.prompt ?? "" }),
    });
    return res as { notes: string; model: string };
  });

