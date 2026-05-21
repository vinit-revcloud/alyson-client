/** Persist analytics UI state across route changes (session tab lifetime). */

const STORAGE_KEY = "alyson-notetaker-analytics-session";

export type AnalyticsSessionState = {
  version: 1;
  applied: {
    periodDays: number;
    start: string;
    end: string;
    speakers: string[];
    title: string;
  };
  periodDays: number;
  speakerChips: string[];
  meetingTitleFilter: string;
  insightsMd: string | null;
  savedAt: string;
};

export function loadAnalyticsSession(): AnalyticsSessionState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AnalyticsSessionState;
    if (parsed?.version !== 1 || !parsed.applied?.start || !parsed.applied?.end) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveAnalyticsSession(state: Omit<AnalyticsSessionState, "version" | "savedAt">) {
  if (typeof window === "undefined") return;
  try {
    const payload: AnalyticsSessionState = {
      version: 1,
      ...state,
      savedAt: new Date().toISOString(),
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // quota / private mode — ignore
  }
}

export function clearAnalyticsSession() {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function analyticsQueryKey(applied: AnalyticsSessionState["applied"] | null) {
  if (!applied) return ["notetaker-analytics", "idle"] as const;
  return [
    "notetaker-analytics",
    applied.start,
    applied.end,
    applied.periodDays,
    applied.title,
    [...applied.speakers].map((s) => s.toLowerCase()).sort().join("|"),
  ] as const;
}
