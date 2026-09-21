import { randomUUID } from "node:crypto";
import {
  mutateUnifiedScheduledStateInS3,
  type UnifiedScheduledStateEntry,
} from "@/lib/unified-scheduled-s3.server";
import { isActiveUnifiedScheduledStatus } from "@/lib/unified-scheduled-lifecycle.server";

const RESERVING_PREFIX = "reserving:";
const RESERVATION_STALE_MS = 10 * 60_000;
const PEER_WAIT_MS = 2_500;
const PEER_WAIT_ATTEMPTS = 4;

export function meetingInstanceDedupeKey(meetingUrl: string, startTime: string): string {
  const url = String(meetingUrl || "").trim();
  const ms = new Date(startTime).getTime();
  const normalizedStart = Number.isFinite(ms) ? new Date(ms).toISOString() : String(startTime || "").trim();
  return `${url}|${normalizedStart}`;
}

export function isReservingBotId(botId: string | null | undefined): boolean {
  return String(botId || "").startsWith(RESERVING_PREFIX);
}

function isRealBotId(botId: string | null | undefined): boolean {
  const id = String(botId || "").trim();
  return Boolean(id) && !isReservingBotId(id);
}

function findActiveRow(
  scheduled: UnifiedScheduledStateEntry[],
  dedupeKey: string,
): UnifiedScheduledStateEntry | undefined {
  return scheduled.find(
    (row) =>
      row.dedupeKey === dedupeKey &&
      isActiveUnifiedScheduledStatus(row.status) &&
      Boolean(row.recallBotId),
  );
}

function reservationAgeMs(row: UnifiedScheduledStateEntry): number {
  const at = Date.parse(String(row.scheduledAt || row.lastStatusAt || ""));
  return Number.isFinite(at) ? Date.now() - at : RESERVATION_STALE_MS + 1;
}

/**
 * True while a "reserving:" placeholder is still plausibly in flight. A placeholder older than
 * RESERVATION_STALE_MS means the dispatching function died (e.g. serverless timeout) before it
 * could commit or abort — callers must treat that meeting as unscheduled so it gets retried.
 */
export function isFreshReservation(row: Pick<UnifiedScheduledStateEntry, "recallBotId" | "scheduledAt" | "lastStatusAt">): boolean {
  return isReservingBotId(row.recallBotId) && reservationAgeMs(row as UnifiedScheduledStateEntry) <= RESERVATION_STALE_MS;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type MeetingBotReservationResult =
  | { kind: "existing"; botId: string; entry: UnifiedScheduledStateEntry }
  | { kind: "reserved"; slotId: string; dedupeKey: string };

type ReserveMutateOutcome =
  | { kind: "existing"; botId: string; entry: UnifiedScheduledStateEntry }
  | { kind: "peer_wait" }
  | { kind: "reserved"; slotId: string; dedupeKey: string };

/** One bot per meeting URL + start — atomic S3 claim before calling Recall. */
export async function resolveOrReserveMeetingBot(args: {
  dedupeKey: string;
  buildPlaceholder: () => UnifiedScheduledStateEntry;
}): Promise<MeetingBotReservationResult> {
  const dedupeKey = String(args.dedupeKey || "").trim();
  if (!dedupeKey) throw new Error("Missing meeting dedupe key");

  for (let attempt = 0; attempt < PEER_WAIT_ATTEMPTS; attempt++) {
    const outcome = await mutateUnifiedScheduledStateInS3<ReserveMutateOutcome>((state) => {
      const scheduled = [...state.scheduled];
      const idx = scheduled.findIndex((row) => row.dedupeKey === dedupeKey);

      if (idx >= 0) {
        const row = scheduled[idx]!;
        if (isRealBotId(row.recallBotId) && isActiveUnifiedScheduledStatus(row.status)) {
          return { state, value: { kind: "existing" as const, botId: row.recallBotId, entry: row } };
        }
        if (isReservingBotId(row.recallBotId)) {
          if (reservationAgeMs(row) <= RESERVATION_STALE_MS) {
            return { state, value: { kind: "peer_wait" as const } };
          }
          scheduled.splice(idx, 1);
        }
      }

      const slotId = `${RESERVING_PREFIX}${randomUUID()}`;
      const placeholder = { ...args.buildPlaceholder(), dedupeKey, recallBotId: slotId };
      const existingIdx = scheduled.findIndex((row) => row.dedupeKey === dedupeKey);
      if (existingIdx >= 0) scheduled[existingIdx] = placeholder;
      else scheduled.push(placeholder);

      return {
        state: { ...state, scheduled },
        value: { kind: "reserved" as const, slotId, dedupeKey },
      };
    });

    if (outcome.kind === "peer_wait") {
      await sleep(PEER_WAIT_MS);
      continue;
    }
    return outcome;
  }

  const existing = await mutateUnifiedScheduledStateInS3<ReserveMutateOutcome>((state) => {
    const row = findActiveRow(state.scheduled, dedupeKey);
    if (row && isRealBotId(row.recallBotId)) {
      return { state, value: { kind: "existing" as const, botId: row.recallBotId, entry: row } };
    }
    return { state, value: { kind: "peer_wait" as const } };
  });

  if (existing.kind === "existing") return existing;
  throw new Error("Timed out waiting for another sync to finish scheduling this meeting");
}

export async function commitMeetingBotReservation(args: {
  dedupeKey: string;
  slotId: string;
  botId: string;
  entry: UnifiedScheduledStateEntry;
}): Promise<void> {
  const dedupeKey = String(args.dedupeKey || "").trim();
  const slotId = String(args.slotId || "").trim();
  const botId = String(args.botId || "").trim();
  if (!dedupeKey || !slotId || !botId) throw new Error("Invalid meeting bot reservation commit");

  await mutateUnifiedScheduledStateInS3((state) => {
    const scheduled = [...state.scheduled];
    const idx = scheduled.findIndex((row) => row.dedupeKey === dedupeKey);
    const next: UnifiedScheduledStateEntry = { ...args.entry, dedupeKey, recallBotId: botId };
    if (idx >= 0) scheduled[idx] = next;
    else scheduled.push(next);
    return { state: { ...state, scheduled }, value: true };
  });
}

export async function abortMeetingBotReservation(args: {
  dedupeKey: string;
  slotId: string;
}): Promise<void> {
  const dedupeKey = String(args.dedupeKey || "").trim();
  const slotId = String(args.slotId || "").trim();
  if (!dedupeKey || !slotId) return;

  await mutateUnifiedScheduledStateInS3((state) => {
    const scheduled = state.scheduled.filter(
      (row) => !(row.dedupeKey === dedupeKey && row.recallBotId === slotId),
    );
    return { state: { ...state, scheduled }, value: true };
  });
}
