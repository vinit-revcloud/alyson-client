import type { EmployeeScoringResponse } from "@/lib/employee-scoring-functions";

export const EMPLOYEE_SCORING_STORAGE_KEY = "alyson-employee-scoring-session";

export type EmployeeScoringStoredState = {
  version: 2;
  draftStart: string;
  draftEnd: string;
  applied: { start: string; end: string } | null;
  search: string;
  snapshotKey?: string;
  snapshotAt?: number;
  snapshot?: EmployeeScoringResponse;
};

export function scoringSnapshotKey(applied: { start: string; end: string }) {
  return `${applied.start}|${applied.end}`;
}

export function loadEmployeeScoringSession(): EmployeeScoringStoredState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(EMPLOYEE_SCORING_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EmployeeScoringStoredState;
    if (parsed?.version !== 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readEmployeeScoringSnapshot(
  applied: { start: string; end: string } | null,
): EmployeeScoringResponse | undefined {
  if (!applied) return undefined;
  const stored = loadEmployeeScoringSession();
  if (!stored?.snapshot || stored.snapshotKey !== scoringSnapshotKey(applied)) return undefined;
  return stored.snapshot;
}

export function saveEmployeeScoringSession(state: EmployeeScoringStoredState) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(EMPLOYEE_SCORING_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // quota exceeded — drop snapshot and retry with filters only
    try {
      const { snapshot: _s, snapshotKey: _k, snapshotAt: _a, ...rest } = state;
      sessionStorage.setItem(EMPLOYEE_SCORING_STORAGE_KEY, JSON.stringify(rest));
    } catch {
      // ignore
    }
  }
}
