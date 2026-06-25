import { recallFetch } from "@/lib/recall/recall-client.server";

/** Delete Recall-side media 1 day after S3 persist (inside Recall's 7-day free retention). */
export const RECALL_MEDIA_DELETE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Permanently delete all recording media Recall stores for a bot.
 * @see https://docs.recall.ai/reference/bot_delete_media_create
 */
export async function deleteRecallBotMedia(botId: string): Promise<{ ok: boolean; skipped?: string }> {
  const id = String(botId || "").trim();
  if (!id) return { ok: false, skipped: "missing_bot_id" };
  if (!process.env.RECALL_API_KEY?.trim()) return { ok: false, skipped: "recall_not_configured" };

  try {
    await recallFetch(`/api/v1/bot/${encodeURIComponent(id)}/delete_media/`, {
      method: "POST",
      timeoutMs: 30_000,
    });
    return { ok: true };
  } catch (e) {
    const status = (e as { status?: number })?.status;
    if (status === 400) return { ok: false, skipped: "bot_in_progress" };
    if (status === 409) return { ok: false, skipped: "delete_in_progress" };
    if (status === 404) return { ok: true, skipped: "bot_not_found" };
    throw e;
  }
}
