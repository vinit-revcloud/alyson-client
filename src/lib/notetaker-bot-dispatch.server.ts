import {
  patchRecallBotRecordingConfig,
  recallBotRecordingConfig,
  resolveRecallTranscriptWebhookUrl,
} from "@/lib/recall/recall-bot-config.server";
import { recallFetch } from "@/lib/recall/recall-client.server";
import { registerScheduledBotInSessionsCatalog } from "@/lib/notetaker-scheduled-catalog.server";

export type BotDispatchSource = "notetaker_managed" | "direct_recall_fallback";

export type BotSessionLinkArgs = {
  botId: string;
  title: string;
  meetingUrl: string;
  botJoinAt: string;
  metadata?: Record<string, unknown>;
};

function notetakerBaseUrl(): string {
  const raw =
    process.env.ALYSON_NOTETAKER_BASE_URL ||
    process.env.VITE_ALYSON_NOTETAKER_BASE_URL ||
    process.env.TEST_BOTV2_BASE_URL ||
    process.env.VITE_TEST_BOTV2_BASE_URL ||
    "http://localhost:3003";
  return String(raw).replace(/\/$/, "");
}

function recallBotApiUrl(): string {
  const raw = (process.env.RECALL_BASE_URL?.trim() || "https://ap-northeast-1.recall.ai").replace(/\/$/, "");
  const hostBase = raw.replace(/\/api\/v[0-9]+$/i, "");
  return `${hostBase}/api/v1/bot/`;
}

function requireRecallApiKey(): string {
  const key = process.env.RECALL_API_KEY?.trim();
  if (!key) throw new Error("Missing RECALL_API_KEY");
  return key;
}

async function notetakerPost(path: string, body: unknown, timeoutMs = 20_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${notetakerBaseUrl()}${path.startsWith("/") ? "" : "/"}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function notetakerGet(path: string, timeoutMs = 12_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${notetakerBaseUrl()}${path.startsWith("/") ? "" : "/"}${path}`, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * After Recall-direct bot creation, register the session in Notetaker and ensure transcript webhooks.
 * Tries register-bot (adopt existing Recall id), then session wake-up.
 */
export async function linkBotToNotetakerSession(args: BotSessionLinkArgs): Promise<void> {
  const botId = String(args.botId || "").trim();
  if (!botId) return;

  try {
    await patchRecallBotRecordingConfig(botId);
  } catch (e) {
    console.warn(`[notetaker-dispatch] patch recording config for ${botId}:`, e);
  }

  const registerPayload = {
    bot_id: botId,
    botId,
    title: args.title,
    meeting_url: args.meetingUrl,
    join_at: args.botJoinAt,
    metadata: {
      ...(args.metadata ?? {}),
      transcript_webhook_url: resolveRecallTranscriptWebhookUrl(),
    },
  };

  let registered = false;
  try {
    const res = await notetakerPost("/api/register-bot", registerPayload);
    if (res.ok) {
      registered = true;
    } else if (res.status !== 404 && res.status !== 405) {
      const txt = await res.text().catch(() => "");
      console.warn(`[notetaker-dispatch] register-bot ${res.status} for ${botId}: ${txt.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn(`[notetaker-dispatch] register-bot unreachable for ${botId}:`, e);
  }

  if (!registered) {
    try {
      const res = await notetakerGet(`/api/session/${encodeURIComponent(botId)}`);
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.warn(`[notetaker-dispatch] session wake ${res.status} for ${botId}: ${txt.slice(0, 200)}`);
      }
    } catch (e) {
      console.warn(`[notetaker-dispatch] session wake failed for ${botId}:`, e);
    }
  }

  await registerScheduledBotInSessionsCatalog({
    botId,
    title: args.title,
    meetingUrl: args.meetingUrl,
    createdAt: new Date().toISOString(),
    status: "scheduled",
  });
}

/** Re-apply transcript webhooks + Notetaker session for an already-scheduled bot. */
export async function ensureBotTranscriptPipeline(args: BotSessionLinkArgs): Promise<void> {
  await linkBotToNotetakerSession(args);
}

/** Preferred path: Notetaker service (live transcripts + session catalog). Supports join_at for future joins. */
async function createViaNotetaker(args: {
  meetingUrl: string;
  botJoinAt: string;
  title: string;
  botName: string;
  metadata: Record<string, unknown>;
}): Promise<{ botId: string }> {
  const res = await notetakerPost("/api/create-bot", {
    meeting_url: args.meetingUrl,
    bot_name: args.botName,
    title: args.title,
    join_at: args.botJoinAt,
    metadata: args.metadata,
    ...recallBotRecordingConfig(),
  });

  const txt = await res.text();
  let body: unknown = null;
  try {
    body = txt ? JSON.parse(txt) : null;
  } catch {
    body = txt;
  }
  if (!res.ok) {
    const msg =
      (body && typeof body === "object" && ((body as { error?: string }).error || (body as { message?: string }).message)) ||
      `Notetaker create bot failed (${res.status})`;
    throw new Error(String(msg));
  }
  const botId = String(
    (body as { botId?: string; id?: string; bot_id?: string })?.botId ||
      (body as { id?: string })?.id ||
      (body as { bot_id?: string })?.bot_id ||
      "",
  );
  if (!botId) throw new Error("Notetaker create bot succeeded but bot id was missing");
  return { botId };
}

/** Fallback: direct Recall API with explicit transcript webhook config. */
async function createViaRecallDirect(args: {
  meetingUrl: string;
  botJoinAt: string;
  botName: string;
  metadata: Record<string, unknown>;
}): Promise<{ botId: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const res = await fetch(recallBotApiUrl(), {
    method: "POST",
    headers: {
      Authorization: `Token ${requireRecallApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      meeting_url: args.meetingUrl,
      bot_name: args.botName,
      join_at: args.botJoinAt,
      ...recallBotRecordingConfig(),
      metadata: args.metadata,
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  const txt = await res.text();
  let body: unknown = null;
  try {
    body = txt ? JSON.parse(txt) : null;
  } catch {
    body = txt;
  }
  if (!res.ok) {
    const detail = (body as { detail?: unknown })?.detail;
    const msg =
      (typeof detail === "string" ? detail : detail != null ? JSON.stringify(detail) : "") ||
      (body as { message?: string })?.message ||
      `Recall create bot failed (${res.status})`;
    throw new Error(String(msg));
  }
  const botId = String((body as { id?: string; bot_id?: string })?.id || (body as { bot_id?: string })?.bot_id || "");
  if (!botId) throw new Error("Recall bot creation succeeded but bot id was missing");
  return { botId };
}

/** Cancel a previously scheduled Recall bot before re-dispatching (avoids duplicate joins). */
export async function cancelScheduledRecallBot(botId: string): Promise<void> {
  const id = String(botId || "").trim();
  if (!id) return;
  try {
    await recallFetch(`/api/v1/bot/${encodeURIComponent(id)}/`, { method: "DELETE", timeoutMs: 15_000 });
  } catch {
    // Bot may have already joined, ended, or been removed.
  }
}

/**
 * Create a Recall bot with live transcript pipeline.
 * Always prefers Notetaker `/api/create-bot` (including future join_at) so sessions + webhooks register correctly.
 */
export async function dispatchBotWithLiveTranscripts(args: {
  meetingUrl: string;
  botJoinAt: string;
  title: string;
  metadata: Record<string, unknown>;
  joinOffsetMinutes?: number;
  /** @deprecated Ignored — Notetaker is always tried first for scheduled and immediate joins. */
  preferScheduledJoin?: boolean;
}): Promise<{ botId: string; creationSource: BotDispatchSource }> {
  const botName = process.env.BOT_NAME?.trim() || "Alyson Notetaker";
  const metadata = {
    ...args.metadata,
    bot_join_offset_minutes: args.joinOffsetMinutes ?? 2,
    scheduled_join_at: args.botJoinAt,
    transcript_webhook_url: resolveRecallTranscriptWebhookUrl(),
  };

  const sessionLink: BotSessionLinkArgs = {
    botId: "",
    title: args.title,
    meetingUrl: args.meetingUrl,
    botJoinAt: args.botJoinAt,
    metadata,
  };

  const recallDispatch = async () => {
    const { botId } = await createViaRecallDirect({
      meetingUrl: args.meetingUrl,
      botJoinAt: args.botJoinAt,
      botName,
      metadata,
    });
    await linkBotToNotetakerSession({ ...sessionLink, botId });
    return { botId, creationSource: "direct_recall_fallback" as const };
  };

  const notetakerDispatch = async () => {
    const { botId } = await createViaNotetaker({
      meetingUrl: args.meetingUrl,
      botJoinAt: args.botJoinAt,
      title: args.title,
      botName,
      metadata,
    });
    await registerScheduledBotInSessionsCatalog({
      botId,
      title: args.title,
      meetingUrl: args.meetingUrl,
      createdAt: new Date().toISOString(),
      status: "scheduled",
    });
    return { botId, creationSource: "notetaker_managed" as const };
  };

  try {
    return await notetakerDispatch();
  } catch (notetakerErr) {
    try {
      return await recallDispatch();
    } catch (recallErr) {
      const nt = notetakerErr instanceof Error ? notetakerErr.message : String(notetakerErr);
      const rc = recallErr instanceof Error ? recallErr.message : String(recallErr);
      throw new Error(`Notetaker: ${nt}; Recall fallback: ${rc}`);
    }
  }
}
