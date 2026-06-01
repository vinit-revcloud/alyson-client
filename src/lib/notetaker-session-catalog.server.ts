import type {
  NotetakerSession,
  NotetakerSessionPayload,
} from "@/lib/alyson-notetaker-functions";
import { autoPersistEndedMeetingToS3 } from "@/lib/notetaker-auto-persist.server";
import { isMeetingPersistedInS3 } from "@/lib/notetaker-sessions-history.server";
import { notetakerUpstream } from "@/lib/notetaker-upstream.server";
import { listAllUnifiedScheduledBotSessions } from "@/lib/unifiedMeetingsService";

export const ENDED_SESSION_STATUSES = new Set([
  "ended",
  "completed",
  "disconnected",
  "left",
  "finished",
  "persisted",
]);

function normalizeSessionPayload(res: unknown, botId: string): NotetakerSessionPayload | null {
  if (!res || typeof res !== "object") return null;
  const o = res as Partial<NotetakerSessionPayload>;
  if (!o.session?.botId) return null;
  return {
    session: o.session,
    lines: Array.isArray(o.lines) ? o.lines : [],
    participantCount: Number(o.participantCount ?? 0),
    startedLabel: String(o.startedLabel ?? o.session.createdAt ?? ""),
    hasRecallConfig: Boolean(o.hasRecallConfig ?? true),
    hasGroqConfig: Boolean(o.hasGroqConfig ?? true),
    notesMd: o.notesMd,
    notesModel: o.notesModel,
  };
}

/**
 * When the sessions list loads, persist any ended meetings that still exist upstream
 * but are not yet in S3 (upstream TTL often drops them before the user re-opens the session).
 */
/** Persist transcripts for unified-scheduled bots once their meeting window has passed. */
export async function autoPersistUnifiedScheduledBots() {
  const rows = await listAllUnifiedScheduledBotSessions();

  await Promise.allSettled(
    rows.map(async (row) => {
      const botId = row.botId;
      try {
        if (await isMeetingPersistedInS3(botId)) return;
      } catch {
        // continue
      }

      try {
        const res = await notetakerUpstream(`/api/session/${encodeURIComponent(botId)}`);
        const payload = normalizeSessionPayload(res, botId);
        if (!payload?.lines?.length) return;

        await autoPersistEndedMeetingToS3({
          session: {
            botId,
            title: payload.session.title || row.title,
            meetingUrl: payload.session.meetingUrl || row.meetingUrl,
            createdAt: payload.session.createdAt || row.createdAt,
            status: payload.session.status || "ended",
          },
          lines: payload.lines,
        });
      } catch {
        // notetaker may not have this bot (e.g. direct Recall fallback) until transcript exists elsewhere
      }
    }),
  );
}

let lastCatalogMaintenanceAt = 0;
const CATALOG_MAINTENANCE_MIN_MS = 60_000;

/** S3 persist + index merge (slow). Runs in background after fast session list returns. */
export async function maintainNotetakerSessionsCatalog(sessions: NotetakerSession[]) {
  await autoPersistDiscoverableSessions(sessions);
  await autoPersistUnifiedScheduledBots();
  const { mergeSessionsIndexToS3, invalidatePersistedSessionsS3Cache } = await import(
    "@/lib/notetaker-sessions-history.server",
  );
  await mergeSessionsIndexToS3(sessions);
  invalidatePersistedSessionsS3Cache();
}

export function scheduleNotetakerCatalogMaintenance(sessions: NotetakerSession[]) {
  const now = Date.now();
  if (now - lastCatalogMaintenanceAt < CATALOG_MAINTENANCE_MIN_MS) return;
  lastCatalogMaintenanceAt = now;
  void maintainNotetakerSessionsCatalog(sessions).catch(() => {});
}

export async function autoPersistDiscoverableSessions(sessions: NotetakerSession[]) {
  const candidates = sessions.filter((s) => {
    const botId = String(s.botId || "").trim();
    if (!botId) return false;
    const st = String(s.status || "").toLowerCase();
    if (st === "persisted") return false;
    return ENDED_SESSION_STATUSES.has(st);
  });

  await Promise.allSettled(
    candidates.map(async (s) => {
      const botId = String(s.botId || "").trim();
      try {
        if (await isMeetingPersistedInS3(botId)) return;
      } catch {
        // proceed if S3 check fails
      }
      try {
        const res = await notetakerUpstream(`/api/session/${encodeURIComponent(botId)}`);
        const payload = normalizeSessionPayload(res, botId);
        if (!payload?.lines?.length) return;
        await autoPersistEndedMeetingToS3({
          session: payload.session,
          lines: payload.lines,
        });
      } catch {
        // upstream may have already evicted the session
      }
    }),
  );
}
