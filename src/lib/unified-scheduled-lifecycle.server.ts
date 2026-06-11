import {
  readUnifiedScheduledStateFromS3,
  unifiedScheduledStateUsesS3,
  writeUnifiedScheduledStateToS3,
  type UnifiedScheduledStateEntry,
} from "@/lib/unified-scheduled-s3.server";

export type UnifiedScheduledLifecycleStatus =
  | "scheduled"
  | "dispatched"
  | "joining"
  | "in_call"
  | "done"
  | "failed"
  | "no_transcript";

const TERMINAL: ReadonlySet<UnifiedScheduledLifecycleStatus> = new Set([
  "done",
  "failed",
  "no_transcript",
]);

const STATUS_RANK: Record<UnifiedScheduledLifecycleStatus, number> = {
  scheduled: 0,
  dispatched: 1,
  joining: 2,
  in_call: 3,
  done: 4,
  failed: 4,
  no_transcript: 4,
};

/** Map Notetaker / Recall upstream session status → unified-scheduled S3 status. */
export function mapUpstreamToUnifiedScheduledStatus(args: {
  upstreamStatus?: string;
  lineCount?: number;
  ended?: boolean;
}): UnifiedScheduledLifecycleStatus {
  const s = String(args.upstreamStatus || "").trim().toLowerCase();
  const lines = args.lineCount ?? 0;
  const ended = Boolean(args.ended);

  if (s === "failed" || s === "error" || s.includes("fatal")) return "failed";

  if (
    ended ||
    s === "ended" ||
    s === "completed" ||
    s === "done" ||
    s === "persisted" ||
    s === "left"
  ) {
    return lines > 0 ? "done" : "no_transcript";
  }

  if (
    s.includes("recording") ||
    s.includes("in_call") ||
    s === "joined" ||
    s === "in_meeting"
  ) {
    return "in_call";
  }

  if (s.includes("join") || s === "dispatched" || s === "waiting_room") return "joining";

  if (lines > 0) return "in_call";

  return "scheduled";
}

function shouldAdvanceStatus(
  current: UnifiedScheduledLifecycleStatus,
  next: UnifiedScheduledLifecycleStatus,
): boolean {
  if (current === next) return true;
  if (TERMINAL.has(current) && !TERMINAL.has(next)) return false;
  return STATUS_RANK[next] >= STATUS_RANK[current];
}

export function unifiedScheduledStatusForUi(
  row: Pick<UnifiedScheduledStateEntry, "status">,
): string {
  const s = row.status as UnifiedScheduledLifecycleStatus;
  switch (s) {
    case "joining":
    case "dispatched":
      return "joining";
    case "in_call":
      return "in_call";
    case "done":
      return "done";
    case "no_transcript":
      return "no_transcript";
    case "failed":
      return "failed";
    default:
      return "scheduled";
  }
}

/** True when a calendar row still has an active bot reservation (not terminal). */
export function isActiveUnifiedScheduledStatus(status: string | undefined): boolean {
  const s = String(status || "scheduled") as UnifiedScheduledLifecycleStatus;
  return !TERMINAL.has(s);
}

export async function patchUnifiedScheduledByBotId(
  botId: string,
  patch: Partial<UnifiedScheduledStateEntry>,
): Promise<boolean> {
  const id = String(botId || "").trim();
  if (!id || !unifiedScheduledStateUsesS3()) return false;

  const state = await readUnifiedScheduledStateFromS3();
  const idx = state.scheduled.findIndex((row) => row.recallBotId === id);
  if (idx < 0) return false;

  const prev = state.scheduled[idx]!;
  const nextStatus = (patch.status ?? prev.status) as UnifiedScheduledLifecycleStatus;
  const currentStatus = prev.status as UnifiedScheduledLifecycleStatus;
  if (nextStatus !== currentStatus && !shouldAdvanceStatus(currentStatus, nextStatus)) return false;

  const now = new Date().toISOString();
  state.scheduled[idx] = {
    ...prev,
    ...patch,
    status: nextStatus,
    lastStatusAt: patch.lastStatusAt ?? now,
    joinedAt: patch.joinedAt ?? (nextStatus === "in_call" ? prev.joinedAt ?? now : prev.joinedAt),
    endedAt:
      patch.endedAt ??
      (TERMINAL.has(nextStatus) ? prev.endedAt ?? now : prev.endedAt),
  };

  await writeUnifiedScheduledStateToS3(state);
  return true;
}

/** Sync unified-scheduled S3 row from a live Notetaker session poll / checkpoint. */
export async function touchUnifiedScheduledFromSession(args: {
  botId: string;
  upstreamStatus?: string;
  lineCount?: number;
  ended?: boolean;
}): Promise<void> {
  const botId = String(args.botId || "").trim();
  if (!botId) return;

  const unifiedStatus = mapUpstreamToUnifiedScheduledStatus(args);
  try {
    await patchUnifiedScheduledByBotId(botId, {
      status: unifiedStatus,
      upstreamStatus: args.upstreamStatus,
      transcriptLineCount: args.lineCount,
      lastTranscriptAt:
        (args.lineCount ?? 0) > 0 ? new Date().toISOString() : undefined,
    });
  } catch {
    // lifecycle index is best-effort — transcript persist still proceeds
  }
}
