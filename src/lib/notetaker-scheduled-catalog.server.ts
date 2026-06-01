import type { NotetakerSession } from "@/lib/alyson-notetaker-functions";
import {
  invalidatePersistedSessionsS3Cache,
  mergeSessionsIndexToS3,
} from "@/lib/notetaker-sessions-history.server";

/** Register a newly scheduled bot in the durable S3 session catalog immediately. */
export async function registerScheduledBotInSessionsCatalog(session: NotetakerSession) {
  const botId = String(session.botId || "").trim();
  if (!botId) return;
  try {
    await mergeSessionsIndexToS3([
      {
        botId,
        title: session.title || "Scheduled meeting",
        meetingUrl: session.meetingUrl,
        createdAt: session.createdAt || new Date().toISOString(),
        status: session.status || "scheduled",
      },
    ]);
    invalidatePersistedSessionsS3Cache();
  } catch {
    // scheduling still succeeded; list refresh may pick up from state file
  }
}
