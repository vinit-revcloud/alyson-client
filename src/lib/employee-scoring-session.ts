import type { EmployeeScoringResponse } from "@/lib/employee-scoring-types";
import {
  migrateSessionStorageToLocalStorage,
  readReportSnapshot,
  writeReportSnapshot,
} from "@/lib/report-snapshot-store";

export const EMPLOYEE_SCORING_STORAGE_KEY = "alyson-employee-scoring-session";
const EMPLOYEE_SCORING_INDEX_KEY = "alyson-employee-scoring-snapshots";
const EMPLOYEE_SCORING_DATA_PREFIX = "alyson-es";

export type EmployeeScoringStoredState = {
  version: 2;
  draftStart: string;
  draftEnd: string;
  applied: { start: string; end: string } | null;
  search: string;
  snapshotKey?: string;
  snapshotAt?: number;
  /** Legacy inline snapshot — prefer indexed store; kept for migration. */
  snapshot?: EmployeeScoringResponse;
};

export function scoringSnapshotKey(applied: { start: string; end: string }) {
  return `${applied.start}|${applied.end}`;
}

function ensureMigrated() {
  migrateSessionStorageToLocalStorage(EMPLOYEE_SCORING_STORAGE_KEY, EMPLOYEE_SCORING_STORAGE_KEY);
}

export function loadEmployeeScoringSession(): EmployeeScoringStoredState | null {
  if (typeof window === "undefined") return null;
  ensureMigrated();
  try {
    const raw = localStorage.getItem(EMPLOYEE_SCORING_STORAGE_KEY);
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
  const key = scoringSnapshotKey(applied);
  const indexed = readReportSnapshot<EmployeeScoringResponse>({
    indexKey: EMPLOYEE_SCORING_INDEX_KEY,
    dataPrefix: EMPLOYEE_SCORING_DATA_PREFIX,
    snapshotKey: key,
  });
  if (indexed) return indexed;

  const stored = loadEmployeeScoringSession();
  if (!stored?.snapshot || stored.snapshotKey !== key) return undefined;
  return stored.snapshot;
}

export function saveEmployeeScoringSession(state: EmployeeScoringStoredState) {
  if (typeof window === "undefined") return;
  ensureMigrated();

  const { snapshot, snapshotKey, snapshotAt, ...sessionMeta } = state;
  if (snapshot && snapshotKey) {
    writeReportSnapshot({
      indexKey: EMPLOYEE_SCORING_INDEX_KEY,
      dataPrefix: EMPLOYEE_SCORING_DATA_PREFIX,
      snapshotKey,
      data: snapshot,
    });
  }

  try {
    localStorage.setItem(
      EMPLOYEE_SCORING_STORAGE_KEY,
      JSON.stringify({
        ...sessionMeta,
        snapshotKey,
        snapshotAt,
      }),
    );
  } catch {
    try {
      localStorage.setItem(EMPLOYEE_SCORING_STORAGE_KEY, JSON.stringify(sessionMeta));
    } catch {
      // ignore
    }
  }
}
