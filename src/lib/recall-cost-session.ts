import type { RecallCostReport } from "@/lib/recall-cost-report.server";

const STORAGE_KEY = "alyson-recall-cost-session";
const REPORT_TTL_MS = 60 * 60_000;

export type RecallCostSessionState = {
  version: 1;
  applied: { start: string; end: string; periodDays: number };
  insightsMd: string | null;
  reports: Record<string, { report: RecallCostReport; cachedAt: string }>;
  savedAt: string;
};

function reportKey(start: string, end: string) {
  return `${start}:${end}`;
}

export function loadRecallCostSession(): RecallCostSessionState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RecallCostSessionState;
    if (parsed?.version !== 1 || !parsed.applied?.start || !parsed.applied?.end) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getCachedRecallCostReport(start: string, end: string): RecallCostReport | null {
  const session = loadRecallCostSession();
  if (!session) return null;
  const entry = session.reports[reportKey(start, end)];
  if (!entry?.report) return null;
  if (Date.now() - Date.parse(entry.cachedAt) > REPORT_TTL_MS) return null;
  return entry.report;
}

export function saveRecallCostSession(args: {
  applied: RecallCostSessionState["applied"];
  insightsMd: string | null;
  report?: RecallCostReport;
}) {
  if (typeof window === "undefined") return;
  try {
    const prev = loadRecallCostSession();
    const reports = { ...(prev?.reports ?? {}) };
    if (args.report) {
      reports[reportKey(args.applied.start, args.applied.end)] = {
        report: args.report,
        cachedAt: new Date().toISOString(),
      };
    }
    const payload: RecallCostSessionState = {
      version: 1,
      applied: args.applied,
      insightsMd: args.insightsMd,
      reports,
      savedAt: new Date().toISOString(),
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // quota / private mode
  }
}
