import type { QueryClient } from "@tanstack/react-query";
import type { EmployeeScoringResponse } from "@/lib/employee-scoring-types";
import {
  loadEmployeeScoringSession,
  readEmployeeScoringSnapshot,
  scoringSnapshotKey,
} from "@/lib/employee-scoring-session";
import type { WorkspaceActivityResponse } from "@/lib/workspace-activity-types";
import {
  loadWorkspaceActivitySession,
  readWorkspaceActivitySnapshot,
  workspaceSnapshotKey,
} from "@/lib/workspace-activity-session";

/** Heavy Google / TD reports — keep warm in memory; avoid refetch when switching modules. */
export const HEAVY_REPORT_STALE_MS = 60 * 60 * 1000;
export const HEAVY_REPORT_GC_MS = 7 * 24 * 60 * 60 * 1000;

export const heavyReportQueryOptions = {
  staleTime: HEAVY_REPORT_STALE_MS,
  gcTime: HEAVY_REPORT_GC_MS,
  refetchOnWindowFocus: false,
  refetchOnMount: false,
  refetchOnReconnect: false,
} as const;

export function workspaceActivityQueryKey(applied: { start: string; end: string }) {
  return ["workspace-activity", applied.start, applied.end, "calendar"] as const;
}

export function employeeScoringQueryKey(applied: { start: string; end: string }) {
  return ["employee-scoring", applied.start, applied.end, "calendar-meetings"] as const;
}

/** Seed React Query from localStorage so returning to a module is instant (even after refresh). */
export function hydrateHeavyReportQueries(queryClient: QueryClient) {
  if (typeof window === "undefined") return;

  const wsSession = loadWorkspaceActivitySession();
  if (wsSession?.applied) {
    const snapshot =
      readWorkspaceActivitySnapshot(wsSession.applied) ?? wsSession.snapshot;
    if (snapshot) {
      queryClient.setQueryData(workspaceActivityQueryKey(wsSession.applied), snapshot);
    }
  }

  const esSession = loadEmployeeScoringSession();
  if (esSession?.applied) {
    const snapshot =
      readEmployeeScoringSnapshot(esSession.applied) ?? esSession.snapshot;
    if (snapshot) {
      queryClient.setQueryData(employeeScoringQueryKey(esSession.applied), snapshot);
    }
  }
}

export type { EmployeeScoringResponse, WorkspaceActivityResponse };
