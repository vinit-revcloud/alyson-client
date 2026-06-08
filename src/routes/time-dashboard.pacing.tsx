import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { PageHeader, TableScroll } from "@/components/AppShell";
import { FetchingBar } from "@/components/Skeleton";
import { TimeDashboardGate } from "@/components/TimeDashboardGate";
import { WeeklyPacingWeekPicker } from "@/components/WeeklyPacingWeekPicker";
import { fetchWeeklyPacingReport } from "@/lib/time-doctor-functions";
import { formatRangeLabel, isIsoDate } from "@/lib/time-dashboard-range";
import {
  filterPacingRows,
  isFridayOrLater,
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
import { ArrowDownAZ, ArrowLeft, ArrowUpAZ, Download, FileText, RefreshCw, Search, TrendingDown } from "lucide-react";
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

function WeeklyPacingPage() {
  const auth = useAuth();
  const canAccess = auth.canAccessTimeDashboard;
  const navigate = useNavigate();
  const search = Route.useSearch();
  const defaultDay = pacingTodayIso();

  const [sortBy, setSortBy] = useState<WeeklyPacingSortField>("hoursRemaining");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [pdfLoading, setPdfLoading] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [day, setDay] = useState(search.day ?? defaultDay);

  useEffect(() => {
    if (search.day) setDay(search.day);
  }, [search.day]);

  const appliedDay = search.day ?? defaultDay;
  const rollupDay = useMemo(() => resolvePacingRollupDay(appliedDay), [appliedDay]);
  const isHistoricalWeek = weekStartIso(appliedDay) < weekStartIso(defaultDay);

  const q = useQuery({
    queryKey: ["weekly-pacing-report", rollupDay],
    queryFn: () => fetchWeeklyPacingReport({ data: { targetHours: 35, day: rollupDay } }),
    enabled: canAccess,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const draftMatchesApplied = day === appliedDay;
  const isBusy = q.isFetching;

  const report = q.data;
  const allRows = report?.rows ?? [];

  const filteredRows = useMemo(
    () => filterPacingRows(allRows, searchQ),
    [allRows, searchQ],
  );

  const rows = useMemo(
    () => sortPacingRows(filteredRows, sortBy, sortDir),
    [filteredRows, sortBy, sortDir],
  );

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
      downloadWeeklyPacingPdf({ report, rows });
      toast.success("Weekly pacing PDF downloaded");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to build PDF");
    } finally {
      setPdfLoading(false);
    }
  }

  function exportCsv() {
    if (!report) return;
    downloadCSV(
      `weekly-pacing-${report.week.start}-to-${report.today}.csv`,
      rows.map((r) => ({
        email: r.email,
        name: r.name,
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
            ? `${report.company.name} · Week ${weekLabel} (${report.timeZoneLabel})${isHistoricalWeek ? ` · as of ${asOfLabel}` : ""} · Target ${report.targetHours}h/week · ${filteredRows.length}${searchQ.trim() ? `/${allRows.length}` : ""} employees · ${summary?.metTarget ?? 0} met target`
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
              onClick={() => (draftMatchesApplied ? q.refetch() : applyWeek())}
              disabled={q.isFetching}
              className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <button
              onClick={exportPdf}
              disabled={!rows.length || q.isFetching || pdfLoading}
              className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
              title="Download PDF with green/red row colors by status"
            >
              <FileText className="h-3.5 w-3.5" />
              {pdfLoading ? "Building PDF…" : "Export PDF"}
            </button>
            <button
              onClick={exportCsv}
              disabled={!rows.length || q.isFetching}
              className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
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
                  placeholder="Search name, email, or manager…"
                  className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-background text-[13px]"
                />
              </div>
            </div>

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

            <TableScroll>
              <div className="surface-card overflow-hidden min-w-[1500px]">
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
                        <td colSpan={11} className="text-center text-muted-foreground py-8">
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
                          <td>
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                r.active
                                  ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200"
                                  : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {formatActiveLabel(r.active)}
                            </span>
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
