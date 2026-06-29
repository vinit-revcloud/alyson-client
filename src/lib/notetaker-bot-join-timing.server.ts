import type { BotJoinReportRow } from "@/lib/notetaker-bot-join-report.types";
import type { CalendarMeetingRef } from "@/lib/notetaker-bot-join-report.types";

/** Bot is scheduled ~2 min before start; never joins more than ~20 min early. */
export const MAX_PLAUSIBLE_EARLY_SECONDS = 20 * 60;
export const LATE_GRACE_SECONDS = 2 * 60;

function secondsBetween(startIso: string, endIso: string): number | null {
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 1000);
}

function normalizeStartIso(iso: string): string {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(iso).trim();
}

function meetingDedupeKey(meetingUrl: string, startTime: string): string {
  return `${String(meetingUrl).trim()}|${normalizeStartIso(startTime)}`;
}

export type AdmissionTiming = {
  meetingStartAt: string | null;
  meetingStartReliable: boolean;
  lateToStartSeconds: number | null;
  lateToStartLabel: string;
  lateMinutes: number | null;
};

export function formatLateToStartLabel(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds <= LATE_GRACE_SECONDS) return "On time";
  if (seconds < 60) return `${seconds}s late`;
  const m = Math.round(seconds / 60);
  return `${m}m late`;
}

export function lateMinutesFromSeconds(seconds: number | null): number | null {
  if (seconds == null || seconds <= LATE_GRACE_SECONDS) return null;
  return Math.round((seconds / 60) * 10) / 10;
}

export function computeAdmissionTiming(args: {
  meetingStartAt: string | null;
  meetingStartReliable: boolean;
  admittedAt: string | null;
  joiningCallAt: string | null;
  joinedMeeting: boolean;
}): AdmissionTiming {
  const base = {
    meetingStartAt: args.meetingStartAt,
    meetingStartReliable: args.meetingStartReliable,
    lateToStartSeconds: null as number | null,
    lateToStartLabel: "—",
    lateMinutes: null as number | null,
  };

  if (!args.joinedMeeting || !args.meetingStartAt || !args.meetingStartReliable) {
    return base;
  }

  const admitAt = args.admittedAt || args.joiningCallAt;
  if (!admitAt) return base;

  const rawSeconds = secondsBetween(args.meetingStartAt, admitAt);
  if (rawSeconds == null) return base;

  // Wrong anchor (e.g. session createdAt used as start) — skip misleading early/late.
  if (rawSeconds < -MAX_PLAUSIBLE_EARLY_SECONDS) {
    return base;
  }

  return {
    meetingStartAt: args.meetingStartAt,
    meetingStartReliable: true,
    lateToStartSeconds: rawSeconds,
    lateToStartLabel: formatLateToStartLabel(rawSeconds),
    lateMinutes: lateMinutesFromSeconds(rawSeconds),
  };
}

export function resolveMeetingStartForCandidate(args: {
  meetingUrl: string | null;
  scheduledStart: string | null;
  source: BotJoinReportRow["source"];
  botJoinAt?: string | null;
  admittedAt?: string | null;
  joiningCallAt?: string | null;
  eligibleMeetings: CalendarMeetingRef[];
}): { meetingStartAt: string | null; reliable: boolean } {
  if (
    (args.source === "unified_scheduled" || args.source === "recall_calendar") &&
    args.scheduledStart
  ) {
    return { meetingStartAt: args.scheduledStart, reliable: true };
  }

  if (!args.meetingUrl) {
    return { meetingStartAt: null, reliable: false };
  }

  const url = args.meetingUrl.trim();
  const candidates = args.eligibleMeetings.filter((m) => m.meetingUrl.trim() === url);
  if (!candidates.length) {
    return { meetingStartAt: args.scheduledStart, reliable: false };
  }

  if (args.scheduledStart) {
    const key = meetingDedupeKey(url, args.scheduledStart);
    const exact = candidates.find((m) => m.dedupeKey === key);
    if (exact) return { meetingStartAt: exact.startTime, reliable: true };
    const startMs = Date.parse(args.scheduledStart);
    if (Number.isFinite(startMs)) {
      const close = candidates.find((m) => Math.abs(Date.parse(m.startTime) - startMs) <= 90_000);
      if (close) return { meetingStartAt: close.startTime, reliable: true };
    }
  }

  const admitMs = Date.parse(String(args.admittedAt || args.joiningCallAt || ""));
  if (Number.isFinite(admitMs)) {
    const during = candidates.find((m) => {
      const start = Date.parse(m.startTime);
      const end = m.endTime ? Date.parse(m.endTime) : start + 2 * 3600000;
      return admitMs >= start - 30 * 60_000 && admitMs <= end + 30 * 60_000;
    });
    if (during) return { meetingStartAt: during.startTime, reliable: true };
  }

  const joinMs = Date.parse(String(args.botJoinAt || ""));
  if (Number.isFinite(joinMs)) {
    const near = candidates.find((m) => {
      const start = Date.parse(m.startTime);
      return Math.abs(start - joinMs) <= 25 * 60_000;
    });
    if (near) return { meetingStartAt: near.startTime, reliable: true };
  }

  return { meetingStartAt: null, reliable: false };
}

export function applyAdmissionTimingToRow(
  row: BotJoinReportRow,
  eligibleMeetings: CalendarMeetingRef[],
): BotJoinReportRow {
  const { meetingStartAt, reliable } = resolveMeetingStartForCandidate({
    meetingUrl: row.meetingUrl,
    scheduledStart: row.scheduledStart,
    source: row.source,
    botJoinAt: row.botJoinAt,
    admittedAt: row.admittedAt,
    joiningCallAt: row.joiningCallAt,
    eligibleMeetings,
  });

  const timing = computeAdmissionTiming({
    meetingStartAt,
    meetingStartReliable: reliable,
    admittedAt: row.admittedAt,
    joiningCallAt: row.joiningCallAt,
    joinedMeeting: row.joinedMeeting,
  });

  return {
    ...row,
    scheduledStart: meetingStartAt || row.scheduledStart,
    meetingStartAt: timing.meetingStartAt,
    meetingStartReliable: timing.meetingStartReliable,
    lateToStartSeconds: timing.lateToStartSeconds,
    lateToStartLabel: timing.lateToStartLabel,
    lateMinutes: timing.lateMinutes,
  };
}
