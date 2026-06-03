import type { HourlyActivityResponse } from "@/lib/hourly-activity-functions";

export const HOURLY_ACTIVITY_STORAGE_KEY = "alyson-hourly-report-session";

export type HourlyActivityStoredState = {
  version: 2;
  draftStart: string;
  draftEnd: string;
  search: string;
  applied: { start: string; end: string; userEmail: string } | null;
  snapshotKey?: string;
  snapshotAt?: number;
  snapshot?: HourlyActivityResponse;
};

export function hourlySnapshotKey(applied: { start: string; end: string; userEmail: string }) {
  return `${applied.start}|${applied.end}|${applied.userEmail}`;
}

export function loadHourlyActivitySession(): HourlyActivityStoredState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(HOURLY_ACTIVITY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HourlyActivityStoredState;
    if (parsed?.version !== 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readHourlyActivitySnapshot(
  applied: { start: string; end: string; userEmail: string } | null,
): HourlyActivityResponse | undefined {
  if (!applied) return undefined;
  const stored = loadHourlyActivitySession();
  if (!stored?.snapshot || stored.snapshotKey !== hourlySnapshotKey(applied)) return undefined;
  return stored.snapshot;
}

export function saveHourlyActivitySession(state: HourlyActivityStoredState) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(HOURLY_ACTIVITY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    try {
      const { snapshot: _s, snapshotKey: _k, snapshotAt: _a, ...rest } = state;
      sessionStorage.setItem(HOURLY_ACTIVITY_STORAGE_KEY, JSON.stringify(rest));
    } catch {
      // ignore
    }
  }
}
