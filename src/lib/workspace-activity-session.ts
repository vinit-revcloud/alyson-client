import type { WorkspaceActivityResponse } from "@/lib/workspace-activity-functions";

export const WORKSPACE_ACTIVITY_STORAGE_KEY = "alyson-workspace-activity-session";

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
  snapshot?: WorkspaceActivityResponse;
};

export function workspaceSnapshotKey(applied: { start: string; end: string }) {
  return `${applied.start}|${applied.end}`;
}

export function loadWorkspaceActivitySession(): WorkspaceActivityStoredState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(WORKSPACE_ACTIVITY_STORAGE_KEY);
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
  const stored = loadWorkspaceActivitySession();
  if (!stored?.snapshot || stored.snapshotKey !== workspaceSnapshotKey(applied)) return undefined;
  return stored.snapshot;
}

export function saveWorkspaceActivitySession(state: WorkspaceActivityStoredState) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(WORKSPACE_ACTIVITY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    try {
      const { snapshot: _s, snapshotKey: _k, snapshotAt: _a, ...rest } = state;
      sessionStorage.setItem(WORKSPACE_ACTIVITY_STORAGE_KEY, JSON.stringify(rest));
    } catch {
      // ignore
    }
  }
}
