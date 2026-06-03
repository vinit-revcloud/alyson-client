import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { PageHeader, TableScroll, EmptyState } from "@/components/AppShell";
import { FetchingBar, TimeDashboardTableSkeleton } from "@/components/Skeleton";
import { TimeDashboardRangePicker } from "@/components/TimeDashboardRangePicker";
import { fetchTimeDoctorEmployeesTable, fetchTimeDoctorMonthlyUnderHoursReport, type TimeDoctorEmployeeRow } from "@/lib/time-doctor-functions";
import { downloadTimeDoctorUnderHoursPdf } from "@/lib/time-doctor-under-hours-pdf";
import {
  defaultListRange,
  formatRangeLabel,
  isIsoDate,
} from "@/lib/time-dashboard-range";
import { ArrowDownAZ, ArrowUpAZ, Clock, Download, FileText, Loader2, RefreshCw } from "lucide-react";
import { downloadCSV } from "@/lib/csv";
import { toast } from "sonner";
import { z } from "zod";
import { useAuth } from "@/lib/auth";
import { TimeDashboardGate } from "@/components/TimeDashboardGate";
import { medalRowClass, rankCellContent, timeDashboardRank } from "@/lib/rank-medals";

export const Route = createFileRoute("/time-dashboard")({
  head: () => ({ meta: [{ title: "Time Dashboard — Alyson HR" }] }),
  validateSearch: z
    .object({
      start: z.string().optional(),
      end: z.string().optional(),
    })
    .transform((s) => ({
      start: isIsoDate(s.start) ? s.start : undefined,
      end: isIsoDate(s.end) ? s.end : undefined,
    }))
    .parse,
  component: TimeDashboardPage,
});

export type TimeDashboardSortField = "range" | "daily" | "weekly" | "monthly" | "name";

const SORT_OPTIONS: Array<{ key: TimeDashboardSortField; label: string }> = [
  { key: "range", label: "Period" },
  { key: "daily", label: "Today" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Cal. month" },
  { key: "name", label: "Name" },
];

function TimeDashboardPage() {
  const auth = useAuth();
  const canAccess = auth.canAccessTimeDashboard;

  const [q, setQ] = useState("");
  const [sortBy, setSortBy] = useState<TimeDashboardSortField>("range");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [underHoursMonth, setUnderHoursMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [underHoursPdfLoading, setUnderHoursPdfLoading] = useState(false);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const showingUserDetail = pathname.startsWith("/time-dashboard/") && pathname !== "/time-dashboard";

  const search = Route.useSearch();
  const listDefaults = useMemo(() => defaultListRange(), []);

  const [start, setStart] = useState(search.start ?? listDefaults.start);
  const [end, setEnd] = useState(search.end ?? listDefaults.end);

  useEffect(() => {
    if (search.start) setStart(search.start);
    if (search.end) setEnd(search.end);
  }, [search.start, search.end]);

  const appliedStart = search.start ?? listDefaults.start;
  const appliedEnd = search.end ?? listDefaults.end;
  const rangeLabel = formatRangeLabel(appliedStart, appliedEnd);

  const table = useQuery({
    queryKey: ["time-doctor-employees-table", appliedStart, appliedEnd],
    queryFn: () =>
      fetchTimeDoctorEmployeesTable({
        data: { start: appliedStart, end: appliedEnd },
      }),
    enabled: canAccess,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const draftMatchesApplied = start === appliedStart && end === appliedEnd;
  const isBusy = table.isFetching;
  const showingStaleRange = table.isPlaceholderData && isBusy;
  const coldLoad = table.isPending && !table.data;

  const data = table.data as
    | {
        company: { id: string; name: string; timeZone?: string; timeZoneLabel?: string };
        day: string;
        timeZone?: string;
        timeZoneLabel?: string;
        range?: { start: string; end: string };
        warnings: string[];
        employees: TimeDoctorEmployeeRow[];
      }
    | undefined;
  const employees = data?.employees ?? [];
  const activeRange = data?.range ?? { start: appliedStart, end: appliedEnd };

  const filteredRollups = useMemo(() => {
    const normalizedQ = q.trim().toLowerCase();
    return employees
      .map((e) => ({
        employee_id: e.id,
        name: e.name,
        email: e.email,
        dailySeconds: e.dailySeconds ?? 0,
        weeklySeconds: e.weeklySeconds ?? 0,
        monthlySeconds: e.monthlySeconds ?? 0,
        rangeSeconds: e.rangeSeconds ?? 0,
      }))
      .filter((r) => {
        if (!normalizedQ) return true;
        return r.name.toLowerCase().includes(normalizedQ) || r.email.toLowerCase().includes(normalizedQ);
      });
  }, [employees, q]);

  const sortValue = (r: (typeof filteredRollups)[number]) => {
    switch (sortBy) {
      case "daily":
        return r.dailySeconds;
      case "weekly":
        return r.weeklySeconds;
      case "monthly":
        return r.monthlySeconds;
      case "name":
        return r.name.toLowerCase();
      default:
        return r.rangeSeconds;
    }
  };

  const employeeRollups = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filteredRollups].sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      if (typeof av === "string" && typeof bv === "string") {
        return av.localeCompare(bv) * dir;
      }
      return ((av as number) - (bv as number)) * dir;
    });
  }, [filteredRollups, sortBy, sortDir]);

  const rankByEmployeeId = useMemo(
    () => timeDashboardRank(employeeRollups),
    [employeeRollups],
  );

  const medalSortLabel =
    sortBy === "name"
      ? "period hours"
      : SORT_OPTIONS.find((s) => s.key === sortBy)?.label.toLowerCase() ?? "period";

  const applySort = (field: TimeDashboardSortField) => {
    if (sortBy === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(field);
    setSortDir(field === "name" ? "asc" : "desc");
  };

  const sortHeaderClass = (field: TimeDashboardSortField) =>
    sortBy === field ? "text-foreground" : "text-muted-foreground";

  const totalRangeHours = useMemo(
    () => employeeRollups.reduce((s, e) => s + (e.rangeSeconds ?? 0), 0) / 3600,
    [employeeRollups],
  );

  useEffect(() => {
    if (!canAccess) return;
    if (typeof window === "undefined") return;
    const all = employeeRollups.map((e) => ({
      employee_id: e.employee_id,
      name: e.name,
      email: e.email,
      daily_hours: Number(((e.dailySeconds ?? 0) / 3600).toFixed(2)),
      weekly_hours: Number(((e.weeklySeconds ?? 0) / 3600).toFixed(2)),
      monthly_hours: Number(((e.monthlySeconds ?? 0) / 3600).toFixed(2)),
      range_hours: Number(((e.rangeSeconds ?? 0) / 3600).toFixed(2)),
    }));

    (window as any).__ALYSON_MINI_CONTEXT__ = {
      module: "time-dashboard",
      range: activeRange,
      company: data?.company?.name ?? "",
      total_hours_in_range: Number(totalRangeHours.toFixed(2)),
      employees_all: all,
      employees_total: all.length,
      generated_at: new Date().toISOString(),
    };
    return () => {
      const cur = (window as any).__ALYSON_MINI_CONTEXT__;
      if (cur?.module === "time-dashboard") (window as any).__ALYSON_MINI_CONTEXT__ = undefined;
    };
  }, [canAccess, employeeRollups, totalRangeHours, activeRange, data?.company?.name]);

  useEffect(() => {
    if (data?.day) setUnderHoursMonth(data.day.slice(0, 7));
  }, [data?.day]);

  const exportUnderHoursPdf = async () => {
    if (!underHoursMonth) return toast.error("Pick a month");
    setUnderHoursPdfLoading(true);
    try {
      const report = await fetchTimeDoctorMonthlyUnderHoursReport({
        data: { month: underHoursMonth, thresholdHours: 35 },
      });
      downloadTimeDoctorUnderHoursPdf(report);
      toast.success(`Under 35h weekly PDF downloaded (${report.monthLabel})`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to generate PDF");
    } finally {
      setUnderHoursPdfLoading(false);
    }
  };

  const exportCsv = () => {
    if (!employeeRollups.length || showingStaleRange) {
      return toast.error(showingStaleRange ? "Wait for the new range to finish loading" : "No employees to export");
    }
    downloadCSV(`time-dashboard-${activeRange.start}-${activeRange.end}.csv`, employeeRollups.map((e) => {
      const rank = rankByEmployeeId.get(e.employee_id);
      const medal = rank === 1 ? "Gold" : rank === 2 ? "Silver" : rank === 3 ? "Bronze" : "";
      return {
      employee: e.name,
      email: e.email,
      medal,
      range_hours: ((e.rangeSeconds ?? 0) / 3600).toFixed(2),
      daily_hours: ((e.dailySeconds ?? 0) / 3600).toFixed(2),
      weekly_hours: ((e.weeklySeconds ?? 0) / 3600).toFixed(2),
      calendar_month_hours: ((e.monthlySeconds ?? 0) / 3600).toFixed(2),
    };
    }));
    toast.success("Time dashboard exported");
  };

  const applyRange = () => {
    if (!isIsoDate(start) || !isIsoDate(end)) {
      toast.error("Enter valid start and end dates");
      return;
    }
    if (start > end) {
      toast.error("Start date must be on or before end date");
      return;
    }
    if (start === appliedStart && end === appliedEnd) {
      void table.refetch();
      return;
    }
    navigate({ to: "/time-dashboard", search: { start, end }, replace: true });
  };

  const lastToastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!table.isSuccess || table.isPlaceholderData || !table.data) return;
    const key = `${appliedStart}:${appliedEnd}`;
    if (lastToastKey.current === key) return;
    if (lastToastKey.current !== null) {
      toast.success("Time Dashboard updated");
    }
    lastToastKey.current = key;
  }, [table.isSuccess, table.isPlaceholderData, table.data, appliedStart, appliedEnd]);

  const detailSearch = {
    start: isIsoDate(appliedStart) ? appliedStart : undefined,
    end: isIsoDate(appliedEnd) ? appliedEnd : undefined,
  };

  const statusBanner = (() => {
    if (coldLoad) {
      return {
        tone: "loading" as const,
        text: "Loading Time Doctor data — fetching worklogs for your team. This can take 30–60 seconds for large ranges.",
      };
    }
    if (showingStaleRange) {
      return {
        tone: "loading" as const,
        text: `Updating ${formatRangeLabel(appliedStart, appliedEnd)} — previous table stays visible until ready.`,
      };
    }
    if (isBusy) {
      return { tone: "loading" as const, text: "Refreshing Time Doctor data…" };
    }
    if (table.error && !table.data) {
      return {
        tone: "error" as const,
        text: table.error instanceof Error ? table.error.message : "Failed to load Time Doctor dashboard",
      };
    }
    return null;
  })();

  if (!canAccess) {
    return <TimeDashboardGate />;
  }

  return (
    <div className="ops-dense">
      {showingUserDetail ? <Outlet /> : null}
      {!showingUserDetail ? (
        <>
          <PageHeader
            eyebrow="People"
            title="Time Dashboard"
            description={
              coldLoad
                ? "Connecting to Time Doctor…"
                : `Time Doctor — ${data?.company?.name ?? "…"}. Period = ${rangeLabel}. Today / weekly / month use ${data?.day ?? "today"} (${data?.timeZoneLabel ?? "company timezone"}). Top 3 get gold, silver, and bronze by ${medalSortLabel}.`
            }
            dense
            actions={
              <>
                <TimeDashboardRangePicker
                  start={start}
                  end={end}
                  onStartChange={setStart}
                  onEndChange={setEnd}
                  onApply={applyRange}
                  isBusy={isBusy}
                  draftMatchesApplied={draftMatchesApplied}
                />
                <button
                  onClick={() => table.refetch()}
                  disabled={isBusy}
                  className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isBusy ? "animate-spin" : ""}`} />
                  Refresh
                </button>
                <button
                  onClick={exportCsv}
                  disabled={!employeeRollups.length || showingStaleRange || coldLoad}
                  className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />
                  Export
                </button>
                <label className="h-8 px-2 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted cursor-pointer disabled:opacity-50">
                  <span className="text-muted-foreground whitespace-nowrap">Month</span>
                  <input
                    type="month"
                    value={underHoursMonth}
                    onChange={(e) => setUnderHoursMonth(e.target.value)}
                    disabled={underHoursPdfLoading || coldLoad}
                    className="bg-transparent text-xs outline-none w-[7.5rem] disabled:opacity-60"
                    aria-label="Month for under-hours weekly PDF"
                  />
                </label>
                <button
                  onClick={() => void exportUnderHoursPdf()}
                  disabled={underHoursPdfLoading || coldLoad || showingStaleRange}
                  className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
                  title="Download PDF listing employees under 35 hours for each week of the selected month"
                >
                  <FileText className="h-3.5 w-3.5" />
                  {underHoursPdfLoading ? "Building PDF…" : "Under 35h PDF"}
                </button>
              </>
            }
          />

          <div className="px-5 md:px-8 py-6 space-y-5">
            <FetchingBar active={isBusy && !coldLoad} />

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
                {statusBanner.tone === "error" ? (
                  <button
                    onClick={() => table.refetch()}
                    className="ml-auto h-7 px-2.5 rounded-md bg-foreground text-background text-[11px] inline-flex items-center gap-1"
                  >
                    <RefreshCw className="h-3 w-3" /> Retry
                  </button>
                ) : null}
              </div>
            ) : null}

            {coldLoad ? (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="surface-card p-4 space-y-2">
                      <div className="h-3 w-24 rounded-md bg-muted/60 animate-pulse" />
                      <div className="h-7 w-20 rounded-md bg-muted/60 animate-pulse mt-2" />
                    </div>
                  ))}
                </div>
                <TimeDashboardTableSkeleton />
              </>
            ) : table.error && !table.data ? null : (
              <>
            {data?.warnings?.length && !showingStaleRange ? (
              <div className="surface-card p-4">
                <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium mb-2">
                  Notes
                </div>
                <ul className="text-xs text-muted-foreground space-y-1">
                  {data!.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Stat label="Employees" value={String(employeeRollups.length)} />
              <Stat label="Total hours (period)" value={`${totalRangeHours.toFixed(0)}h`} />
              <Stat label="Selected range" value={rangeLabel} small />
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <div className="relative flex-1 max-w-sm">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search by name or email…"
                    className="w-full h-8 px-3 rounded-md border border-border bg-background text-[13px]"
                  />
                </div>
                <div className="sm:ml-auto text-xs text-muted-foreground">{employeeRollups.length} employees</div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground mr-1">Sort by</span>
                {SORT_OPTIONS.map((s) => {
                  const active = sortBy === s.key;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => applySort(s.key)}
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
                        sortDir === "asc" ? (
                          <ArrowUpAZ className="h-3.5 w-3.5" />
                        ) : (
                          <ArrowDownAZ className="h-3.5 w-3.5" />
                        )
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>

            {data && !coldLoad ? (
              <div className="surface-card p-3 text-[12px] text-muted-foreground">
                {showingStaleRange ? (
                  <span className="font-medium text-foreground">Pending range · </span>
                ) : null}
                Period: {rangeLabel}
                {data.timeZoneLabel ? ` · ${data.timeZoneLabel}` : ""}
                {q.trim() ? ` · Showing ${employeeRollups.length}` : ""}
              </div>
            ) : null}

            <div className="relative min-h-[12rem]">
              {showingStaleRange ? (
                <div
                  className="absolute inset-0 z-10 rounded-lg bg-background/55 backdrop-blur-[1px] pointer-events-none flex items-start justify-center pt-10"
                  aria-hidden
                >
                  <span className="text-[12px] text-muted-foreground bg-paper border border-border px-3 py-1.5 rounded-full shadow-sm inline-flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading {formatRangeLabel(appliedStart, appliedEnd)}…
                  </span>
                </div>
              ) : null}
              <div
                className={
                  showingStaleRange
                    ? "opacity-55 pointer-events-none select-none transition-opacity duration-300"
                    : "transition-opacity duration-300"
                }
              >
            <TableScroll>
              <table className="ops-table w-full table-fixed">
                <colgroup>
                  <col className="w-[3.25rem]" />
                  <col />
                  <col className="w-[7rem]" />
                  <col className="w-[6rem]" />
                  <col className="w-[6rem]" />
                  <col className="w-[6.5rem]" />
                </colgroup>
                <thead>
                  <tr>
                    <th align="center" className="whitespace-nowrap">
                      Medal
                    </th>
                    <th align="left">
                      <button
                        type="button"
                        onClick={() => applySort("name")}
                        className={`inline-flex items-center gap-1 font-medium hover:text-foreground ${sortHeaderClass("name")}`}
                      >
                        Employee
                        {sortBy === "name" ? (
                          sortDir === "asc" ? (
                            <ArrowUpAZ className="h-3 w-3" />
                          ) : (
                            <ArrowDownAZ className="h-3 w-3" />
                          )
                        ) : null}
                      </button>
                    </th>
                    <th align="right" className="whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => applySort("range")}
                        className={`inline-flex items-center gap-1 ml-auto font-medium hover:text-foreground ${sortHeaderClass("range")}`}
                      >
                        Period hours
                        {sortBy === "range" ? (
                          sortDir === "asc" ? (
                            <ArrowUpAZ className="h-3 w-3" />
                          ) : (
                            <ArrowDownAZ className="h-3 w-3" />
                          )
                        ) : null}
                      </button>
                    </th>
                    <th align="right" className="whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => applySort("daily")}
                        className={`inline-flex items-center gap-1 ml-auto font-medium hover:text-foreground ${sortHeaderClass("daily")}`}
                      >
                        Today
                        {sortBy === "daily" ? (
                          sortDir === "asc" ? (
                            <ArrowUpAZ className="h-3 w-3" />
                          ) : (
                            <ArrowDownAZ className="h-3 w-3" />
                          )
                        ) : null}
                      </button>
                    </th>
                    <th align="right" className="whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => applySort("weekly")}
                        className={`inline-flex items-center gap-1 ml-auto font-medium hover:text-foreground ${sortHeaderClass("weekly")}`}
                      >
                        Weekly
                        {sortBy === "weekly" ? (
                          sortDir === "asc" ? (
                            <ArrowUpAZ className="h-3 w-3" />
                          ) : (
                            <ArrowDownAZ className="h-3 w-3" />
                          )
                        ) : null}
                      </button>
                    </th>
                    <th align="right" className="whitespace-nowrap !pr-6">
                      <button
                        type="button"
                        onClick={() => applySort("monthly")}
                        className={`inline-flex items-center gap-1 ml-auto font-medium hover:text-foreground ${sortHeaderClass("monthly")}`}
                      >
                        Cal. month
                        {sortBy === "monthly" ? (
                          sortDir === "asc" ? (
                            <ArrowUpAZ className="h-3 w-3" />
                          ) : (
                            <ArrowDownAZ className="h-3 w-3" />
                          )
                        ) : null}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {employeeRollups.map((e, rowIndex) => {
                    const rank = rankByEmployeeId.get(e.employee_id) ?? rowIndex + 1;
                    return (
                    <tr
                      key={e.employee_id}
                      className={
                        medalRowClass(rank) + " hover:bg-muted/40 cursor-pointer"
                      }
                      onClick={() => {
                        navigate({
                          to: "/time-dashboard/$userId",
                          params: { userId: e.employee_id },
                          search: detailSearch,
                        });
                      }}
                    >
                      <td align="center" className="align-middle">
                        {rankCellContent(rank)}
                      </td>
                      <td className="align-middle">
                        <div className="font-medium text-[13px]">
                          <Link
                            to="/time-dashboard/$userId"
                            params={{ userId: e.employee_id }}
                            search={detailSearch}
                            className="hover:underline"
                            onClick={(ev) => ev.stopPropagation()}
                          >
                            {e.name}
                          </Link>
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate">{e.email}</div>
                      </td>
                      <td
                        align="right"
                        className={`font-mono tabular-nums align-middle ${sortBy === "range" ? "font-semibold text-foreground" : "font-medium"}`}
                      >
                        {((e.rangeSeconds ?? 0) / 3600).toFixed(2)}
                      </td>
                      <td
                        align="right"
                        className={`font-mono tabular-nums align-middle ${sortBy === "daily" ? "font-semibold text-foreground" : "text-muted-foreground"}`}
                      >
                        {((e.dailySeconds ?? 0) / 3600).toFixed(2)}
                      </td>
                      <td
                        align="right"
                        className={`font-mono tabular-nums align-middle ${sortBy === "weekly" ? "font-semibold text-foreground" : "text-muted-foreground"}`}
                      >
                        {((e.weeklySeconds ?? 0) / 3600).toFixed(2)}
                      </td>
                      <td
                        align="right"
                        className={`font-mono tabular-nums align-middle !pr-6 ${sortBy === "monthly" ? "font-semibold text-foreground" : "text-muted-foreground"}`}
                      >
                        {((e.monthlySeconds ?? 0) / 3600).toFixed(2)}
                      </td>
                    </tr>
                  );
                  })}
                </tbody>
              </table>
            </TableScroll>
              </div>
            </div>

            {employeeRollups.length === 0 && !showingStaleRange && (
              <EmptyState icon={Clock} title="No employees" description="No Time Doctor users matched your search." />
            )}
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="surface-card p-4">
      <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">{label}</div>
      <div className={`font-display mt-1 ${small ? "text-base" : "text-2xl"}`}>{value}</div>
    </div>
  );
}
