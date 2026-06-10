import { resolveRecallTranscriptWebhookUrl } from "@/lib/recall/recall-bot-config.server";
import { notetakerBaseUrl, notetakerUpstream } from "@/lib/notetaker-upstream.server";

export type NotetakerLiveDiagnostics = {
  botId: string;
  notetakerBaseUrl: string;
  sseUrl: string;
  transcriptWebhookUrl: string;
  upstream: {
    reachable: boolean;
    status?: string;
    lineCount: number;
    participantCount: number;
    hasRecallConfig: boolean;
    error?: string;
  };
  hints: string[];
};

export async function buildNotetakerLiveDiagnostics(botId: string): Promise<NotetakerLiveDiagnostics> {
  const base = notetakerBaseUrl();
  const transcriptWebhookUrl = resolveRecallTranscriptWebhookUrl();
  const hints: string[] = [];

  if (transcriptWebhookUrl.includes("vercel.app") || transcriptWebhookUrl.includes("alyson-client")) {
    hints.push(
      "Transcript webhook URL points at the Alyson HR app — Recall must POST to the Notetaker service. Set PUBLIC_WEBHOOK_BASE_URL or RECALL_TRANSCRIPT_WEBHOOK_URL to your Notetaker host.",
    );
  }

  let upstream: NotetakerLiveDiagnostics["upstream"] = {
    reachable: false,
    lineCount: 0,
    participantCount: 0,
    hasRecallConfig: false,
  };

  try {
    const res = (await notetakerUpstream(`/api/session/${encodeURIComponent(botId)}`)) as {
      session?: { status?: string };
      lines?: unknown[];
      participantCount?: number;
      hasRecallConfig?: boolean;
    };
    const lineCount = Array.isArray(res?.lines) ? res.lines.length : 0;
    const status = String(res?.session?.status || "").toLowerCase();
    upstream = {
      reachable: true,
      status,
      lineCount,
      participantCount: Number(res?.participantCount ?? 0),
      hasRecallConfig: Boolean(res?.hasRecallConfig ?? true),
    };

    const inCall = ["recording", "in_call", "in_call_recording", "joined"].includes(status);
    if (inCall && lineCount === 0) {
      hints.push(
        "Bot is in the meeting but no transcript lines reached Notetaker yet. Usually the Recall bot was scheduled without recording_config / transcript webhooks. Re-sync the calendar event (Unified Meetings → Sync now) or create the bot via Notetaker Create.",
      );
      hints.push(
        `Confirm Recall sends transcript.data to: ${transcriptWebhookUrl}`,
      );
      hints.push(
        "Someone must be speaking in the meeting — silence produces no lines. Captions/language should match TRANSCRIPT_LANGUAGE (default en).",
      );
    }
    if (!upstream.hasRecallConfig) {
      hints.push("Notetaker reports Recall is not configured on the backend (RECALL_API_KEY missing on Render).");
    }
  } catch (e) {
    upstream = {
      reachable: false,
      lineCount: 0,
      participantCount: 0,
      hasRecallConfig: false,
      error: e instanceof Error ? e.message : String(e),
    };
    hints.push(
      `Cannot reach Notetaker API at ${base}. Set ALYSON_NOTETAKER_BASE_URL and VITE_ALYSON_NOTETAKER_BASE_URL to the same public URL.`,
    );
  }

  return {
    botId,
    notetakerBaseUrl: base,
    sseUrl: `${base}/session/${encodeURIComponent(botId)}/events`,
    transcriptWebhookUrl,
    upstream,
    hints,
  };
}
