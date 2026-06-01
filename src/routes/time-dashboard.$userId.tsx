import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader, TableScroll, EmptyState } from "@/components/AppShell";
import { PageSkeleton } from "@/components/Skeleton";
import { TimeDashboardRangePicker } from "@/components/TimeDashboardRangePicker";
import { fetchTimeDoctorUserDetail, type TimeDoctorUserDetail } from "@/lib/time-doctor-functions";
import {
  defaultDetailRange,
  formatMonthLabel,
  formatRangeLabel,
  isIsoDate,
} from "@/lib/time-dashboard-range";
import { ArrowLeft, Download, RefreshCw, Clock } from "lucide-react";
import { downloadCSV } from "@/lib/csv";
import { toast } from "sonner";
import { z } from "zod";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from "recharts";

export const Route = createFileRoute("/time-dashboard/$userId")({
  head: () => ({ meta: [{ title: "Employee — Time Doctor — Alyson HR" }] }),
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
  component: TimeDoctorEmployeePage,
});

type TabKey = "overview" | "attendance" | "apps" | "work";

const PIE_COLORS: Record<string, string> = {
  productive: "var(--chart-3)",
  neutral: "var(--chart-4)",
  distracting: "var(--chart-2)",
};

function TimeDoctorEmployeePage() {
  const { userId } = Route.useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>("overview");

  const search = Route.useSearch();
  const detailDefaults = useMemo(() => defaultDetailRange(), []);
  const start = search.start ?? detailDefaults.start;
  const end = search.end ?? detailDefaults.end;

  const [draftStart, setDraftStart] = useState(start);
  const [draftEnd, setDraftEnd] = useState(end);

  useEffect(() => {
    setDraftStart(start);
    setDraftEnd(end);
  }, [start, end]);

  const applyRange = () => {
    if (!isIsoDate(draftStart) || !isIsoDate(draftEnd)) {
      toast.error("Enter valid start and end dates");
      return;
    }
    if (draftStart > draftEnd) {
      toast.error("Start date must be on or before end date");
      return;
    }
    navigate({
      to: "/time-dashboard/$userId",
      params: { userId },
      search: { start: draftStart, end: draftEnd },
      replace: true,
    });
  };

  const listSearch = { start: isIsoDate(start) ? start : undefined, end: isIsoDate(end) ? end : undefined };

  const q = useQuery({
    queryKey: ["time-doctor-user", userId, start, end, tab],
    queryFn: () => fetchTimeDoctorUserDetail({ data: { userId, start, end, tab } }),
    enabled: !!userId,
  });

  const data = (q.data ?? null) as TimeDoctorUserDetail | null;
  const user = data?.user ?? { id: userId, name: "Employee", email: "", title: "" };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const top = data?.apps?.top ?? [];
    (window as any).__ALYSON_MINI_CONTEXT__ = {
      module: "time-doctor-user-detail",
      tab,
      range: { start, end },
      user,
      apps_websites_top: top.map((t) => ({
        name: t.name,
        category: t.category,
        hours: Number(((t.seconds ?? 0) / 3600).toFixed(2)),
      })),
    };
    return () => {
      const cur = (window as any).__ALYSON_MINI_CONTEXT__;
      if (cur?.module === "time-doctor-user-detail") (window as any).__ALYSON_MINI_CONTEXT__ = undefined;
    };
  }, [data, tab, start, end, userId]);

  const exportCsv = () => {
    if (!data) return toast.error("Nothing to export yet");
    if (tab === "attendance" && data.attendance) {
      downloadCSV(
        `time-doctor-attendance-${userId}-${start}-${end}.csv`,
        data.attendance.records.map((r) => ({ date: r.date, status: r.status })),
      );
      toast.success("Attendance exported");
      return;
    }
    if (tab === "apps" && data.apps) {
      downloadCSV(
        `time-doctor-apps-${userId}-${start}-${end}.csv`,
        data.apps.top.map((r) => ({ name: r.name, category: r.category, hours: (r.seconds / 3600).toFixed(2) })),
      );
      toast.success("Apps exported");
      return;
    }
    if (tab === "work" && data.work) {
      downloadCSV(
        `time-doctor-work-${userId}-${start}-${end}.csv`,
        data.work.timeByProject.map((r) => ({ project: r.name, hours: (r.seconds / 3600).toFixed(2) })),
      );
      toast.success("Work exported");
      return;
    }
    if (tab === "overview" && data.rollups?.monthly?.length) {
      downloadCSV(
        `time-doctor-monthly-${userId}-${start}-${end}.csv`,
        data.rollups.monthly.map((m) => ({
          month: m.month,
          productive_hours: (m.productiveSeconds / 3600).toFixed(2),
          poor_hours: (m.poorSeconds / 3600).toFixed(2),
        })),
      );
      toast.success("Monthly rollups exported");
      return;
    }
    toast.error("Nothing to export on this tab yet");
  };

  const monthlyChartData = useMemo(() => {
    if (!data?.rollups?.monthly?.length) return [];
    return data.rollups.monthly.map((m) => ({
      month: formatMonthLabel(m.month),
      monthKey: m.month,
      productiveH: m.productiveSeconds / 3600,
      poorH: m.poorSeconds / 3600,
    }));
  }, [data?.rollups?.monthly]);

  return (
    <div className="ops-dense">
      <PageHeader
        eyebrow="People"
        title={user.name}
        description={
          user.email
            ? `${user.email} · Time Doctor · ${formatRangeLabel(start, end)}`
            : `Time Doctor · ${formatRangeLabel(start, end)}`
        }
        dense
        actions={
          <>
            <Link
              to="/time-dashboard"
              search={listSearch}
              className="h-8 px-3 rounded-md border border-border text-xs flex items-center gap-1.5 hover:bg-muted"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </Link>
            <TimeDashboardRangePicker
              start={draftStart}
              end={draftEnd}
              onStartChange={setDraftStart}
              onEndChange={setDraftEnd}
              onApply={applyRange}
              compact
            />
            <div className="inline-flex rounded-md border border-border p-0.5 bg-paper">
              {([
                ["overview", "Overview"],
                ["attendance", "Attendance"],
                ["apps", "Apps & Websites"],
                ["work", "Projects & Tasks"],
              ] as const).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  className={
                    "h-7 px-2.5 rounded text-[11.5px] font-medium flex items-center gap-1.5 " +
                    (tab === k ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              onClick={() => q.refetch()}
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
        {q.isLoading && <PageSkeleton />}

        {q.isError && (
          <div className="surface-card p-5">
            <div className="font-medium">Unable to load employee details</div>
            <div className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">
              {q.error instanceof Error ? q.error.message : "Unknown error"}
            </div>
          </div>
        )}

        {!q.isLoading && !q.isError && !data && (
          <EmptyState title="No data" description="No response returned for this employee." />
        )}

        {data?.warnings?.length ? (
          <div className="surface-card p-4">
            <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium mb-2">
              Warnings
            </div>
            <ul className="text-xs text-muted-foreground space-y-1">
              {data.warnings.map((w, i) => (
                <li key={i} className="font-mono">
                  {w}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {data && tab === "overview" && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <Stat
                label="Daily hours"
                value={
                  data.rollups?.daily?.length
                    ? `${(data.rollups.daily[data.rollups.daily.length - 1].productiveSeconds / 3600).toFixed(2)}h`
                    : "—"
                }
              />
              <Stat label="Total hours (range)" value={data.overview ? `${(data.overview.productiveSeconds / 3600).toFixed(2)}h` : "—"} />
              <Stat label="Productivity score" value={data.overview ? `${Math.round(data.overview.productivityScore * 100)}%` : "—"} />
              <Stat label="Focus score" value="—" />
            </div>

            {data.rollups ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Stat
                  label="Weekly hours"
                  value={
                    data.rollups.weekly.length
                      ? `${(data.rollups.weekly[data.rollups.weekly.length - 1].productiveSeconds / 3600).toFixed(2)}h`
                      : "—"
                  }
                />
                <Stat
                  label="Monthly hours"
                  value={
                    data.rollups.monthly.length
                      ? `${(data.rollups.monthly[data.rollups.monthly.length - 1].productiveSeconds / 3600).toFixed(2)}h`
                      : "—"
                  }
                />
                <Stat label="Range" value={`${data.range.start} → ${data.range.end}`} />
              </div>
            ) : null}

            <div className="surface-card p-4 md:p-5">
              <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">Poor time</div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mt-3">
                <Stat label="Total poor time" value={data.overview ? `${(data.overview.poorSeconds / 3600).toFixed(2)}h` : "—"} />
                <Stat
                  label="Daily poor time"
                  value={
                    data.rollups?.daily?.length
                      ? `${(data.rollups.daily[data.rollups.daily.length - 1].poorSeconds / 3600).toFixed(2)}h`
                      : "—"
                  }
                />
                <Stat
                  label="Weekly poor time"
                  value={
                    data.rollups?.weekly?.length
                      ? `${(data.rollups.weekly[data.rollups.weekly.length - 1].poorSeconds / 3600).toFixed(2)}h`
                      : "—"
                  }
                />
                <Stat
                  label="Monthly poor time"
                  value={
                    data.rollups?.monthly?.length
                      ? `${(data.rollups.monthly[data.rollups.monthly.length - 1].poorSeconds / 3600).toFixed(2)}h`
                      : "—"
                  }
                />
              </div>
            </div>

            {monthlyChartData.length > 0 && (
              <div className="surface-card p-4 md:p-5">
                <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">Rollups</div>
                    <h3 className="font-display text-lg mt-0.5">Hours by month</h3>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={monthlyChartData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="month" stroke="var(--muted-foreground)" fontSize={10} interval={0} angle={-25} textAnchor="end" height={56} />
                    <YAxis stroke="var(--muted-foreground)" fontSize={11} />
                    <Tooltip
                      contentStyle={{ background: "var(--paper)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}
                      formatter={(v: any, n: any) => [`${Number(v ?? 0).toFixed(2)}h`, String(n)] as [string, string]}
                    />
                    <Bar dataKey="productiveH" name="Productive" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="poorH" name="Poor" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                <TableScroll>
                  <table className="ops-table w-full mt-4">
                    <thead>
                      <tr>
                        <th align="left">Month</th>
                        <th align="right">Productive</th>
                        <th align="right">Poor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyChartData.map((m) => (
                        <tr key={m.monthKey}>
                          <td>{m.month}</td>
                          <td align="right" className="font-mono tabular-nums">
                            {m.productiveH.toFixed(2)}h
                          </td>
                          <td align="right" className="font-mono tabular-nums">
                            {m.poorH.toFixed(2)}h
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              </div>
            )}

            {!data.overview?.dailyTrend?.length ? (
              <EmptyState icon={Clock} title="No worklogs found" description="This user has no Time Doctor worklogs in the selected range." />
            ) : (
              <div className="surface-card p-4 md:p-5">
                <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">Trend</div>
                    <h3 className="font-display text-lg mt-0.5">Productive vs poor time (daily)</h3>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={data.overview.dailyTrend.map((d) => ({ ...d, prodH: d.productiveSeconds / 3600, poorH: d.poorSeconds / 3600 }))}>
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="day"
                      tickFormatter={(v) => new Date(v).toLocaleDateString("en", { month: "short", day: "numeric" })}
                      stroke="var(--muted-foreground)"
                      fontSize={11}
                    />
                    <YAxis stroke="var(--muted-foreground)" fontSize={11} />
                    <Tooltip
                      contentStyle={{ background: "var(--paper)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}
                      formatter={(v: any, n: any) => [`${Number(v ?? 0).toFixed(2)}h`, String(n)] as [string, string]}
                    />
                    <Line type="monotone" dataKey="prodH" name="Productive" stroke="var(--chart-3)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="poorH" name="Poor" stroke="var(--chart-2)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        )}

        {data && tab === "attendance" && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Stat label="Absent days" value={data.attendance ? String(data.attendance.absentDays) : "—"} />
              <Stat label="Late days" value={data.attendance ? String(data.attendance.lateDays) : "—"} />
              <Stat label="Range" value={`${data.range.start} → ${data.range.end}`} />
            </div>
            {!data.attendance?.records?.length ? (
              <EmptyState title="No attendance data" description="No absent/late records were returned for this user and range." />
            ) : (
              <TableScroll>
                <table className="ops-table w-full">
                  <thead>
                    <tr>
                      <th align="left">Date</th>
                      <th align="left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.attendance.records.slice(0, 60).map((r) => (
                      <tr key={r.date} className="hover:bg-muted/40">
                        <td className="text-muted-foreground">
                          {new Date(r.date).toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" })}
                        </td>
                        <td>
                          <span className={`pill ${r.status === "absent" ? "pill-neutral" : r.status === "late" ? "pill-warning" : "pill-success"}`}>{r.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </>
        )}

        {data && tab === "apps" && (
          <>
            {!data.apps ? (
              <EmptyState title="No apps data" description="App & website usage data could not be loaded." />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                <div className="surface-card p-4 md:p-5">
                  <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">Distribution</div>
                  <h3 className="font-display text-lg mt-0.5 mb-3">Time by category</h3>
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie data={data.apps.distribution} dataKey="seconds" nameKey="category" innerRadius={55} outerRadius={90}>
                        {data.apps.distribution.map((d, i) => (
                          <Cell key={i} fill={PIE_COLORS[d.category] ?? "var(--chart-1)"} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ background: "var(--paper)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}
                        formatter={(v: any) => `${(Number(v ?? 0) / 3600).toFixed(2)}h`}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="lg:col-span-2 surface-card p-4 md:p-5">
                  <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">Top tools</div>
                  <h3 className="font-display text-lg mt-0.5 mb-3">Apps & websites used</h3>
                  <div className="space-y-2">
                    {data.apps.top.map((t) => (
                      <div key={`${t.category}:${t.name}`} className="flex items-center gap-3 rounded-md border border-border bg-muted/20 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] truncate">{t.name}</div>
                          <div className="text-[11px] text-muted-foreground">{t.category}</div>
                        </div>
                        <div className="font-mono text-xs">{(t.seconds / 3600).toFixed(2)}h</div>
                      </div>
                    ))}
                    {data.apps.top.length === 0 && <div className="text-sm text-muted-foreground">No apps recorded.</div>}
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {data && tab === "work" && (
          <>
            {!data.work ? (
              <EmptyState title="No work breakdown" description="Project/task breakdown could not be loaded." />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                <div className="lg:col-span-2 surface-card p-4 md:p-5">
                  <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">Projects</div>
                  <h3 className="font-display text-lg mt-0.5 mb-3">Time by project</h3>
                  {data.work.timeByProject.length === 0 ? (
                    <div className="text-sm text-muted-foreground">No project time recorded.</div>
                  ) : (
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart
                        data={data.work.timeByProject.slice(0, 10).reverse().map((p) => ({ name: p.name, hours: p.seconds / 3600 }))}
                        layout="vertical"
                        margin={{ top: 5, right: 10, bottom: 0, left: 20 }}
                      >
                        <CartesianGrid stroke="var(--border)" horizontal={false} />
                        <XAxis type="number" stroke="var(--muted-foreground)" fontSize={11} />
                        <YAxis type="category" dataKey="name" stroke="var(--muted-foreground)" fontSize={11} width={120} />
                        <Tooltip
                          contentStyle={{ background: "var(--paper)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}
                          formatter={(v: any) => `${Number(v ?? 0).toFixed(2)}h`}
                        />
                        <Bar dataKey="hours" fill="var(--chart-1)" radius={[4, 4, 4, 4]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
                <div className="surface-card p-4 md:p-5">
                  <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">Tasks</div>
                  <h3 className="font-display text-lg mt-0.5 mb-3">Top tasks</h3>
                  <div className="space-y-2">
                    {data.work.topTasks.map((t) => (
                      <div key={t.name} className="flex items-center justify-between rounded-md border border-border bg-muted/20 px-3 py-2">
                        <div className="text-[13px] truncate max-w-[220px]">{t.name}</div>
                        <div className="font-mono text-xs">{(t.seconds / 3600).toFixed(2)}h</div>
                      </div>
                    ))}
                    {data.work.topTasks.length === 0 && <div className="text-sm text-muted-foreground">No tasks recorded.</div>}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
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

