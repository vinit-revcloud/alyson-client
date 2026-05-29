import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader, TableScroll, EmptyState } from "@/components/AppShell";
import { PageSkeleton } from "@/components/Skeleton";
import { fetchTimeDoctorEmployeesTable, type TimeDoctorEmployeeRow } from "@/lib/time-doctor-functions";
import { Clock, Download, RefreshCw, AlertTriangle } from "lucide-react";
import { downloadCSV } from "@/lib/csv";
import { toast } from "sonner";
import { z } from "zod";
import { useAuth } from "@/lib/auth";
import { TimeDashboardGate } from "@/components/TimeDashboardGate";

export const Route = createFileRoute("/time-dashboard")({
  head: () => ({ meta: [{ title: "Time Dashboard — Alyson HR" }] }),
  // IMPORTANT: Never throw here—bad/missing query params should not break routing.
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

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function TimeDashboardPage() {
  const auth = useAuth();
  const canAccess = auth.canAccessTimeDashboard;

  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const showingUserDetail = pathname.startsWith("/time-dashboard/") && pathname !== "/time-dashboard";

  const search = Route.useSearch();

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const defaultStart = useMemo(() => new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10), []);

  const [start, setStart] = useState(search.start ?? defaultStart);
  const [end, setEnd] = useState(search.end ?? today);

  // For the list view we show "daily hours" for the selected end date.
  const day = end;

  const table = useQuery({
    queryKey: ["time-doctor-employees-table", day],
    queryFn: () => fetchTimeDoctorEmployeesTable({ data: { day } }),
    enabled: canAccess,
  });

  if (!canAccess) {
    return <TimeDashboardGate />;
  }

  if (table.isLoading) return <PageSkeleton />;
  if (table.error) {
    return (
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
                <div className="mt-4 text-xs text-muted-foreground">
                  Required server env vars: <span className="font-mono">API_BASE_URL</span>,{" "}
                  <span className="font-mono">API_ACCESS_TOKEN</span> (optional refresh:{" "}
                  <span className="font-mono">API_REFRESH_TOKEN</span>,{" "}
                  <span className="font-mono">OAUTH_CLIENT_ID</span>,{" "}
                  <span className="font-mono">OAUTH_CLIENT_SECRET</span>,{" "}
                  <span className="font-mono">OAUTH_REDIRECT_URL</span>).
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
    );
  }

  const data = table.data as { company: { id: string; name: string }; day: string; warnings: string[]; employees: TimeDoctorEmployeeRow[] };
  const employees = data?.employees ?? [];

  const employeeRollups = useMemo(() => {
    const normalizedQ = q.trim().toLowerCase();
    return employees
      .map((e) => {
        return {
          employee_id: e.id,
          name: e.name,
          email: e.email,
          dailySeconds: e.dailySeconds ?? 0,
          monthlySeconds: e.monthlySeconds ?? 0,
        };
      })
      .filter((r) => {
        if (!normalizedQ) return true;
        return (
          r.name.toLowerCase().includes(normalizedQ) ||
          r.email.toLowerCase().includes(normalizedQ)
        );
      })
      .sort((a, b) => (b.dailySeconds ?? 0) - (a.dailySeconds ?? 0));
  }, [employees, q]);

  const totalHours = useMemo(
    () => employeeRollups.reduce((s, e) => s + (e.dailySeconds ?? 0), 0) / 3600,
    [employeeRollups],
  );

  // Expose live dashboard context for the mini module AI (client-side).
  useEffect(() => {
    if (!canAccess) return;
    if (typeof window === "undefined") return;
    const all = employeeRollups.map((e) => ({
      employee_id: e.employee_id,
      name: e.name,
      email: e.email,
      daily_hours: Number(((e.dailySeconds ?? 0) / 3600).toFixed(2)),
      monthly_hours: Number(((e.monthlySeconds ?? 0) / 3600).toFixed(2)),
    }));

    const top = all.slice(0, 5);
    const top1 = top[0] ?? null;
    const zero = all.filter((e) => (e.daily_hours ?? 0) <= 0);
    const gt3 = all.filter((e) => (e.daily_hours ?? 0) > 3);

    (window as any).__ALYSON_MINI_CONTEXT__ = {
      module: "time-dashboard",
      day,
      company: data?.company?.name ?? "",
      total_hours_today: Number(totalHours.toFixed(2)),
      // Full list for dynamic filters (expected small ~tens of employees).
      employees_all_today: all,
      employees_total: all.length,
      employees_gt_3_hours_today_count: gt3.length,
      employees_gt_3_hours_today_preview: gt3.slice(0, 25),
      employees_zero_hours_today_count: zero.length,
      employees_zero_hours_today_preview: zero.slice(0, 50),
      top_employees_today: top,
      highest_hours_today: top1,
      generated_at: new Date().toISOString(),
    };
    return () => {
      // Avoid leaking the previous module context when navigating away.
      const cur = (window as any).__ALYSON_MINI_CONTEXT__;
      if (cur?.module === "time-dashboard") (window as any).__ALYSON_MINI_CONTEXT__ = undefined;
    };
  }, [canAccess, employeeRollups, totalHours, day, data?.company?.name]);

  const exportCsv = () => {
    if (!employeeRollups.length) return toast.error("No employees to export");
    downloadCSV(
      `time-dashboard-${new Date().toISOString().slice(0, 10)}.csv`,
      employeeRollups.map((e) => ({
        employee: e.name,
        email: e.email,
        daily_hours: ((e.dailySeconds ?? 0) / 3600).toFixed(2),
        monthly_hours: ((e.monthlySeconds ?? 0) / 3600).toFixed(2),
      })),
    );
    toast.success("Time dashboard exported");
  };

  const applyRange = () => {
    navigate({ to: "/time-dashboard", search: { start, end }, replace: true });
    table.refetch();
  };

  return (
    <div className="ops-dense">
      {showingUserDetail ? <Outlet /> : null}
      {!showingUserDetail ? (
        <>
      <PageHeader
        eyebrow="People"
        title="Time Dashboard"
        description={`Real-time Time Doctor employees — ${data.company.name}.`}
        dense
        actions={
          <>
            <div className="flex items-center gap-2 rounded-md border border-border bg-paper px-2 py-1.5">
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="h-7 rounded bg-transparent text-[12.5px] text-foreground px-1.5"
              />
              <span className="text-muted-foreground text-xs">→</span>
              <input
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="h-7 rounded bg-transparent text-[12.5px] text-foreground px-1.5"
              />
              <button
                onClick={applyRange}
                className="h-7 px-2.5 rounded bg-foreground text-background text-[11.5px] font-medium"
              >
                Apply
              </button>
            </div>
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Stat label="Employees" value={String(employeeRollups.length)} />
          <Stat label="Total hours today" value={`${totalHours.toFixed(0)}h`} />
          <Stat label="Data source" value="Time Doctor" />
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
          <div className="sm:ml-auto text-xs text-muted-foreground">
            {employeeRollups.length} employees
          </div>
        </div>

        <TableScroll>
          <table className="ops-table w-full table-fixed">
            <colgroup>
              <col />
              <col className="w-[7.5rem]" />
              <col className="w-[8.5rem]" />
            </colgroup>
            <thead>
              <tr>
                <th align="left">Employee</th>
                <th align="right" className="whitespace-nowrap">
                  Daily hours
                </th>
                <th align="right" className="whitespace-nowrap">
                  Monthly hours
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
                      search: {
                        start: isIsoDate(start) ? start : undefined,
                        end: isIsoDate(end) ? end : undefined,
                      },
                    });
                  }}
                >
                  <td className="align-middle">
                    <div className="font-medium text-[13px]">
                      <Link
                        to="/time-dashboard/$userId"
                        params={{ userId: e.employee_id }}
                        search={{
                          start: isIsoDate(start) ? start : undefined,
                          end: isIsoDate(end) ? end : undefined,
                        }}
                        className="hover:underline"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        {e.name}
                      </Link>
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">{e.email}</div>
                  </td>
                  <td align="right" className="font-mono tabular-nums align-middle">
                    {((e.dailySeconds ?? 0) / 3600).toFixed(2)}
                  </td>
                  <td align="right" className="font-mono tabular-nums align-middle">
                    {((e.monthlySeconds ?? 0) / 3600).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </div>
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface-card p-4">
      <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">{label}</div>
      <div className="font-display text-2xl mt-1">{value}</div>
    </div>
  );
}

