import type { NotetakerSession } from "@/lib/alyson-notetaker-functions";

const GENERIC_MEETING_TITLES = new Set([
  "meeting",
  "live meeting",
  "live unified meeting",
  "scheduled meeting",
  "unified meeting",
  "untitled meeting",
]);

/** Strip unified-scheduler date prefix (DDMMYYYY) before comparing titles. */
function normalizeTitleForCompare(title: string) {
  return String(title || "")
    .trim()
    .toLowerCase()
    .replace(/^\d{8}\s+/, "");
}

export function isGenericMeetingTitle(title: string | undefined | null): boolean {
  const t = normalizeTitleForCompare(String(title || ""));
  return !t || GENERIC_MEETING_TITLES.has(t);
}

/**
 * Prefer calendar / catalog titles over upstream defaults ("Meeting", "Live meeting").
 */
export async function resolveMeetingTitle(args: {
  botId: string;
  title?: string | null;
}): Promise<string> {
  const botId = String(args.botId || "").trim();
  const incoming = String(args.title || "").trim();

  if (incoming && !isGenericMeetingTitle(incoming)) return incoming;
  if (!botId) return incoming || "Meeting";

  try {
    const { listAllUnifiedScheduledBotSessions } = await import("@/lib/unifiedMeetingsService");
    const row = (await listAllUnifiedScheduledBotSessions()).find((s) => s.botId === botId);
    if (row?.title && !isGenericMeetingTitle(row.title)) return row.title.trim();
  } catch {
    // unified state may be unavailable
  }

  try {
    const { getNotetakerSessionsIndexFromS3 } = await import("@/lib/notetaker-sessions-s3.server");
    const idx = await getNotetakerSessionsIndexFromS3();
    const row = (idx.sessions ?? []).find((s) => String(s.botId) === botId);
    if (row?.title && !isGenericMeetingTitle(row.title)) return row.title.trim();
  } catch {
    // index may not exist yet
  }

  return incoming || "Meeting";
}

export async function withResolvedMeetingTitle(session: NotetakerSession): Promise<NotetakerSession> {
  const botId = String(session.botId || "").trim();
  if (!botId) return session;
  const title = await resolveMeetingTitle({ botId, title: session.title });
  if (title === session.title) return session;
  return { ...session, title };
}
