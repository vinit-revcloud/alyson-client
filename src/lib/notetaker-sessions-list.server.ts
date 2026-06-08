import type { NotetakerSession } from "@/lib/alyson-notetaker-functions";
import { notetakerTranscriptCronEnabled } from "@/lib/notetaker-cron-auth.server";
import { scheduleNotetakerCatalogMaintenance } from "@/lib/notetaker-session-catalog.server";
import {
  listPersistedSessionsFromS3,
  mergeNotetakerSessions,
} from "@/lib/notetaker-sessions-history.server";
import { listAllUnifiedScheduledBotSessions } from "@/lib/unifiedMeetingsService";
import { notetakerUpstream } from "@/lib/notetaker-upstream.server";

export type NotetakerSessionsListResult = {
  sessions: NotetakerSession[];
  hasRecallConfig: boolean;
  hasGroqConfig: boolean;
};

async function listUnifiedScheduledSessions(): Promise<NotetakerSession[]> {
  const rows = await listAllUnifiedScheduledBotSessions();
  return rows.map((r) => ({
    botId: r.botId,
    title: r.title,
    meetingUrl: r.meetingUrl,
    createdAt: r.createdAt,
    status: r.status,
  }));
}

function sessionsBackgroundSyncEnabled() {
  const explicit = process.env.NOTETAKER_SESSIONS_BACKGROUND_SYNC?.trim().toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  // Cron is the primary dumper — skip UI-driven background sync by default.
  return !notetakerTranscriptCronEnabled();
}

function scheduleBackgroundMaintenance(sessions: NotetakerSession[]) {
  if (!sessionsBackgroundSyncEnabled()) return;
  scheduleNotetakerCatalogMaintenance(sessions);
}

/** Fast path: parallel fetch, no per-session upstream probes, maintenance in background. */
export async function buildNotetakerSessionsList(): Promise<NotetakerSessionsListResult> {
  const source = String(process.env.NOTETAKER_SESSIONS_SOURCE || "").trim().toLowerCase();

  const [unifiedScheduledSessions, s3Sessions] = await Promise.all([
    listUnifiedScheduledSessions(),
    listPersistedSessionsFromS3({ includeBotIndex: true }).catch(() => [] as NotetakerSession[]),
  ]);

  if (source === "s3") {
    const sessions = mergeNotetakerSessions(s3Sessions, unifiedScheduledSessions);
    scheduleBackgroundMaintenance(sessions);
    return { sessions, hasRecallConfig: true, hasGroqConfig: true };
  }

  try {
    const data = (await notetakerUpstream("/api/sessions")) as {
      sessions: NotetakerSession[];
      hasRecallConfig: boolean;
      hasGroqConfig: boolean;
    };

    const sessions = mergeNotetakerSessions(
      data.sessions ?? [],
      unifiedScheduledSessions,
      s3Sessions,
    );
    scheduleBackgroundMaintenance(sessions);

    return {
      sessions,
      hasRecallConfig: Boolean(data.hasRecallConfig),
      hasGroqConfig: Boolean(data.hasGroqConfig),
    };
  } catch {
    const sessions = mergeNotetakerSessions(s3Sessions, unifiedScheduledSessions);
    if (sessions.length) {
      scheduleBackgroundMaintenance(sessions);
      return { sessions, hasRecallConfig: true, hasGroqConfig: true };
    }
    throw new Error(
      `Notetaker API unavailable and no S3/unified sessions found. Check ALYSON_NOTETAKER_BASE_URL.`,
    );
  }
}
