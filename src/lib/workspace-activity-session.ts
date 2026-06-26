import type { WorkspaceActivityResponse } from "@/lib/workspace-activity-types";
import {
  migrateSessionStorageToLocalStorage,
  readReportSnapshot,
  writeReportSnapshot,
} from "@/lib/report-snapshot-store";

export const WORKSPACE_ACTIVITY_STORAGE_KEY = "alyson-workspace-activity-session";
const WORKSPACE_ACTIVITY_INDEX_KEY = "alyson-workspace-activity-snapshots";
const WORKSPACE_ACTIVITY_DATA_PREFIX = "alyson-wa";

export type WorkspaceActivityStoredState = {
  version: 2;
  draftStart: string;
  draftEnd: string;
  applied: { start: string; end: string } | null;
  search: string;
  sortBy: "emails" | "meetings" | "docs" | "chat";
  sortDir: "asc" | "desc";
  snapshotKey?: string;
  snapshotAt?: number;
  /** Legacy inline snapshot — prefer indexed store; kept for migration. */
  snapshot?: WorkspaceActivityResponse;
};

export function workspaceSnapshotKey(applied: { start: string; end: string }) {
  return `${applied.start}|${applied.end}`;
}

function ensureMigrated() {
  migrateSessionStorageToLocalStorage(WORKSPACE_ACTIVITY_STORAGE_KEY, WORKSPACE_ACTIVITY_STORAGE_KEY);
}

export function loadWorkspaceActivitySession(): WorkspaceActivityStoredState | null {
  if (typeof window === "undefined") return null;
  ensureMigrated();
  try {
    const raw = localStorage.getItem(WORKSPACE_ACTIVITY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceActivityStoredState;
    if (parsed?.version !== 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readWorkspaceActivitySnapshot(
  applied: { start: string; end: string } | null,
): WorkspaceActivityResponse | undefined {
  if (!applied) return undefined;
  const key = workspaceSnapshotKey(applied);
  const indexed = readReportSnapshot<WorkspaceActivityResponse>({
    indexKey: WORKSPACE_ACTIVITY_INDEX_KEY,
    dataPrefix: WORKSPACE_ACTIVITY_DATA_PREFIX,
    snapshotKey: key,
  });
  if (indexed) return indexed;

  const stored = loadWorkspaceActivitySession();
  if (!stored?.snapshot || stored.snapshotKey !== key) return undefined;
  return stored.snapshot;
}

export function saveWorkspaceActivitySession(state: WorkspaceActivityStoredState) {
  if (typeof window === "undefined") return;
  ensureMigrated();

  const { snapshot, snapshotKey, snapshotAt, ...sessionMeta } = state;
  if (snapshot && snapshotKey) {
    writeReportSnapshot({
      indexKey: WORKSPACE_ACTIVITY_INDEX_KEY,
      dataPrefix: WORKSPACE_ACTIVITY_DATA_PREFIX,
      snapshotKey,
      data: snapshot,
    });
  }

  try {
    localStorage.setItem(
      WORKSPACE_ACTIVITY_STORAGE_KEY,
      JSON.stringify({
        ...sessionMeta,
        snapshotKey,
        snapshotAt,
      }),
    );
  } catch {
    try {
      localStorage.setItem(WORKSPACE_ACTIVITY_STORAGE_KEY, JSON.stringify(sessionMeta));
    } catch {
      // ignore
    }
  }
}
