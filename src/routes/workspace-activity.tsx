import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { z } from "zod";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Activity, ArrowDownAZ, ArrowUpAZ, Download, FileText, Loader2, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, PageHeader, TableScroll } from "@/components/AppShell";
import { FetchingBar, PageSkeleton, Shimmer, TableSkeleton } from "@/components/Skeleton";
import { downloadCSV } from "@/lib/csv";
import {
  heavyReportQueryOptions,
  workspaceActivityQueryKey,
} from "@/lib/heavy-report-query-cache";
import {
  loadWorkspaceActivitySession,
  readWorkspaceActivitySnapshot,
  saveWorkspaceActivitySession,
  workspaceSnapshotKey,
} from "@/lib/workspace-activity-session";
import { getWorkspaceActivity } from "@/lib/workspace-activity-functions";
import { medalRowClass, rankCellContent, workspaceActivityRank } from "@/lib/rank-medals";
import { WorkspaceActivityRangePicker, workspacePresetRange } from "@/components/WorkspaceActivityRangePicker";
import {
  defaultWorkspaceRange,
  fmtWorkspaceWhen,
  isoForInput,
} from "@/lib/workspace-activity-range";

const WorkspaceActivityCharts = lazy(() =>
  import("@/components/WorkspaceActivityCharts").then((m) => ({ default: m.WorkspaceActivityCharts })),
);

const PRESET_DAYS = [1, 7, 30, 45, 90] as const;

function rangesMatch(
  a: { start: string; end: string } | null,
  b: { start: string; end: string } | null,
) {
  if (!a || !b) return false;
  return a.start === b.start && a.end === b.end;
}

export const Route = createFileRoute("/workspace-activity")({
  head: () => ({ meta: [{ title: "Workspace Activity — Alyson HR" }] }),
  validateSearch: z
    .object({
      start: z.string().datetime().optional(),
      end: z.string().datetime().optional(),
    })
    .parse,
  component: WorkspaceActivityPage,
});

function WorkspaceActivityPage() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const showingUserDetail =
    pathname.startsWith("/workspace-activity/") && pathname !== "/workspace-activity";
  const urlSearch = Route.useSearch();

  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const now = useMemo(() => new Date(), []);
  const boot = useMemo(() => (hydrated ? loadWorkspaceActivitySession() : null), [hydrated]);
  const listDefaults = useMemo(() => defaultWorkspaceRange(), []);
  const fallbackStart = urlSearch.start ?? boot?.applied?.start ?? listDefaults.start;
  const fallbackEnd = urlSearch.end ?? boot?.applied?.end ?? listDefaults.end;

  const [draftEnd, setDraftEnd] = useState(() => boot?.draftEnd ?? isoForInput(new Date(fallbackEnd)));
  const [draftStart, setDraftStart] = useState(() => boot?.draftStart ?? isoForInput(new Date(fallbackStart)));
  const [applied, setApplied] = useState<{ start: string; end: string } | null>(() => ({
    start: fallbackStart,
    end: fallbackEnd,
  }));

  useEffect(() => {
    if (!hydrated || !urlSearch.start || !urlSearch.end) return;
    setApplied({ start: urlSearch.start, end: urlSearch.end });
    setDraftStart(isoForInput(new Date(urlSearch.start)));
    setDraftEnd(isoForInput(new Date(urlSearch.end)));
  }, [hydrated, urlSearch.start, urlSearch.end]);
  const [search, setSearch] = useState(() => boot?.search ?? "");
  const [sortBy, setSortBy] = useState<"emails" | "meetings" | "docs" | "chat">(() => boot?.sortBy ?? "emails");
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => boot?.sortDir ?? "desc");

  const persisted = useMemo(() => {
    const snapshot = readWorkspaceActivitySnapshot(applied);
    if (!snapshot || !applied) return null;
    const stored = loadWorkspaceActivitySession();
    return { snapshot, at: stored?.snapshotAt ?? boot?.snapshotAt ?? Date.now() };
  }, [applied, boot?.snapshotAt]);

  const q = useQuery({
    queryKey: applied
      ? workspaceActivityQueryKey(applied)
      : (["workspace-activity", "idle", "idle", "calendar"] as const),
    queryFn: () =>
      getWorkspaceActivity({
        data: applied
          ? {
              start: applied.start,
              end: applied.end,
              accurateMeetings: true,
            }
          : undefined,
      }),
    enabled: hydrated && applied !== null,
    retry: 1,
    initialData: persisted?.snapshot,
    initialDataUpdatedAt: persisted?.at,
    placeholderData: keepPreviousData,
    ...heavyReportQueryOptions,
  });

  const draftRange = useMemo(() => {
    if (!draftStart || !draftEnd) return null;
    const s = new Date(draftStart);
    const e = new Date(draftEnd);
    if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) return null;
    return { start: s.toISOString(), end: e.toISOString() };
  }, [draftStart, draftEnd]);

  const draftMatchesApplied = rangesMatch(draftRange, applied);
  const isBusy = q.isFetching;
  const showingStaleWindow = q.isPlaceholderData && isBusy;
  const coldLoad = !hydrated || (q.isPending && !q.data);

  const rows = q.data?.rows ?? [];
  const filteredRows = useMemo(() => {
    const s = search.trim().toLowerCase();
    const base = !s ? rows : rows.filter((r) => r.userEmail.toLowerCase().includes(s));
    const metric = (r: (typeof base)[number]) => {
      if (sortBy === "meetings") return r.meetingsCreated;
      if (sortBy === "docs") return r.docsCreated;
      if (sortBy === "chat") return r.chatMessagesSent;
      return r.emailsSent;
    };
    return [...base].sort((a, b) => {
      const diff = metric(a) - metric(b);
      if (diff !== 0) return sortDir === "asc" ? diff : -diff;
      return a.userEmail.localeCompare(b.userEmail);
    });
  }, [rows, search, sortBy, sortDir]);

  const rankByEmail = useMemo(() => workspaceActivityRank(filteredRows), [filteredRows]);

  const lastToastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!q.isSuccess || q.isPlaceholderData || !q.data || !applied) return;
    const key = workspaceSnapshotKey(applied);
    if (lastToastKey.current === key) return;
    if (lastToastKey.current !== null) {
      toast.success("Workspace activity updated");
    }
    lastToastKey.current = key;
  }, [q.isSuccess, q.isPlaceholderData, q.data, applied]);

  const apply = () => {
    if (!draftStart || !draftEnd) return toast.error("Select start and end datetime");
    const s = new Date(draftStart);
    const e = new Date(draftEnd);
    if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) return toast.error("Invalid datetime range");
    if (s.getTime() >= e.getTime()) return toast.error("Start must be before end");
    const next = { start: s.toISOString(), end: e.toISOString() };
    if (rangesMatch(next, applied)) {
      void q.refetch();
      return;
    }
    setApplied(next);
    navigate({
      to: "/workspace-activity",
      search: { start: next.start, end: next.end },
      replace: true,
    });
  };

  const applyPreset = (days: (typeof PRESET_DAYS)[number]) => {
    const preset = workspacePresetRange(days);
    setDraftStart(preset.draftStart);
    setDraftEnd(preset.draftEnd);
    const start = new Date(preset.draftStart).toISOString();
    const end = new Date(preset.draftEnd).toISOString();
    const next = { start, end };
    setApplied(next);
    navigate({
      to: "/workspace-activity",
      search: next,
      replace: true,
    });
  };

  const openEmployeeDetail = (email: string) => {
    if (!applied) return;
    navigate({
      to: "/workspace-activity/$userEmail",
      params: { userEmail: encodeURIComponent(email) },
      search: { start: applied.start, end: applied.end },
    });
  };

  const exportCsv = () => {
    if (!filteredRows.length || showingStaleWindow) return toast.error("Wait for activity to finish loading");
    const suffix = q.data?.range?.start?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
    downloadCSV(
      `workspace-activity-${suffix}.csv`,
      filteredRows.map((r) => ({
        user_email: r.userEmail,
        emails_sent: r.emailsSent,
        calendar_meetings_in_window: r.meetingsCreated,
        google_docs_created: r.docsCreated,
        chat_messages_sent: r.chatMessagesSent,
      })),
      [
        "user_email",
        "emails_sent",
        "calendar_meetings_in_window",
        "google_docs_created",
        "chat_messages_sent",
      ],
    );
    toast.success("Workspace activity exported");
  };

  const exportPdf = async () => {
    if (!q.data || !filteredRows.length || showingStaleWindow) {
      toast.error("Wait for activity to finish loading");
      return;
    }
    try {
      const { downloadWorkspaceActivityPdf } = await import("@/lib/workspace-activity-pdf");
      downloadWorkspaceActivityPdf({
        rows: filteredRows,
        range: q.data.range,
        generatedAt: q.data.generatedAt,
        filteredBy: search,
      });
      toast.success("Workspace activity PDF exported");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "PDF export failed");
    }
  };

  const applySort = (field: "emails" | "meetings" | "docs" | "chat") => {
    if (sortBy === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(field);
    setSortDir("desc");
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!q.isSuccess || q.isPlaceholderData || !q.data || !applied) {
      saveWorkspaceActivitySession({
        version: 2,
        draftStart,
        draftEnd,
        applied,
        search,
        sortBy,
        sortDir,
      });
      return;
    }
    saveWorkspaceActivitySession({
      version: 2,
      draftStart,
      draftEnd,
      applied,
      search,
      sortBy,
      sortDir,
      snapshot: q.data,
      snapshotKey: workspaceSnapshotKey(applied),
      snapshotAt: Date.now(),
    });
  }, [draftStart, draftEnd, applied, search, sortBy, sortDir, q.data, q.isSuccess, q.isPlaceholderData]);

  const statusBanner = (() => {
    if (coldLoad) {
      return {
        tone: "loading" as const,
        text: "Loading workspace activity from Google (cached for 1 hour — use Refresh to update).",
      };
    }
    if (showingStaleWindow) {
      return {
        tone: "loading" as const,
        text: "Updating activity for the new window — previous table stays visible until ready.",
      };
    }
    if (isBusy) return { tone: "loading" as const, text: "Refreshing workspace activity…" };
    if (q.isError) {
      return {
        tone: "error" as const,
        text: q.error instanceof Error ? q.error.message : "Failed to load workspace activity",
      };
    }
    return null;
  })();

  if (!hydrated) {
    return (
      <div className="ops-dense min-h-[50vh]">
        <PageHeader
          eyebrow="Operations"
          title="Workspace Activity"
          description="Loading page…"
        />
        <div className="px-5 md:px-8 py-6">
          <PageSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="ops-dense min-h-[50vh]">
      {showingUserDetail ? <Outlet /> : null}
      {!showingUserDetail ? (
        <>
      <PageHeader
        eyebrow="Operations"
        title="Workspace Activity"
        description="Google Workspace activity by employee. Click any row to open a full workspace detail page (like Time Dashboard)."
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => q.refetch()}
              disabled={!applied || isBusy}
              className="h-8 px-3 rounded-md border border-border text-xs inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isBusy ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <button
              onClick={exportCsv}
              disabled={!filteredRows.length || showingStaleWindow}
              className="h-8 px-3 rounded-md border border-border text-xs inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
            <button
              onClick={exportPdf}
              disabled={!filteredRows.length || showingStaleWindow}
              className="h-8 px-3 rounded-md border border-border text-xs inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
            >
              <FileText className="h-3.5 w-3.5" />
              Export PDF
            </button>
          </div>
        }
      />

      <FetchingBar active={isBusy} />

      <div className="px-5 md:px-8 py-6 space-y-5">
        <WorkspaceActivityRangePicker
          draftStart={draftStart}
          draftEnd={draftEnd}
          onStartChange={setDraftStart}
          onEndChange={setDraftEnd}
          onApply={apply}
          isBusy={isBusy}
          draftMatchesApplied={draftMatchesApplied}
        />
          <div className="flex flex-wrap gap-1.5 -mt-2">
            {PRESET_DAYS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => applyPreset(d)}
                className="h-7 px-3 rounded-full text-[11px] font-medium border border-border bg-paper text-muted-foreground hover:text-foreground"
              >
                {d === 1 ? "Last 1 day" : `Last ${d} days`}
              </button>
            ))}
          </div>

        {statusBanner ? (
          <div
            className={
              "rounded-md border px-3 py-2.5 text-[12px] flex items-center gap-2 " +
              (statusBanner.tone === "error"
                ? "border-destructive/40 bg-destructive/5 text-destructive"
                : "border-border bg-muted/40 text-foreground")
            }
            role="status"
            aria-live="polite"
          >
            {statusBanner.tone === "loading" ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : null}
            <span>{statusBanner.text}</span>
          </div>
        ) : null}

        {q.data && !coldLoad ? (
          <div className="surface-card p-3 text-[12px] text-muted-foreground">
            {showingStaleWindow ? <span className="font-medium text-foreground">Pending window · </span> : null}
            Window (IST): {fmtWorkspaceWhen(q.data.range.start)} → {fmtWorkspaceWhen(q.data.range.end)} · Users processed:{" "}
            {q.data.usersProcessed}
            {search.trim() ? ` · Showing: ${filteredRows.length}` : ""}
            {persisted && !isBusy && !showingStaleWindow ? " · Restored from session" : ""}
          </div>
        ) : null}

        <div className="relative max-w-sm">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search user email..."
            className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-background text-[13px]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground mr-1">Sort by</span>
          {[
            { key: "emails", label: "Emails" },
            { key: "meetings", label: "Meetings" },
            { key: "docs", label: "Docs" },
            { key: "chat", label: "Chat" },
          ].map((s) => {
            const active = sortBy === s.key;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => applySort(s.key as "emails" | "meetings" | "docs" | "chat")}
                className={
                  "h-7 px-2.5 rounded-full text-[11px] font-medium border inline-flex items-center gap-1 " +
                  (active
                    ? "bg-foreground text-background border-foreground"
                    : "bg-paper border-border text-muted-foreground hover:text-foreground")
                }
                title={active ? `Sorted ${sortDir}` : "Click to sort"}
              >
                {s.label}
                {active ? (
                  sortDir === "asc" ? <ArrowUpAZ className="h-3.5 w-3.5" /> : <ArrowDownAZ className="h-3.5 w-3.5" />
                ) : null}
              </button>
            );
          })}
        </div>

        {q.data?.warnings?.length && !showingStaleWindow ? (
          <div className="surface-card p-4">
            <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium mb-2">Warnings</div>
            <ul className="text-xs text-muted-foreground space-y-1">
              {q.data.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {coldLoad ? <TableSkeleton rows={10} /> : null}

        {q.isError && !coldLoad ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <p className="font-medium">Could not load workspace activity</p>
            <p className="mt-1 text-[13px] opacity-90">
              {q.error instanceof Error ? q.error.message : String(q.error)}
            </p>
            <button
              type="button"
              onClick={() => void q.refetch()}
              className="mt-3 h-8 px-3 rounded-md border border-destructive/30 text-xs hover:bg-destructive/10"
            >
              Try again
            </button>
          </div>
        ) : null}

        {!coldLoad && !isBusy && q.data && filteredRows.length === 0 ? (
          <EmptyState icon={Activity} title="No activity rows" description="No users or no activity events in this window." />
        ) : null}

        {!!filteredRows.length && (
          <>
            <div className="relative min-h-[12rem]">
              {showingStaleWindow ? (
                <div
                  className="absolute inset-0 z-10 rounded-lg bg-background/55 backdrop-blur-[1px] pointer-events-none flex items-start justify-center pt-8"
                  aria-hidden
                >
                  <span className="text-[12px] text-muted-foreground bg-paper border border-border px-3 py-1.5 rounded-full shadow-sm">
                    Updating activity…
                  </span>
                </div>
              ) : null}
              <div
                className={
                  showingStaleWindow ? "opacity-60 pointer-events-none select-none transition-opacity" : ""
                }
              >
            <TableScroll>
              <table className="ops-table w-full">
                <thead>
                  <tr>
                    <th align="center">Medal</th>
                    <th align="left">User email</th>
                    <th align="right">Emails sent</th>
                    <th align="right">Meetings in window</th>
                    <th align="right">Docs created</th>
                    <th align="right">Chat messages</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((r, rowIndex) => {
                    const rank = rankByEmail.get(r.userEmail) ?? rowIndex + 1;
                    return (
                    <tr
                      key={r.userEmail}
                      className={medalRowClass(rank) + " hover:bg-muted/40 cursor-pointer"}
                      onClick={() => openEmployeeDetail(r.userEmail)}
                      title="Open workspace detail page"
                    >
                      <td align="center">{rankCellContent(rank)}</td>
                      <td className="align-middle">
                        <div className="font-medium text-[13px]">
                          {applied ? (
                            <Link
                              to="/workspace-activity/$userEmail"
                              params={{ userEmail: encodeURIComponent(r.userEmail) }}
                              search={{ start: applied.start, end: applied.end }}
                              className="hover:underline"
                              onClick={(ev) => ev.stopPropagation()}
                            >
                              {r.userEmail.split("@")[0]}
                            </Link>
                          ) : (
                            r.userEmail.split("@")[0]
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate">{r.userEmail}</div>
                      </td>
                      <td align="right" className="font-mono">
                        {r.emailsSent}
                      </td>
                      <td align="right" className="font-mono">
                        {r.meetingsCreated}
                      </td>
                      <td align="right" className="font-mono">
                        {r.docsCreated}
                      </td>
                      <td align="right" className="font-mono">
                        {r.chatMessagesSent}
                      </td>
                    </tr>
                  );})}
                </tbody>
              </table>
            </TableScroll>
              </div>
            </div>

            <Suspense
              fallback={
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <Shimmer className="h-[18rem]" />
                  <Shimmer className="h-[18rem]" />
                </div>
              }
            >
              <WorkspaceActivityCharts filteredRows={filteredRows} />
            </Suspense>
          </>
        )}
      </div>
      </>
      ) : null}
    </div>
  );
}
