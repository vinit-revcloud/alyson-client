/** Default Recall bot settings (no join_at — forbidden in Calendar V1 dashboard template). */
export function recallBotRecordingConfig() {
  const base =
    process.env.PUBLIC_WEBHOOK_BASE_URL?.trim() ||
    process.env.ALYSON_NOTETAKER_BASE_URL?.trim() ||
    "https://api-uic1.onrender.com";
  const webhookBase = base.replace(/\/$/, "");
  const transcriptWebhookUrl =
    process.env.RECALL_TRANSCRIPT_WEBHOOK_URL?.trim() || `${webhookBase}/webhooks/recall`;
  const language = process.env.TRANSCRIPT_LANGUAGE?.trim() || "en";

  return {
    recording_config: {
      transcript: {
        provider: {
          recallai_streaming: {
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
