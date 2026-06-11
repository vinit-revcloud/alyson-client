import { recallBotRecordingConfig } from "@/lib/recall/recall-bot-config.server";
import { recallFetch } from "@/lib/recall/recall-client.server";

export type BotDispatchSource = "notetaker_managed" | "direct_recall_fallback";

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

/** Future scheduled joins must use Recall direct — Notetaker create-bot often joins immediately. */
const FUTURE_SCHEDULE_THRESHOLD_MS = 90 * 1000;

function isFutureScheduledJoin(botJoinAt: string): boolean {
  const joinMs = new Date(botJoinAt).getTime();
  return Number.isFinite(joinMs) && joinMs > Date.now() + FUTURE_SCHEDULE_THRESHOLD_MS;
}

/** Pre-create Notetaker in-memory session so webhooks/SSE work after Recall-direct dispatch. */
async function warmNotetakerSession(botId: string): Promise<void> {
  const id = String(botId || "").trim();
  if (!id) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    await fetch(`${notetakerBaseUrl()}/api/session/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    });
  } catch {
    // Non-fatal — session is created on first UI poll if this fails.
  } finally {
    clearTimeout(timeout);
  }
}

/** Preferred path: Notetaker service (live transcripts + session catalog). */
async function createViaNotetaker(args: {
  meetingUrl: string;
  botJoinAt: string;
  title: string;
  botName: string;
  metadata: Record<string, unknown>;
}): Promise<{ botId: string }> {
  const url = `${notetakerBaseUrl()}/api/create-bot`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      meeting_url: args.meetingUrl,
      bot_name: args.botName,
      title: args.title,
      join_at: args.botJoinAt,
      metadata: args.metadata,
      ...recallBotRecordingConfig(),
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
    const msg =
      (body && typeof body === "object" && ((body as { error?: string }).error || (body as { message?: string }).message)) ||
      `Notetaker create bot failed (${res.status})`;
    throw new Error(String(msg));
  }
  const botId = String((body as { botId?: string; id?: string; bot_id?: string })?.botId || (body as { id?: string })?.id || (body as { bot_id?: string })?.bot_id || "");
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
 * Create a Recall bot through Notetaker (live transcripts) with direct Recall fallback.
 * Used by Unified Meetings manual schedule and Recall Calendar smart schedule.
 */
export async function dispatchBotWithLiveTranscripts(args: {
  meetingUrl: string;
  botJoinAt: string;
  title: string;
  metadata: Record<string, unknown>;
  joinOffsetMinutes?: number;
  /** @deprecated Notetaker is always preferred — kept for call-site compatibility. */
  preferScheduledJoin?: boolean;
}): Promise<{ botId: string; creationSource: BotDispatchSource }> {
  const botName = process.env.BOT_NAME?.trim() || "Alyson Notetaker";
  const metadata = {
    ...args.metadata,
    bot_join_offset_minutes: args.joinOffsetMinutes ?? 2,
    scheduled_join_at: args.botJoinAt,
  };

  const recallDispatch = async () => {
    const { botId } = await createViaRecallDirect({
      meetingUrl: args.meetingUrl,
      botJoinAt: args.botJoinAt,
      botName,
      metadata,
    });
    await warmNotetakerSession(botId);
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
    return { botId, creationSource: "notetaker_managed" as const };
  };

  const recallFirst = Boolean(args.preferScheduledJoin || isFutureScheduledJoin(args.botJoinAt));

  if (recallFirst) {
    try {
      return await recallDispatch();
    } catch (recallErr) {
      try {
        return await notetakerDispatch();
      } catch (notetakerErr) {
        const rc = recallErr instanceof Error ? recallErr.message : String(recallErr);
        const nt = notetakerErr instanceof Error ? notetakerErr.message : String(notetakerErr);
        throw new Error(`Recall scheduled join: ${rc}; Notetaker fallback: ${nt}`);
      }
    }
  }

  // Immediate join: Notetaker first (registers live transcript session), Recall fallback.
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
