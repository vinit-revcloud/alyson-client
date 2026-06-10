function looksLikeNotetakerHost(url: string): boolean {
  const u = url.toLowerCase();
  if (u.includes("localhost") || u.includes("127.0.0.1")) return true;
  if (u.includes("onrender.com") || u.includes("notetaker")) return true;
  // Alyson HR client hosts must not receive Recall transcript webhooks.
  if (u.includes("vercel.app") || u.includes("alyson-client")) return false;
  return true;
}

/** Public URL Recall uses for transcript.data / transcript.partial_data webhooks. */
export function resolveRecallTranscriptWebhookUrl(): string {
  const explicit = process.env.RECALL_TRANSCRIPT_WEBHOOK_URL?.trim();
  if (explicit) return explicit;

  const publicBase = process.env.PUBLIC_WEBHOOK_BASE_URL?.trim();
  if (publicBase) return `${publicBase.replace(/\/$/, "")}/webhooks/recall`;

  const notetakerBase = process.env.ALYSON_NOTETAKER_BASE_URL?.trim();
  if (notetakerBase && looksLikeNotetakerHost(notetakerBase)) {
    return `${notetakerBase.replace(/\/$/, "")}/webhooks/recall`;
  }

  return "https://api-uic1.onrender.com/webhooks/recall";
}

/** Default Recall bot settings (no join_at — forbidden in Calendar V1 dashboard template). */
export function recallBotRecordingConfig() {
  const transcriptWebhookUrl = resolveRecallTranscriptWebhookUrl();
  const language = process.env.TRANSCRIPT_LANGUAGE?.trim() || "en";

  return {
    recording_config: {
      transcript: {
        provider: {
          recallai_streaming: {
            mode: "prioritize_low_latency",
            language_code: language,
          },
        },
      },
      realtime_endpoints: [
        {
          type: "webhook",
          url: transcriptWebhookUrl,
          events: ["transcript.data", "transcript.partial_data"],
        },
      ],
    },
    automatic_leave: {
      waiting_room_timeout: 1200,
      noone_joined_timeout: 1200,
      everyone_left_timeout: 2,
    },
  };
}

/** JSON for Recall dashboard → Calendar V1 Bot Configuration (Bot Config field only). */
export function recallCalendarV1DashboardBotConfigJson(): string {
  return JSON.stringify(
    {
      ...recallBotRecordingConfig(),
      metadata: {
        source: "alyson_calendar",
      },
    },
    null,
    2,
  );
}
