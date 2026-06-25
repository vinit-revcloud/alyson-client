import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { PageHeader, TableScroll } from "@/components/AppShell";
import { FetchingBar } from "@/components/Skeleton";
import { TimeDashboardGate } from "@/components/TimeDashboardGate";
import { WeeklyPacingWeekPicker } from "@/components/WeeklyPacingWeekPicker";
import {
  fetchWeeklyHoursTrend,
  fetchWeeklyPacingReport,
  getWeeklyPacingInsights,
  setWeeklyPacingActiveOverride,
} from "@/lib/time-doctor-pacing-functions";
import { WeeklyPacingTrendPanel } from "@/components/WeeklyPacingTrendPanel";
import { formatRangeLabel, isIsoDate } from "@/lib/time-dashboard-range";
import {
  filterPacingRows,
  isFridayOrLater,
  pacingFilterExportSlug,
  pacingFilterSummaryLabel,
  pacingTodayIso,
  formatActiveLabel,
  PACING_STATUS_LABEL,
  resolvePacingRollupDay,
  sortPacingRows,
  weekStartIso,
  type WeeklyPacingRow,
  type WeeklyPacingSortField,
  type WeeklyPacingStatus,
} from "@/lib/weekly-pacing";
import { downloadCSV } from "@/lib/csv";
import { downloadWeeklyPacingPdf } from "@/lib/weekly-pacing-pdf";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { ArrowDownAZ, ArrowLeft, ArrowUpAZ, ChevronDown, Copy, Download, FileText, RefreshCw, Search, Sparkles, TrendingDown } from "lucide-react";
import { z } from "zod";

export const Route = createFileRoute("/time-dashboard/pacing")({
  head: () => ({ meta: [{ title: "Weekly Pacing — Alyson HR" }] }),
  validateSearch: z
    .object({
      day: z.string().optional(),
    })
    .transform((s) => ({
      day: isIsoDate(s.day) ? s.day : undefined,
    }))
    .parse,
  component: WeeklyPacingPage,
});

function statusClass(status: WeeklyPacingStatus): string {
  switch (status) {
    case "target_met":
      return "bg-emerald-500/20 text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-500/30";
    case "on_track":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    case "behind":
      return "bg-amber-500/15 text-amber-800 dark:text-amber-300";
    case "at_risk":
      return "bg-orange-500/15 text-orange-800 dark:text-orange-300";
    case "critical":
      return "bg-red-500/15 text-red-700 dark:text-red-300";
  }
}

function rowClass(row: WeeklyPacingRow): string {
  if (row.metTarget) return "bg-emerald-500/[0.06] hover:bg-emerald-500/10";
  return "hover:bg-muted/30";
}

function ActiveStatusEditor({
  row,
  disabled,
  onConfirmChange,
}: {
  row: WeeklyPacingRow;
  disabled?: boolean;
  onConfirmChange: (next: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<boolean | null>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const anchorRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openMenu = useCallback(() => {
    const el = anchorRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 6, left: Math.max(8, rect.left) });
    }
    setMenuOpen(true);
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => setMenuOpen(false), 150);
  }, [cancelClose]);

  useEffect(() => {
    if (!menuOpen) return;
    const onScroll = () => setMenuOpen(false);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [menuOpen]);

  function pick(next: boolean) {
    setMenuOpen(false);
    if (next === row.active) return;
    setPending(next);
  }

  const badgeClass = row.active
    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
    : "border-border bg-muted/40 text-muted-foreground";

  return (
    <>
      <div
        className="relative inline-block"
        onMouseEnter={() => {
          if (disabled) return;
          cancelClose();
          openMenu();
        }}
        onMouseLeave={scheduleClose}
      >
        <button
          ref={anchorRef}
          type="button"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            if (disabled) return;
            cancelClose();
            openMenu();
          }}
          title={
            row.activeOverridden
              ? `Manual override (auto was ${formatActiveLabel(row.computedActive ?? !row.active)}). Click or hover to change.`
              : "Click or hover to change Active status"
          }
          className={
            "inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[11px] font-medium cursor-pointer transition-shadow hover:ring-2 hover:ring-foreground/15 disabled:opacity-50 disabled:cursor-not-allowed " +
            badgeClass
          }
        >
          {formatActiveLabel(row.active)}
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
        {row.activeOverridden ? (
          <div className="text-[10px] text-muted-foreground mt-0.5 text-center">Manual</div>
        ) : null}
      </div>

      {menuOpen && !disabled
        ? createPortal(
            <div
              className="fixed z-[90] rounded-lg border border-border bg-paper shadow-xl p-2.5 min-w-[152px]"
              style={{ top: menuPos.top, left: menuPos.left }}
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-[11px] font-medium text-foreground px-0.5">Change active status?</div>
              <div className="text-[10px] text-muted-foreground px-0.5 mt-0.5 mb-2">
                Now: <span className="font-medium text-foreground">{formatActiveLabel(row.active)}</span>
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => pick(true)}
                  className={
                    "flex-1 h-7 rounded-md text-[11px] font-medium border transition-colors " +
                    (row.active
                      ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200"
                      : "border-border hover:bg-emerald-500/10 hover:border-emerald-500/30")
                  }
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => pick(false)}
                  className={
                    "flex-1 h-7 rounded-md text-[11px] font-medium border transition-colors " +
                    (!row.active
                      ? "border-border bg-muted text-foreground"
                      : "border-border hover:bg-muted/80")
                  }
                >
                  No
                </button>
              </div>
              <div className="text-[10px] text-muted-foreground mt-2 px-0.5 leading-snug">
                Saved permanently in S3
              </div>
            </div>,
            document.body,
          )
        : null}

      <AlertDialog.Root open={pending != null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/40 z-[100]" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[100] w-[92vw] max-w-md surface-card p-4">
            <AlertDialog.Title className="font-medium text-[14px]">Update Active status?</AlertDialog.Title>
            <AlertDialog.Description asChild>
              <div className="mt-2 space-y-2 text-[12px] text-muted-foreground leading-relaxed">
                <p>
                  Set <span className="font-semibold text-foreground">{row.name}</span> to{" "}
                  <span className="font-semibold text-foreground">{pending != null ? formatActiveLabel(pending) : "—"}</span>?
                </p>
                <p>
                  This is saved permanently in S3 and applies to all future weekly pacing reports, trends, and AI
                  insights (until you change it again).
                </p>
                {row.computedActive != null && pending != null && pending !== row.computedActive ? (
                  <p>
                    Auto-detected value was <strong>{formatActiveLabel(row.computedActive)}</strong> — your choice
                    overrides it.
                  </p>
                ) : null}
              </div>
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className="h-8 px-3 rounded-md border border-border text-[12px] font-medium hover:bg-muted"
                >
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  onClick={() => {
                    if (pending == null) return;
                    onConfirmChange(pending);
                    setPending(null);
                  }}
                  className="h-8 px-3 rounded-md bg-foreground text-background text-[12px] font-medium"
                >
                  Yes, save to S3
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}

function WeeklyPacingPage() {
  const auth = useAuth();
  const canAccess = auth.canAccessTimeDashboard;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = Route.useSearch();
  const defaultDay = pacingTodayIso();

  const [sortBy, setSortBy] = useState<WeeklyPacingSortField>("hoursRemaining");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [pdfLoading, setPdfLoading] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [locationFilter, setLocationFilter] = useState("__all__");
  const [teamFilter, setTeamFilter] = useState("__all__");
  const [activeFilter, setActiveFilter] = useState("__all__");
  const [day, setDay] = useState(search.day ?? defaultDay);
  const [insightsMd, setInsightsMd] = useState<string | null>(null);

  useEffect(() => {
    if (search.day) setDay(search.day);
  }, [search.day]);

  const appliedDay = search.day ?? defaultDay;
  const rollupDay = useMemo(() => resolvePacingRollupDay(appliedDay), [appliedDay]);
  const isHistoricalWeek = weekStartIso(appliedDay) < weekStartIso(defaultDay);

  useEffect(() => {
    setInsightsMd(null);
  }, [rollupDay, locationFilter, teamFilter, activeFilter, searchQ]);

  const q = useQuery({
    queryKey: ["weekly-pacing-report", rollupDay],
    queryFn: () => fetchWeeklyPacingReport({ data: { targetHours: 35, day: rollupDay } }),
    enabled: canAccess,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const trendQ = useQuery({
    queryKey: ["weekly-hours-trend", locationFilter, teamFilter],
    queryFn: () =>
      fetchWeeklyHoursTrend({
        data: {
          weekCount: 8,
          targetHours: 35,
          location: locationFilter,
          team: teamFilter,
          active: "yes",
        },
      }),
    enabled: canAccess,
    placeholderData: keepPreviousData,
    staleTime: 120_000,
    refetchOnWindowFocus: false,
  });

  const draftMatchesApplied = day === appliedDay;
  const isBusy = q.isFetching;
  const isTrendRefetching = trendQ.isFetching && Boolean(trendQ.isPlaceholderData && trendQ.data);
  const isTrendLoading = trendQ.isPending && !trendQ.data;

  const report = q.data;
  const allRows = report?.rows ?? [];

  const locationOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) set.add(r.location?.trim() || "__empty__");
    return [...set].sort((a, b) => {
      if (a === "__empty__") return 1;
      if (b === "__empty__") return -1;
      return a.localeCompare(b);
    });
  }, [allRows]);

  const teamOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) set.add(r.team?.trim() || "__empty__");
    return [...set].sort((a, b) => {
      if (a === "__empty__") return 1;
      if (b === "__empty__") return -1;
      return a.localeCompare(b);
    });
  }, [allRows]);

  const facetFilteredRows = useMemo(() => {
    return allRows.filter((r) => {
      const loc = r.location?.trim() || "__empty__";
      const team = r.team?.trim() || "__empty__";
      if (locationFilter !== "__all__" && loc !== locationFilter) return false;
      if (teamFilter !== "__all__" && team !== teamFilter) return false;
      if (activeFilter === "yes" && !r.active) return false;
      if (activeFilter === "no" && r.active) return false;
      return true;
    });
  }, [activeFilter, allRows, locationFilter, teamFilter]);

  const filteredRows = useMemo(
    () => filterPacingRows(facetFilteredRows, searchQ),
    [facetFilteredRows, searchQ],
  );

  const rows = useMemo(
    () => sortPacingRows(filteredRows, sortBy, sortDir),
    [filteredRows, sortBy, sortDir],
  );

  const facetFilters = useMemo(
    () => ({ location: locationFilter, team: teamFilter, active: activeFilter }),
    [activeFilter, locationFilter, teamFilter],
  );

  const hasFacetFilters =
    locationFilter !== "__all__" || teamFilter !== "__all__" || activeFilter !== "__all__";
  const hasAnyFilters = hasFacetFilters || Boolean(searchQ.trim());
  const filterSummary = useMemo(() => pacingFilterSummaryLabel(facetFilters), [facetFilters]);

  const exportFilenameBase = useMemo(() => {
    if (!report) return "weekly-pacing";
    const slug = pacingFilterExportSlug(facetFilters);
    return `weekly-pacing-${report.week.start}-to-${report.today}${slug ? `-${slug}` : ""}`;
  }, [facetFilters, report]);

  const weekLabel = report ? formatRangeLabel(report.week.start, report.week.end) : "…";
  const asOfLabel = report ? formatRangeLabel(report.today, report.today) : "…";

  const summary = useMemo(() => {
    if (!filteredRows.length) return null;
    const metTarget = filteredRows.filter((r) => r.metTarget).length;
    const underTarget = filteredRows.length - metTarget;
    const critical = filteredRows.filter((r) => r.status === "critical").length;
    const atRisk = filteredRows.filter((r) => r.status === "at_risk").length;
    const behind = filteredRows.filter((r) => r.status === "behind").length;
    return { metTarget, underTarget, critical, atRisk, behind };
  }, [filteredRows]);

  const insightsM = useMutation({
    mutationFn: async () => {
      if (!report || !summary) throw new Error("Load pacing report first");
      const activeRows = filteredRows.filter((r) => r.active);
      if (!activeRows.length) {
        throw new Error("No active employees in the current view.");
      }
      const activeSummary = {
        metTarget: activeRows.filter((r) => r.metTarget).length,
        underTarget: activeRows.filter((r) => !r.metTarget).length,
        critical: activeRows.filter((r) => r.status === "critical").length,
        atRisk: activeRows.filter((r) => r.status === "at_risk").length,
        behind: activeRows.filter((r) => r.status === "behind").length,
      };
      return getWeeklyPacingInsights({
        data: {
          report: {
            company: report.company,
            targetHours: report.targetHours,
            timeZone: report.timeZone,
            timeZoneLabel: report.timeZoneLabel,
            today: report.today,
            week: report.week,
            pacingSampleDays: report.pacingSampleDays,
            elapsedWorkDays: report.elapsedWorkDays,
            totalWorkDays: report.totalWorkDays,
            remainingWorkDays: report.remainingWorkDays,
            generatedAt: report.generatedAt,
            warnings: report.warnings,
          },
          summary: activeSummary,
          filterSummary,
          rows: activeRows,
          trend: trendQ.data ?? null,
        },
      });
    },
    onSuccess: (r) => {
      setInsightsMd(r.insightsMd);
      toast.success("AI insights ready");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const activeOverrideM = useMutation({
    mutationFn: (vars: { employeeId: string; email: string; name: string; active: boolean }) =>
      setWeeklyPacingActiveOverride({ data: vars }),
    onSuccess: (_r, vars) => {
      void queryClient.invalidateQueries({ queryKey: ["weekly-pacing-report"] });
      void queryClient.invalidateQueries({ queryKey: ["weekly-hours-trend"] });
      toast.success(`${vars.name} → Active ${formatActiveLabel(vars.active)} (saved to S3)`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function applyWeek() {
    navigate({
      to: "/time-dashboard/pacing",
      search: { day: day !== defaultDay ? day : undefined },
    });
  }

  function applySort(field: WeeklyPacingSortField) {
    if (sortBy === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortDir(field === "name" ? "asc" : "desc");
    }
  }

  function sortHeaderClass(field: WeeklyPacingSortField): string {
    return sortBy === field ? "text-foreground" : "text-muted-foreground";
  }

  function SortIcon({ field }: { field: WeeklyPacingSortField }) {
    if (sortBy !== field) return null;
    return sortDir === "asc" ? (
      <ArrowUpAZ className="h-3 w-3" />
    ) : (
      <ArrowDownAZ className="h-3 w-3" />
    );
  }

  function exportPdf() {
    if (!report || !rows.length) return;
    setPdfLoading(true);
    try {
      downloadWeeklyPacingPdf({
        report,
        rows,
        filterSummary,
        filename: `${exportFilenameBase}.pdf`,
      });
      toast.success(`PDF downloaded (${rows.length} employee${rows.length === 1 ? "" : "s"})`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to build PDF");
    } finally {
      setPdfLoading(false);
    }
  }

  function exportCsv() {
    if (!report || !rows.length) return;
    downloadCSV(
      `${exportFilenameBase}.csv`,
      rows.map((r) => ({
        email: r.email,
        name: r.name,
        location: r.location ?? "",
        team: r.team ?? "",
        manager_name: r.managerName ?? "",
        manager_email: r.managerEmail ?? "",
        hours_worked: r.hoursWorked.toFixed(2),
        avg_daily_pace_mon_thu: r.avgDailyPace.toFixed(2),
        projected_pace: r.projectedPace.toFixed(2),
        pace_vs_target: r.paceDelta.toFixed(2),
        hours_remaining: r.hoursRemaining.toFixed(2),
        hours_over_target: r.hoursOver.toFixed(2),
        pace_delta: r.paceDelta.toFixed(2),
        remaining_work_days: r.remainingWorkDays,
        required_hours_per_day: r.requiredHoursPerDay.toFixed(2),
        active: formatActiveLabel(r.active),
        status: PACING_STATUS_LABEL[r.status],
      })),
    );
    toast.success(`CSV downloaded (${rows.length} employee${rows.length === 1 ? "" : "s"})`);
  }

  function clearFacetFilters() {
    setLocationFilter("__all__");
    setTeamFilter("__all__");
    setActiveFilter("__all__");
  }

  if (!canAccess) {
    return <TimeDashboardGate />;
  }

  return (
    <div className="ops-dense">
      <PageHeader
        eyebrow="People"
        title="Weekly Pacing Report"
        description={
          report
            ? `${report.company.name} · Week ${weekLabel} (${report.timeZoneLabel})${isHistoricalWeek ? ` · as of ${asOfLabel}` : ""} · Target ${report.targetHours}h/week · ${filteredRows.length}${hasAnyFilters ? `/${allRows.length}` : ""} employees${filterSummary ? ` · ${filterSummary}` : ""} · ${summary?.metTarget ?? 0} met target`
            : "Loading weekly pacing from Time Doctor…"
        }
        dense
        actions={
          <>
            <Link
              to="/time-dashboard"
              search={{ start: undefined, end: undefined }}
              className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Time Dashboard
            </Link>
            <button
              onClick={() => {
                if (draftMatchesApplied) {
                  void q.refetch();
                  void trendQ.refetch();
                } else {
                  applyWeek();
                }
              }}
              disabled={q.isFetching || trendQ.isFetching}
              className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${q.isFetching || trendQ.isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
            <button
              onClick={exportPdf}
              disabled={!rows.length || q.isFetching || pdfLoading}
              className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
              title="Download PDF for filtered employees only"
            >
              <FileText className="h-3.5 w-3.5" />
              {pdfLoading ? "Building PDF…" : "Export PDF"}
            </button>
            <button
              onClick={exportCsv}
              disabled={!rows.length || q.isFetching}
              className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
              title="Download CSV for filtered employees only"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
          </>
        }
      />

      <div className="px-5 md:px-8 py-6 space-y-5">
        <FetchingBar active={q.isFetching && !q.data} />

        {q.isError ? (
          <div className="surface-card p-4 text-sm text-destructive">
            {q.error instanceof Error ? q.error.message : "Failed to load pacing report"}
          </div>
        ) : null}

        {report ? (
          <>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <WeeklyPacingWeekPicker
                  day={day}
                  onDayChange={setDay}
                  onApply={applyWeek}
                  isBusy={isBusy}
                  draftMatchesApplied={draftMatchesApplied}
                />
                <div className="relative w-full sm:max-w-xs">
                  <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  <input
                    value={searchQ}
                    onChange={(e) => setSearchQ(e.target.value)}
                    placeholder="Search name, email, location, team…"
                    className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-background text-[13px]"
                  />
                </div>
              </div>
            </div>

            <WeeklyPacingTrendPanel
              trend={trendQ.data}
              trendError={trendQ.isError ? (trendQ.error as Error) : null}
              isTrendLoading={isTrendLoading}
              isTrendRefetching={isTrendRefetching}
              locationFilter={locationFilter}
              teamFilter={teamFilter}
              activeFilter={activeFilter}
              onLocationFilter={setLocationFilter}
              onTeamFilter={setTeamFilter}
              onActiveFilter={setActiveFilter}
              onClearFilters={clearFacetFilters}
              locationOptions={locationOptions}
              teamOptions={teamOptions}
              filteredEmployeeCount={filteredRows.length}
              totalEmployeeCount={allRows.length}
            />

            {isHistoricalWeek ? (
              <p className="text-[12px] text-muted-foreground">
                Viewing a past week — metrics are frozen as of <strong>{asOfLabel}</strong> (Friday snapshot for completed weeks).
              </p>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="surface-card p-4">
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide">Target met</div>
                <div className="text-2xl font-semibold mt-1 text-emerald-700 dark:text-emerald-300">
                  {summary?.metTarget ?? 0}
                </div>
                <div className="text-[11px] text-muted-foreground mt-1">≥ {report.targetHours}h this week</div>
              </div>
              <div className="surface-card p-4">
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide">Under target</div>
                <div className="text-2xl font-semibold mt-1">{summary?.underTarget ?? 0}</div>
              </div>
              <div className="surface-card p-4">
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide">Week progress</div>
                <div className="text-2xl font-semibold mt-1">
                  {report.elapsedWorkDays}/{report.totalWorkDays} workdays
                </div>
                <div className="text-[11px] text-muted-foreground mt-1">
                  {report.remainingWorkDays} workday{report.remainingWorkDays === 1 ? "" : "s"} left
                </div>
              </div>
              <div className="surface-card p-4">
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide">Needs attention</div>
                <div className="text-2xl font-semibold mt-1 flex items-center gap-2">
                  <TrendingDown className="h-5 w-5 text-orange-600" />
                  {(summary?.critical ?? 0) + (summary?.atRisk ?? 0)}
                </div>
                <div className="text-[11px] text-muted-foreground mt-1">
                  {summary?.critical ?? 0} critical · {summary?.atRisk ?? 0} at risk · {summary?.behind ?? 0} behind
                </div>
              </div>
            </div>

            <p className="text-[12px] text-muted-foreground leading-relaxed max-w-4xl">
              <strong>Hours</strong> = logged so far (includes Friday on Fri). <strong>Pace</strong> = Mon–Thu total + Mon–Thu average.
              Mon–Thu example: <strong>7h</strong> → <strong>14h</strong>. Friday: compare actual hours vs Mon–Thu projection (e.g. worked <strong>40.79h</strong>, pace <strong>46.70h</strong>).
              {" "}<strong className="text-emerald-700 dark:text-emerald-300">Green rows</strong> have already reached {report.targetHours}h.
            </p>

            {report.warnings.length ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-900 dark:text-amber-200">
                {report.warnings.map((w) => (
                  <div key={w}>• {w}</div>
                ))}
              </div>
            ) : null}

            <div className="surface-card p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-medium text-[13px] flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5" />
                    AI insights
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5 max-w-2xl">
                    In-depth report: trend vs last week &amp; baseline, location/team/manager breakdowns,
                    every active employee by status, recovery math, and action items. Inactive/resigned excluded.
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {insightsMd ? (
                    <button
                      type="button"
                      onClick={async () => {
                        if (!insightsMd.trim()) return toast.error("Nothing to copy");
                        try {
                          await navigator.clipboard.writeText(insightsMd);
                          toast.success("Report copied");
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : "Failed to copy");
                        }
                      }}
                      className="h-8 w-8 grid place-items-center rounded-md border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted/40"
                      title="Copy report"
                      aria-label="Copy report"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => insightsM.mutate()}
                    disabled={insightsM.isPending || filteredRows.filter((r) => r.active).length === 0}
                    className="h-8 px-3 rounded-md bg-foreground text-background text-[11.5px] font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {insightsM.isPending ? "Generating report…" : "Generate full report"}
                  </button>
                </div>
              </div>
              {insightsM.isPending ? (
                <div className="border-t border-border pt-4 space-y-2">
                  <div className="text-[12px] text-muted-foreground animate-pulse">
                    Building executive summary, trend analysis, location/team breakdowns, and employee deep dives…
                  </div>
                  <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                    <div className="h-full w-1/3 rounded-full bg-foreground/40 animate-pulse" />
                  </div>
                </div>
              ) : null}
              {insightsMd ? (
                <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] whitespace-pre-wrap border-t border-border pt-4 leading-relaxed">
                  {insightsMd}
                </div>
              ) : !insightsM.isPending ? (
                <div className="text-[12px] text-muted-foreground border-t border-border pt-3">
                  No report yet — analyzes {filteredRows.filter((r) => r.active).length} active employee
                  {filteredRows.filter((r) => r.active).length === 1 ? "" : "s"}. Click Generate for the full breakdown.
                </div>
              ) : null}
            </div>

            <TableScroll>
              <div className="surface-card overflow-hidden min-w-[1700px]">
                <table className="ops-table w-full">
                  <thead>
                    <tr>
                      <th align="left">
                        <button
                          type="button"
                          onClick={() => applySort("name")}
                          className={`inline-flex items-center gap-1 font-medium hover:text-foreground ${sortHeaderClass("name")}`}
                        >
                          Employee
                          <SortIcon field="name" />
                        </button>
                      </th>
                      <th align="left">
                        <button
                          type="button"
                          onClick={() => applySort("location")}
                          className={`inline-flex items-center gap-1 font-medium hover:text-foreground ${sortHeaderClass("location")}`}
                        >
                          Location
                          <SortIcon field="location" />
                        </button>
                      </th>
                      <th align="left">
                        <button
                          type="button"
                          onClick={() => applySort("team")}
                          className={`inline-flex items-center gap-1 font-medium hover:text-foreground ${sortHeaderClass("team")}`}
                        >
                          Team
                          <SortIcon field="team" />
                        </button>
                      </th>
                      <th align="left">
                        <button
                          type="button"
                          onClick={() => applySort("managerName")}
                          className={`inline-flex items-center gap-1 font-medium hover:text-foreground ${sortHeaderClass("managerName")}`}
                        >
                          Manager
                          <SortIcon field="managerName" />
                        </button>
                      </th>
                      <th align="right">
                        <button
                          type="button"
                          onClick={() => applySort("hoursWorked")}
                          className={`inline-flex items-center gap-1 ml-auto font-medium hover:text-foreground ${sortHeaderClass("hoursWorked")}`}
                        >
                          Worked
                          <SortIcon field="hoursWorked" />
                        </button>
                      </th>
                      <th align="right">
                        <button
                          type="button"
                          onClick={() => applySort("avgDailyPace")}
                          className={`inline-flex items-center gap-1 ml-auto font-medium hover:text-foreground ${sortHeaderClass("avgDailyPace")}`}
                          title="Average daily hours Mon–Thu"
                        >
                          Avg/day
                          <SortIcon field="avgDailyPace" />
                        </button>
                      </th>
                      <th align="right">
                        <button
                          type="button"
                          onClick={() => applySort("hoursRemaining")}
                          className={`inline-flex items-center gap-1 ml-auto font-medium hover:text-foreground ${sortHeaderClass("hoursRemaining")}`}
                        >
                          Remaining
                          <SortIcon field="hoursRemaining" />
                        </button>
                      </th>
                      <th align="right">
                        <button
                          type="button"
                          onClick={() => applySort("hoursOver")}
                          className={`inline-flex items-center gap-1 ml-auto font-medium hover:text-foreground ${sortHeaderClass("hoursOver")}`}
                        >
                          Over
                          <SortIcon field="hoursOver" />
                        </button>
                      </th>
                      <th align="right">
                        <button
                          type="button"
                          onClick={() => applySort("projectedPace")}
                          className={`inline-flex items-center gap-1 ml-auto font-medium hover:text-foreground ${sortHeaderClass("projectedPace")}`}
                          title={
                            report && isFridayOrLater(report.today, report.week.start)
                              ? "Mon–Thu total + Mon–Thu avg (compare to actual week hours)"
                              : "Hours + daily average (next workday)"
                          }
                        >
                          Pace
                          <SortIcon field="projectedPace" />
                        </button>
                      </th>
                      <th align="right">
                        <button
                          type="button"
                          onClick={() => applySort("remainingWorkDays")}
                          className={`inline-flex items-center gap-1 ml-auto font-medium hover:text-foreground ${sortHeaderClass("remainingWorkDays")}`}
                        >
                          Days left
                          <SortIcon field="remainingWorkDays" />
                        </button>
                      </th>
                      <th align="right">
                        <button
                          type="button"
                          onClick={() => applySort("requiredHoursPerDay")}
                          className={`inline-flex items-center gap-1 ml-auto font-medium hover:text-foreground ${sortHeaderClass("requiredHoursPerDay")}`}
                        >
                          Required/day
                          <SortIcon field="requiredHoursPerDay" />
                        </button>
                      </th>
                      <th align="left">
                        <button
                          type="button"
                          onClick={() => applySort("active")}
                          className={`inline-flex items-center gap-1 font-medium hover:text-foreground ${sortHeaderClass("active")}`}
                        >
                          Active
                          <SortIcon field="active" />
                        </button>
                        <div className="text-[10px] font-normal text-muted-foreground mt-0.5 normal-case tracking-normal">
                          Editable · saved in S3
                        </div>
                      </th>
                      <th align="left">
                        <button
                          type="button"
                          onClick={() => applySort("status")}
                          className={`inline-flex items-center gap-1 font-medium hover:text-foreground ${sortHeaderClass("status")}`}
                        >
                          Status
                          <SortIcon field="status" />
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={13} className="text-center text-muted-foreground py-8">
                          {searchQ.trim()
                            ? "No employees match your search."
                            : "No employees found for this week."}
                        </td>
                      </tr>
                    ) : (
                      rows.map((r) => (
                        <tr key={r.id} className={rowClass(r)}>
                          <td>
                            <div className="font-medium text-[13px]">{r.name}</div>
                            <div className="text-[11px] text-muted-foreground">{r.email}</div>
                          </td>
                          <td className="text-[13px]">{r.location || "—"}</td>
                          <td className="text-[13px]">{r.team || "—"}</td>
                          <td>
                            <div className="text-[13px]">{r.managerName || "—"}</div>
                            {r.managerEmail ? (
                              <div className="text-[11px] text-muted-foreground">{r.managerEmail}</div>
                            ) : null}
                          </td>
                          <td
                            align="right"
                            className={`font-mono tabular-nums ${r.metTarget ? "font-semibold text-emerald-700 dark:text-emerald-300" : ""}`}
                          >
                            {r.hoursWorked.toFixed(2)}h
                          </td>
                          <td align="right" className="font-mono tabular-nums text-muted-foreground">
                            {r.avgDailyPace.toFixed(2)}h
                          </td>
                          <td align="right" className="font-mono tabular-nums font-medium">
                            {r.metTarget ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              `${r.hoursRemaining.toFixed(2)}h`
                            )}
                          </td>
                          <td align="right" className="font-mono tabular-nums">
                            {r.hoursOver > 0 ? (
                              <span className="font-medium text-emerald-700 dark:text-emerald-300">
                                +{r.hoursOver.toFixed(2)}h
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td
                            align="right"
                            className={`font-mono tabular-nums font-semibold ${r.projectedPace >= (report?.targetHours ?? 35) ? "text-emerald-700 dark:text-emerald-300" : "text-orange-700 dark:text-orange-300"}`}
                            title={
                              report && isFridayOrLater(report.today, report.week.start)
                                ? `Mon–Thu projection · worked ${r.hoursWorked.toFixed(2)}h · ${r.paceDelta >= 0 ? "+" : ""}${r.paceDelta.toFixed(2)}h vs ${report.targetHours}h`
                                : `${r.paceDelta >= 0 ? "+" : ""}${r.paceDelta.toFixed(2)}h vs ${report?.targetHours ?? 35}h target`
                            }
                          >
                            {r.projectedPace.toFixed(2)}h
                          </td>
                          <td align="right" className="font-mono tabular-nums text-muted-foreground">
                            {r.metTarget ? "—" : r.remainingWorkDays}
                          </td>
                          <td align="right" className="font-mono tabular-nums font-medium">
                            {r.metTarget ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              `${r.requiredHoursPerDay.toFixed(2)}h`
                            )}
                          </td>
                          <td className="relative" onClick={(e) => e.stopPropagation()}>
                            <ActiveStatusEditor
                              row={r}
                              disabled={activeOverrideM.isPending}
                              onConfirmChange={(next) =>
                                activeOverrideM.mutate({
                                  employeeId: r.id,
                                  email: r.email,
                                  name: r.name,
                                  active: next,
                                })
                              }
                            />
                          </td>
                          <td>
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusClass(r.status)}`}
                            >
                              {PACING_STATUS_LABEL[r.status]}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </TableScroll>
          </>
        ) : null}
      </div>
    </div>
  );
}
