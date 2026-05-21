import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { persistSession } from "@/lib/notetaker-datastore.server";
import {
  listPersistedSessionsFromS3,
  mergeNotetakerSessions,
} from "@/lib/notetaker-sessions-history.server";
import { putNotetakerSessionsIndexToS3 } from "@/lib/notetaker-sessions-s3.server";

const BotIdInput = z.object({ botId: z.string().min(1) });
const CreateBotInput = z.object({
  meeting_url: z.string().min(1),
  bot_name: z.string().min(1),
  title: z.string().optional(),
  // Optional: JPEG base64 (no data: prefix) to show as bot video tile.
  avatar_jpeg_b64: z.string().min(1).max(1_835_008).optional(),
});
const NotesInput = z.object({ botId: z.string().min(1), prompt: z.string().optional() });

function baseUrl() {
  const raw =
    process.env.ALYSON_NOTETAKER_BASE_URL ||
    process.env.VITE_ALYSON_NOTETAKER_BASE_URL ||
    // backward compat
    process.env.TEST_BOTV2_BASE_URL ||
    process.env.VITE_TEST_BOTV2_BASE_URL ||
    "http://localhost:3003";
  return String(raw).replace(/\/$/, "");
}

async function upstream(path: string, init?: RequestInit) {
  const url = `${baseUrl()}${path.startsWith("/") ? "" : "/"}${path}`;
  const r = await fetch(url, init);
  const contentType = r.headers.get("content-type") || "";
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  if (contentType.includes("text/html") || (text && text.trim().startsWith("<!DOCTYPE html"))) {
    throw new Error(
      `Notetaker API returned HTML (wrong base URL or server not running). ` +
        `Check ALYSON_NOTETAKER_BASE_URL/VITE_ALYSON_NOTETAKER_BASE_URL (currently: ${baseUrl()}).`,
    );
  }
  if (!r.ok) {
    const msg = json?.error ? String(json.error) : text || `Request failed (${r.status})`;
    throw new Error(msg);
  }
  return json;
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
  const source = String(process.env.NOTETAKER_SESSIONS_SOURCE || "").trim().toLowerCase();

  let s3Sessions: NotetakerSession[] = [];
  try {
    s3Sessions = await listPersistedSessionsFromS3();
  } catch {
    // S3 optional when credentials missing
  }

  // S3-only mode (for deployments that don't want to depend on upstream availability)
  if (source === "s3") {
    return {
      sessions: s3Sessions,
      hasRecallConfig: true,
      hasGroqConfig: true,
    };
  }

  try {
    const data = (await upstream("/api/sessions")) as {
      sessions: NotetakerSession[];
      hasRecallConfig: boolean;
      hasGroqConfig: boolean;
    };

    const merged = mergeNotetakerSessions(data.sessions ?? [], s3Sessions);

    // Best-effort: persist merged catalog so history stays in sync.
    try {
      await putNotetakerSessionsIndexToS3({ sessions: merged });
    } catch {
      // ignore S3 failures for the live sessions call
    }

    return { ...data, sessions: merged };
  } catch (e) {
    if (s3Sessions.length > 0) {
      return {
        sessions: s3Sessions,
        hasRecallConfig: true,
        hasGroqConfig: true,
      };
    }
    throw e;
  }
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
    const res = await upstream("/api/create-bot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
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

