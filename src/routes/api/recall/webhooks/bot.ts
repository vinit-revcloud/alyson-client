import { createFileRoute } from "@tanstack/react-router";
import { verifyRecallCalendarWebhook } from "@/lib/recall/google-calendar-oauth.server";
import {
  handleRecallBotWebhook,
  type RecallBotWebhookPayload,
} from "@/lib/notetaker-meeting-end.server";

/**
 * Recall bot status webhooks (bot.call_ended, bot.done, transcript.done, …).
 * Add this URL in Recall dashboard → Webhooks if bot events should not share the calendar endpoint.
 * Signed with the same workspace secret (RECALL_VERIFICATION_SECRET) as calendar webhooks.
 */
export const Route = createFileRoute("/api/recall/webhooks/bot")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const rawBody = await request.text();
        if (!verifyRecallCalendarWebhook(rawBody, request.headers)) {
          return Response.json({ ok: false, error: "Invalid webhook signature" }, { status: 401 });
        }
        let payload: RecallBotWebhookPayload;
        try {
          payload = JSON.parse(rawBody) as RecallBotWebhookPayload;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }
        try {
          const result = await handleRecallBotWebhook(payload);
          return Response.json({ ok: true, result });
        } catch (e) {
          const message = e instanceof Error ? e.message : "Bot webhook handler failed";
          console.error("[recall-bot-webhook]", message);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
