import type {
  NotetakerSession,
  NotetakerSessionPayload,
} from "@/lib/alyson-notetaker-functions";
import { autoPersistEndedMeetingToS3, maybeCheckpointTranscriptToS3 } from "@/lib/notetaker-auto-persist.server";
import { withResolvedMeetingTitle } from "@/lib/notetaker-session-title.server";
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

function catalogMaintenanceMinMs() {
  const n = Number(process.env.NOTETAKER_CATALOG_MAINTENANCE_MIN_MS || 30_000);
  return Number.isFinite(n) && n >= 10_000 ? Math.min(n, 120_000) : 30_000;
}

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
  if (now - lastCatalogMaintenanceAt < catalogMaintenanceMinMs()) return;
  lastCatalogMaintenanceAt = now;
  void maintainNotetakerSessionsCatalog(sessions).catch(() => {});
}

export async function autoPersistDiscoverableSessions(sessions: NotetakerSession[]) {
  const candidates = sessions.filter((s) => Boolean(String(s.botId || "").trim()));

  await Promise.allSettled(
    candidates.map(async (s) => {
      const botId = String(s.botId || "").trim();
      const st = String(s.status || "").toLowerCase();
      const ended = ENDED_SESSION_STATUSES.has(st);
      try {
        const res = await notetakerUpstream(`/api/session/${encodeURIComponent(botId)}`);
        const payload = normalizeSessionPayload(res, botId);
        if (!payload?.lines?.length) return;
        if (ended) {
          await autoPersistEndedMeetingToS3({
            session: await withResolvedMeetingTitle(payload.session),
            lines: payload.lines,
          });
        } else {
          await maybeCheckpointTranscriptToS3(
            await withResolvedMeetingTitle(payload.session),
            payload.lines,
          );
        }
      } catch {
        // upstream may have already evicted the session
      }
    }),
  );
}
