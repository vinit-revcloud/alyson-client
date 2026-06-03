import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader, TableScroll, EmptyState } from "@/components/AppShell";
import { PageSkeleton } from "@/components/Skeleton";
import { TimeDashboardRangePicker } from "@/components/TimeDashboardRangePicker";
import { fetchTimeDoctorEmployeesTable, type TimeDoctorEmployeeRow } from "@/lib/time-doctor-functions";
import {
  defaultListRange,
  formatRangeLabel,
  isIsoDate,
} from "@/lib/time-dashboard-range";
import { ArrowDownAZ, ArrowUpAZ, Clock, Download, RefreshCw, AlertTriangle } from "lucide-react";
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
  });

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

  const exportCsv = () => {
    if (!employeeRollups.length) return toast.error("No employees to export");
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
    navigate({ to: "/time-dashboard", search: { start, end }, replace: true });
  };

  const detailSearch = {
    start: isIsoDate(appliedStart) ? appliedStart : undefined,
    end: isIsoDate(appliedEnd) ? appliedEnd : undefined,
  };

  if (!canAccess) {
    return <TimeDashboardGate />;
  }

  const listLoading = !showingUserDetail && table.isLoading;
  const listError = !showingUserDetail && table.error;

  return (
    <div className="ops-dense">
      {showingUserDetail ? <Outlet /> : null}
      {listLoading ? (
        <PageSkeleton />
      ) : listError ? (
        <div className="ops-dense">
          <PageHeader
            eyebrow="People"
            title="Time Dashboard"
            description="Real-time Time Doctor data. If refresh tokens are invalid, we will still render employees using the access token."
            dense
          />
          <div className="px-5 md:px-8 py-6">
            <div className="surface-card p-5">
              <div className="flex items-start gap-3">
                <div className="h-9 w-9 rounded-full bg-warning/15 grid place-items-center text-warning shrink-0">
                  <AlertTriangle className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="font-medium">Unable to load Time Doctor dashboard</div>
                  <div className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">
                    {table.error instanceof Error ? table.error.message : "Unknown error"}
                  </div>
                  <div className="mt-4">
                    <button
                      onClick={() => table.refetch()}
                      className="h-8 px-3 rounded-md bg-foreground text-background text-xs flex items-center gap-1.5"
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Retry
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : !showingUserDetail ? (
        <>
          <PageHeader
            eyebrow="People"
            title="Time Dashboard"
            description={`Time Doctor — ${data?.company?.name ?? "…"}. Period = ${rangeLabel}. Today / weekly / month use ${data?.day ?? "today"} (${data?.timeZoneLabel ?? "company timezone"}). Top 3 get gold, silver, and bronze by ${medalSortLabel}.`}
            dense
            actions={
              <>
                <TimeDashboardRangePicker
                  start={start}
                  end={end}
                  onStartChange={setStart}
                  onEndChange={setEnd}
                  onApply={applyRange}
                />
                <button
                  onClick={() => table.refetch()}
                  className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Refresh
                </button>
                <button
                  onClick={exportCsv}
                  className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted"
                >
                  <Download className="h-3.5 w-3.5" />
                  Export
                </button>
              </>
            }
          />

          <div className="px-5 md:px-8 py-6 space-y-6">
            {data?.warnings?.length ? (
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

            {employeeRollups.length === 0 && (
              <EmptyState icon={Clock} title="No employees" description="No Time Doctor users matched your search." />
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
