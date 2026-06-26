import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownAZ,
  ArrowLeft,
  ArrowUpAZ,
  Calendar,
  Download,
  MapPin,
  RefreshCw,
  Search,
  TrendingDown,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { PageHeader, TableScroll } from "@/components/AppShell";
import { FetchingBar } from "@/components/Skeleton";
import { TimeDashboardGate } from "@/components/TimeDashboardGate";
import { MonthlyPacingMonthPicker } from "@/components/MonthlyPacingMonthPicker";
import { WeeklyPacingActiveCell } from "@/components/WeeklyPacingActiveCell";
import { downloadCSV } from "@/lib/csv";
import { fmtDate } from "@/lib/format";
import { pacingTodayIso } from "@/lib/weekly-pacing";
import { monthYearFromIso, isPastMonth } from "@/lib/monthly-pacing";
import { useAuth } from "@/lib/auth";
import {
  buildLeaveSummaryFromRows,
  filterPacingRows,
  formatActiveLabel,
  formatLeaveBreakdown,
  pacingFilterExportSlug,
  pacingFilterSummaryLabel,
  PACING_LEAVE_HOURS_PER_DAY,
  PACING_STATUS_LABEL,
  sortPacingRows,
  type WeeklyPacingRow,
  type WeeklyPacingSortField,
  type WeeklyPacingStatus,
} from "@/lib/weekly-pacing";
import {
  fetchMonthlyPacingReport,
  setWeeklyPacingActiveOverride,
} from "@/lib/time-doctor-pacing-functions";

export const Route = createFileRoute("/time-dashboard/monthly-pacing")({
  head: () => ({ meta: [{ title: "Monthly Pacing — Alyson HR" }] }),
  validateSearch: z
    .object({
      month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    })
    .parse,
  component: MonthlyPacingPage,
});

const QUICK_LOCATIONS = ["Pune", "Lahore", "Bahawalpur"] as const;

function filterLabel(value: string, kind: "location" | "team"): string {
  if (value === "__all__") return kind === "location" ? "All locations" : "All teams";
  if (value === "__empty__") return kind === "location" ? "No location" : "No team";
  return value;
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-8 px-3 rounded-full border text-[12px] font-medium transition-all duration-200 ${
        active
          ? "border-primary bg-primary text-primary-foreground shadow-sm scale-[1.02]"
          : "border-border bg-background text-muted-foreground hover:border-foreground/25 hover:text-foreground hover:bg-muted/40"
      }`}
    >
      {children}
    </button>
  );
}

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
  if (row.leaveDays > 0) return "bg-sky-500/[0.05] hover:bg-sky-500/10";
  return "hover:bg-muted/30";
}

function MonthlyPacingPage() {
  const auth = useAuth();
  const canAccess = auth.canAccessTimeDashboard;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = Route.useSearch();
  const today = pacingTodayIso();
  const defaultMonth = monthYearFromIso(today);

  const [sortBy, setSortBy] = useState<WeeklyPacingSortField>("hoursRemaining");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [searchQ, setSearchQ] = useState("");
  const [locationFilter, setLocationFilter] = useState("__all__");
  const [teamFilter, setTeamFilter] = useState("__all__");
  const [activeFilter, setActiveFilter] = useState("__all__");
  const [month, setMonth] = useState(search.month ?? defaultMonth);

  useEffect(() => {
    if (search.month) setMonth(search.month);
  }, [search.month]);

  const appliedMonth = search.month ?? defaultMonth;
  const draftMatchesApplied = month === appliedMonth;
  const isHistoricalMonth = isPastMonth(appliedMonth, today);

  const q = useQuery({
    queryKey: ["monthly-pacing-report", appliedMonth],
    queryFn: () => fetchMonthlyPacingReport({ data: { month: appliedMonth } }),
    enabled: canAccess,
    placeholderData: keepPreviousData,
    staleTime: 120_000,
    refetchOnWindowFocus: false,
  });

  const activeM = useMutation({
    mutationFn: (payload: {
      employeeId: string;
      email: string;
      name: string;
      active: boolean;
    }) => setWeeklyPacingActiveOverride({ data: payload }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["monthly-pacing-report"] });
      void queryClient.invalidateQueries({ queryKey: ["weekly-pacing-report"] });
    },
  });

  const isBusy = q.isFetching;
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

  const filterSummary = useMemo(() => pacingFilterSummaryLabel(facetFilters), [facetFilters]);
  const hasAnyFilters =
    locationFilter !== "__all__" ||
    teamFilter !== "__all__" ||
    activeFilter !== "__all__" ||
    Boolean(searchQ.trim());

  const summary = useMemo(() => {
    let metTarget = 0;
    let underTarget = 0;
    let critical = 0;
    let atRisk = 0;
    let behind = 0;
    for (const r of filteredRows) {
      if (r.metTarget) metTarget += 1;
      else underTarget += 1;
      if (r.status === "critical") critical += 1;
      else if (r.status === "at_risk") atRisk += 1;
      else if (r.status === "behind") behind += 1;
    }
    return { metTarget, underTarget, critical, atRisk, behind };
  }, [filteredRows]);

  const leaveSummary = useMemo(() => {
    if (!report) return null;
    const base = buildLeaveSummaryFromRows(filteredRows);
    base.teamLeaveEvents = report.leaveSummary.teamLeaveEvents;
    return base;
  }, [filteredRows, report]);

  const extraLocations = useMemo(
    () =>
      locationOptions.filter(
        (opt) => opt !== "__empty__" && !QUICK_LOCATIONS.includes(opt as (typeof QUICK_LOCATIONS)[number]),
      ),
    [locationOptions],
  );

  const hasFacetFilters =
    locationFilter !== "__all__" || teamFilter !== "__all__" || activeFilter !== "__all__";

  function applyMonth() {
    navigate({
      to: "/time-dashboard/monthly-pacing",
      search: { month },
      replace: true,
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

  function clearFacetFilters() {
    setLocationFilter("__all__");
    setTeamFilter("__all__");
    setActiveFilter("__all__");
  }

  function exportCsv() {
    if (!report || !rows.length) return;
    const slug = pacingFilterExportSlug(facetFilters);
    const csvHeaders = [
      "email",
      "name",
      "location",
      "team",
      "manager_name",
      "manager_email",
      "hours_worked",
      "avg_daily_pace_mon_thu",
      "projected_pace",
      "pace_vs_target",
      "hours_remaining",
      "hours_over_target",
      "pace_delta",
      "remaining_work_days",
      "required_hours_per_day",
      "active",
      "status",
    ] as const;
    downloadCSV(
      `monthly-pacing-${appliedMonth}${slug ? `-${slug}` : ""}.csv`,
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
      [...csvHeaders],
    );
    toast.success(`CSV downloaded (${rows.length} employees)`);
  }

  if (!canAccess) return <TimeDashboardGate />;

  return (
    <div className="ops-dense">
      <PageHeader
        eyebrow="People"
        title="Monthly Pacing Report"
        description={
          report
            ? `${report.company.name} · ${report.month.label} (${report.timeZoneLabel}) · as of ${fmtDate(report.today)} · Target ${report.targetHours}h (${report.totalWorkDays} workdays × ${PACING_LEAVE_HOURS_PER_DAY}h) · ${filteredRows.length}${hasAnyFilters ? `/${allRows.length}` : ""} employees${filterSummary ? ` · ${filterSummary}` : ""} · ${summary.metTarget} met target`
            : "Loading monthly pacing from Time Doctor…"
        }
        dense
        actions={
          <>
            <Link
              to="/time-dashboard"
              className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Time Dashboard
            </Link>
            <Link
              to="/time-dashboard/pacing"
              className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted"
            >
              Weekly Pacing
            </Link>
            <button
              type="button"
              onClick={() => (draftMatchesApplied ? void q.refetch() : applyMonth())}
              disabled={isBusy}
              className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isBusy ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <button
              type="button"
              onClick={exportCsv}
              disabled={!rows.length || isBusy}
              className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
          </>
        }
      />

      <div className="px-5 md:px-8 py-6 space-y-5">
        <FetchingBar active={isBusy && !q.data} />

        {q.isError ? (
          <div className="surface-card p-4 text-sm text-destructive">
            {q.error instanceof Error ? q.error.message : "Failed to load monthly pacing"}
          </div>
        ) : null}

        {report ? (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <MonthlyPacingMonthPicker
                month={month}
                onMonthChange={setMonth}
                onApply={applyMonth}
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

            <div className="surface-card overflow-hidden border-b-0">
              <div className="border-b border-border bg-muted/20 px-4 py-3 md:px-5">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <h3 className="font-display text-base">Filters</h3>
                    <p className="text-[12px] text-muted-foreground mt-1 max-w-2xl">
                      Narrow the table by location, team, or active status. Click column headers to sort A–Z or Z–A.
                    </p>
                  </div>
                  <div className="text-[11px] text-muted-foreground tabular-nums text-right shrink-0">
                    <div>
                      <Users className="h-3.5 w-3.5 inline -mt-0.5 mr-1" />
                      {filteredRows.length}
                      {hasFacetFilters ? ` of ${allRows.length}` : ""} in table
                    </div>
                  </div>
                </div>

                <div className="mt-4 space-y-3">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                      <MapPin className="h-3 w-3" />
                      Location
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <FilterPill active={locationFilter === "__all__"} onClick={() => setLocationFilter("__all__")}>
                        All
                      </FilterPill>
                      {QUICK_LOCATIONS.map((loc) =>
                        locationOptions.includes(loc) ? (
                          <FilterPill
                            key={loc}
                            active={locationFilter === loc}
                            onClick={() => setLocationFilter(locationFilter === loc ? "__all__" : loc)}
                          >
                            {loc}
                          </FilterPill>
                        ) : null,
                      )}
                      {extraLocations.length > 0 ? (
                        <select
                          value={extraLocations.includes(locationFilter) ? locationFilter : ""}
                          onChange={(e) => setLocationFilter(e.target.value || "__all__")}
                          className={`h-8 min-w-[8rem] px-2.5 rounded-full border text-[12px] bg-background ${
                            extraLocations.includes(locationFilter)
                              ? "border-primary text-foreground"
                              : "border-border text-muted-foreground"
                          }`}
                        >
                          <option value="">More locations…</option>
                          {extraLocations.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      {locationOptions.includes("__empty__") ? (
                        <FilterPill
                          active={locationFilter === "__empty__"}
                          onClick={() =>
                            setLocationFilter(locationFilter === "__empty__" ? "__all__" : "__empty__")
                          }
                        >
                          No location
                        </FilterPill>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                    <div className="flex flex-col gap-2 min-w-[12rem]">
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                        Team
                      </div>
                      <select
                        value={teamFilter}
                        onChange={(e) => setTeamFilter(e.target.value)}
                        className={`h-8 w-full sm:w-auto min-w-[12rem] px-3 rounded-lg border text-[12px] bg-background transition-colors ${
                          teamFilter !== "__all__" ? "border-primary" : "border-border"
                        }`}
                      >
                        <option value="__all__">All teams</option>
                        {teamOptions.map((opt) => (
                          <option key={opt} value={opt}>
                            {filterLabel(opt, "team")}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex flex-col gap-2">
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                        Active
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {(
                          [
                            ["__all__", "All"],
                            ["yes", "Active"],
                            ["no", "Inactive"],
                          ] as const
                        ).map(([value, label]) => (
                          <FilterPill
                            key={value}
                            active={activeFilter === value}
                            onClick={() => setActiveFilter(value)}
                          >
                            {label}
                          </FilterPill>
                        ))}
                      </div>
                    </div>

                    {hasFacetFilters ? (
                      <button
                        type="button"
                        onClick={clearFacetFilters}
                        className="h-8 px-3 rounded-lg border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 sm:ml-auto inline-flex items-center gap-1"
                      >
                        <X className="h-3 w-3" />
                        Clear all
                      </button>
                    ) : null}
                  </div>

                  {filterSummary ? (
                    <div className="text-[11px] text-muted-foreground">
                      Showing <span className="text-foreground font-medium">{filterSummary}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {isHistoricalMonth ? (
              <p className="text-[12px] text-muted-foreground">
                Viewing a completed month — metrics are frozen as of <strong>{fmtDate(report.today)}</strong>.
              </p>
            ) : (
              <p className="text-[12px] text-muted-foreground">
                Month-to-date through <strong>{fmtDate(report.today)}</strong> · projected pace = worked + avg daily
                hours × remaining workdays.
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="surface-card p-4">
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide">Target met</div>
                <div className="text-2xl font-semibold mt-1 text-emerald-700 dark:text-emerald-300">
                  {summary.metTarget}
                </div>
                <div className="text-[11px] text-muted-foreground mt-1">≥ {report.targetHours}h this month</div>
              </div>
              <div className="surface-card p-4">
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide">Under target</div>
                <div className="text-2xl font-semibold mt-1">{summary.underTarget}</div>
              </div>
              <div className="surface-card p-4">
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  On leave
                </div>
                <div className="text-2xl font-semibold mt-1 text-sky-700 dark:text-sky-300">
                  {leaveSummary?.employeesOnLeave ?? 0}
                </div>
                <div className="text-[11px] text-muted-foreground mt-1">
                  +{leaveSummary?.totalLeaveHoursCredit.toFixed(0) ?? 0}h credit ·{" "}
                  {leaveSummary?.totalLeaveDays ?? 0} leave day
                  {(leaveSummary?.totalLeaveDays ?? 0) === 1 ? "" : "s"}
                </div>
              </div>
              <div className="surface-card p-4">
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide">Month progress</div>
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
                  {summary.critical + summary.atRisk}
                </div>
                <div className="text-[11px] text-muted-foreground mt-1">
                  {summary.critical} critical · {summary.atRisk} at risk · {summary.behind} behind
                </div>
              </div>
            </div>

            {leaveSummary && (leaveSummary.employeesOnLeave > 0 || leaveSummary.teamLeaveEvents.length > 0) ? (
              <div className="surface-card p-4 space-y-3 border-sky-500/20 bg-sky-500/[0.03]">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-[13px] flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5 text-sky-700 dark:text-sky-300" />
                      Leave this month
                    </div>
                    <p className="text-[12px] text-muted-foreground mt-1 max-w-3xl">
                      From the{" "}
                      <Link to="/leave" className="text-foreground underline underline-offset-2">
                        Leave module
                      </Link>{" "}
                      — personal records and team/location leave. Each workday credits{" "}
                      <strong>+{PACING_LEAVE_HOURS_PER_DAY}h</strong> in Logged → Worked (see table columns).
                    </p>
                  </div>
                  <div className="text-[12px] text-muted-foreground shrink-0">
                    {leaveSummary.employeesWithPersonalLeave} personal · {leaveSummary.employeesWithTeamLeave} team
                  </div>
                </div>
                {leaveSummary.teamLeaveEvents.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {leaveSummary.teamLeaveEvents.map((ev) => (
                      <div
                        key={ev.id}
                        className="rounded-md border border-sky-500/25 bg-background px-2.5 py-1.5 text-[11px]"
                      >
                        <span className="font-medium text-sky-800 dark:text-sky-200">
                          {ev.teamLabel} · {ev.location}
                        </span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {fmtDate(ev.startDate)} – {fmtDate(ev.endDate)} · {ev.daysInWeek}d ({ev.leaveType})
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <p className="text-[12px] text-muted-foreground leading-relaxed max-w-4xl">
              <strong>Logged</strong> = Time Doctor hours only. <strong>Leave</strong> = workdays (personal + team).{" "}
              <strong>+Credit</strong> = leave × {PACING_LEAVE_HOURS_PER_DAY}h. <strong>Worked</strong> = logged + credit
              (used for target). <strong>Pace</strong> = worked + avg daily × remaining workdays.
              {" "}
              <strong className="text-emerald-700 dark:text-emerald-300">Green rows</strong> met {report.targetHours}h.
              {" "}
              <strong className="text-sky-700 dark:text-sky-300">Blue-tint rows</strong> include leave credit.
            </p>

            {report.warnings.length ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-900 dark:text-amber-200">
                {report.warnings.map((w) => (
                  <div key={w}>• {w}</div>
                ))}
              </div>
            ) : null}

            <TableScroll>
              <div className="surface-card min-w-[1700px]">
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
                          onClick={() => applySort("hoursWorkedLogged")}
                          className={`inline-flex items-center gap-1 ml-auto font-medium hover:text-foreground ${sortHeaderClass("hoursWorkedLogged")}`}
                          title="Time Doctor logged hours only"
                        >
                          Logged
                          <SortIcon field="hoursWorkedLogged" />
                        </button>
                      </th>
                      <th align="right">
                        <button
                          type="button"
                          onClick={() => applySort("leaveDays")}
                          className={`inline-flex items-center gap-1 ml-auto font-medium hover:text-foreground ${sortHeaderClass("leaveDays")}`}
                          title="Leave workdays (personal + team)"
                        >
                          Leave
                          <SortIcon field="leaveDays" />
                        </button>
                      </th>
                      <th align="right">
                        <button
                          type="button"
                          onClick={() => applySort("leaveHoursCredit")}
                          className={`inline-flex items-center gap-1 ml-auto font-medium hover:text-foreground ${sortHeaderClass("leaveHoursCredit")}`}
                          title={`Leave credit (+${PACING_LEAVE_HOURS_PER_DAY}h per workday)`}
                        >
                          +Credit
                          <SortIcon field="leaveHoursCredit" />
                        </button>
                      </th>
                      <th align="right">
                        <button
                          type="button"
                          onClick={() => applySort("hoursWorked")}
                          className={`inline-flex items-center gap-1 ml-auto font-medium hover:text-foreground ${sortHeaderClass("hoursWorked")}`}
                          title="Logged + leave credit — counts toward monthly target"
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
                          title="Average daily hours month-to-date"
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
                          title={`Projected month-end hours vs ${report.targetHours}h target`}
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
                        <td colSpan={16} className="text-center text-muted-foreground py-8">
                          {searchQ.trim()
                            ? "No employees match your search."
                            : "No employees found for this month."}
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
                          <td align="right" className="font-mono tabular-nums text-muted-foreground">
                            {r.hoursWorkedLogged.toFixed(2)}h
                          </td>
                          <td
                            align="right"
                            className="font-mono tabular-nums"
                            title={formatLeaveBreakdown(r)}
                          >
                            {r.leaveDays > 0 ? (
                              <>
                                <span className="font-medium text-sky-700 dark:text-sky-300">
                                  {r.leaveDays}d
                                </span>
                                <div className="text-[10px] text-muted-foreground font-normal max-w-[88px] ml-auto leading-tight">
                                  {formatLeaveBreakdown(r)}
                                </div>
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td align="right" className="font-mono tabular-nums">
                            {r.leaveHoursCredit > 0 ? (
                              <span className="font-medium text-sky-700 dark:text-sky-300">
                                +{r.leaveHoursCredit.toFixed(0)}h
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td
                            align="right"
                            className={`font-mono tabular-nums ${r.metTarget ? "font-semibold text-emerald-700 dark:text-emerald-300" : "font-medium"}`}
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
                            className={`font-mono tabular-nums font-semibold ${r.projectedPace >= report.targetHours ? "text-emerald-700 dark:text-emerald-300" : "text-orange-700 dark:text-orange-300"}`}
                            title={`${r.paceDelta >= 0 ? "+" : ""}${r.paceDelta.toFixed(2)}h vs ${report.targetHours}h target`}
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
                          <td className="relative z-10 isolate" onClick={(e) => e.stopPropagation()}>
                            <WeeklyPacingActiveCell
                              row={r}
                              disabled={activeM.isPending}
                              onConfirmChange={(active) =>
                                activeM.mutate({
                                  employeeId: r.id,
                                  email: r.email,
                                  name: r.name,
                                  active,
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
