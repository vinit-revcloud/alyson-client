import type { BotJoinReport } from "@/lib/notetaker-bot-join-report.types";

const STORAGE_KEY = "alyson-bot-join-report-session";
const REPORT_TTL_MS = 30 * 60_000;

export type BotJoinReportSessionState = {
  version: 1;
  applied: { start: string; end: string; periodDays: number; windowHours?: number };
  calendarEmail: string;
  reports: Record<string, { report: BotJoinReport; cachedAt: string }>;
  savedAt: string;
};

function reportKey(calendarEmail: string, start: string, end: string, windowHours?: number) {
  return `${calendarEmail}|${start}:${end}|${windowHours ?? "days"}`;
}

export function loadBotJoinReportSession(): BotJoinReportSessionState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BotJoinReportSessionState;
    if (parsed?.version !== 1 || !parsed.applied?.start || !parsed.applied?.end) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getCachedBotJoinReport(
  calendarEmail: string,
  start: string,
  end: string,
  windowHours?: number,
): BotJoinReport | null {
  const session = loadBotJoinReportSession();
  if (!session) return null;
  const entry = session.reports[reportKey(calendarEmail, start, end, windowHours)];
  if (!entry?.report) return null;
  if (Date.now() - Date.parse(entry.cachedAt) > REPORT_TTL_MS) return null;
  return entry.report;
}

export function saveBotJoinReportSession(args: {
  applied: BotJoinReportSessionState["applied"];
  calendarEmail: string;
  report?: BotJoinReport;
}) {
  if (typeof window === "undefined") return;
  try {
    const prev = loadBotJoinReportSession();
    const reports = { ...(prev?.reports ?? {}) };
    if (args.report) {
      reports[reportKey(args.calendarEmail, args.applied.start, args.applied.end, args.applied.windowHours)] = {
        report: args.report,
        cachedAt: new Date().toISOString(),
      };
    }
    const payload: BotJoinReportSessionState = {
      version: 1,
      applied: args.applied,
      calendarEmail: args.calendarEmail,
      reports,
      savedAt: new Date().toISOString(),
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // quota / private mode
  }
}

/** Cleared when leaving the Bot Join Report screen so data does not linger across modules. */
export function clearBotJoinReportSession() {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
