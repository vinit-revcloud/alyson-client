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
import { Clock, Download, RefreshCw, AlertTriangle } from "lucide-react";
import { downloadCSV } from "@/lib/csv";
import { toast } from "sonner";
import { z } from "zod";
import { useAuth } from "@/lib/auth";
import { TimeDashboardGate } from "@/components/TimeDashboardGate";

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

function TimeDashboardPage() {
  const auth = useAuth();
  const canAccess = auth.canAccessTimeDashboard;

  const [q, setQ] = useState("");
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
        data: { start: appliedStart, end: appliedEnd, day: appliedEnd },
      }),
    enabled: canAccess,
  });

  const data = table.data as
    | {
        company: { id: string; name: string };
        day: string;
        range?: { start: string; end: string };
        warnings: string[];
        employees: TimeDoctorEmployeeRow[];
      }
    | undefined;
  const employees = data?.employees ?? [];
  const activeRange = data?.range ?? { start: appliedStart, end: appliedEnd };

  const employeeRollups = useMemo(() => {
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
    downloadCSV(`time-dashboard-${activeRange.start}-${activeRange.end}.csv`, employeeRollups.map((e) => ({
      employee: e.name,
      email: e.email,
      range_hours: ((e.rangeSeconds ?? 0) / 3600).toFixed(2),
      daily_hours: ((e.dailySeconds ?? 0) / 3600).toFixed(2),
      weekly_hours: ((e.weeklySeconds ?? 0) / 3600).toFixed(2),
      calendar_month_hours: ((e.monthlySeconds ?? 0) / 3600).toFixed(2),
    })));
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
            description={`Time Doctor — ${data?.company?.name ?? "…"}. Period = ${rangeLabel}. Daily / weekly / month columns use the end date (${activeRange.end}).`}
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

            <TableScroll>
              <table className="ops-table w-full table-fixed">
                <colgroup>
                  <col />
                  <col className="w-[7rem]" />
                  <col className="w-[6rem]" />
                  <col className="w-[6rem]" />
                  <col className="w-[6.5rem]" />
                </colgroup>
                <thead>
                  <tr>
                    <th align="left">Employee</th>
                    <th align="right" className="whitespace-nowrap">
                      Period hours
                    </th>
                    <th align="right" className="whitespace-nowrap">
                      Daily
                    </th>
                    <th align="right" className="whitespace-nowrap">
                      Weekly
                    </th>
                    <th align="right" className="whitespace-nowrap !pr-6">
                      Cal. month
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {employeeRollups.map((e) => (
                    <tr
                      key={e.employee_id}
                      className="hover:bg-muted/40 cursor-pointer"
                      onClick={() => {
                        navigate({
                          to: "/time-dashboard/$userId",
                          params: { userId: e.employee_id },
                          search: detailSearch,
                        });
                      }}
                    >
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
                      <td align="right" className="font-mono tabular-nums align-middle font-medium">
                        {((e.rangeSeconds ?? 0) / 3600).toFixed(2)}
                      </td>
                      <td align="right" className="font-mono tabular-nums align-middle text-muted-foreground">
                        {((e.dailySeconds ?? 0) / 3600).toFixed(2)}
                      </td>
                      <td align="right" className="font-mono tabular-nums align-middle text-muted-foreground">
                        {((e.weeklySeconds ?? 0) / 3600).toFixed(2)}
                      </td>
                      <td align="right" className="font-mono tabular-nums align-middle text-muted-foreground !pr-6">
                        {((e.monthlySeconds ?? 0) / 3600).toFixed(2)}
                      </td>
                    </tr>
                  ))}
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
