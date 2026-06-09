import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BarChart3, Loader2, RefreshCw } from "lucide-react";
import { FetchingBar } from "@/components/Skeleton";
import { filterBonusAnalytics } from "@/lib/bonus-analytics";
import { getBonusAnalytics } from "@/lib/bonus-functions";
import { fmtCurrency, fmtDate } from "@/lib/format";

export const Route = createFileRoute("/bonus/analytics")({
  component: BonusAnalyticsPage,
});

const QUERY_KEY = ["bonus-analytics"];
const TEAM_COLORS = ["#10b981", "#34d399", "#64748b", "#94a3b8", "#f59e0b", "#8b5cf6", "#06b6d4"];

type Granularity = "daily" | "weekly" | "monthly";

function BonusAnalyticsPage() {
  const [teamFilter, setTeamFilter] = useState("__all__");
  const [locationFilter, setLocationFilter] = useState("__all__");
  const [activeOnly, setActiveOnly] = useState(true);
  const [granularity, setGranularity] = useState<Granularity>("monthly");

  const q = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => getBonusAnalytics(),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const base = q.data;

  const teamOptions = useMemo(() => {
    if (!base) return [];
    return [...new Set(base.allPayments.map((p) => p.team))].sort();
  }, [base]);

  const locationOptions = useMemo(() => {
    if (!base) return [];
    return [...new Set(base.allPayments.map((p) => p.location))].sort();
  }, [base]);

  const report = useMemo(() => {
    if (!base) return null;
    return filterBonusAnalytics(base, {
      team: teamFilter,
      location: locationFilter,
      activeOnly,
    });
  }, [base, teamFilter, locationFilter, activeOnly]);

  const timeSeries = useMemo(() => {
    if (!report) return [];
    if (granularity === "daily") return report.byDay;
    if (granularity === "weekly") return report.byWeek;
    return report.byMonth;
  }, [report, granularity]);

  const pieData = useMemo(
    () => report?.byTeam.map((t) => ({ name: t.team, value: t.total })) ?? [],
    [report],
  );

  return (
    <div className="px-5 md:px-8 py-6 space-y-5">
      <FetchingBar active={q.isFetching} />

      <div className="surface-card p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 font-medium text-[13px]">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            Bonus analytics
          </div>
          <div className="text-[12px] text-muted-foreground mt-1">
            Live from S3 ledger — refreshes every 30 seconds. Team, location, and time-series views.
          </div>
          {report?.ledgerUpdatedAt && (
            <div className="text-[11px] text-muted-foreground mt-1 font-mono">
              Ledger updated {new Date(report.ledgerUpdatedAt).toLocaleString()}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
          className="h-8 px-3 rounded-md border border-border text-xs font-medium hover:bg-muted flex items-center gap-1.5 self-start"
        >
          {q.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh now
        </button>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <select
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
          className="h-8 px-2 rounded-md border border-border bg-background text-[12px]"
        >
          <option value="__all__">All teams</option>
          {teamOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={locationFilter}
          onChange={(e) => setLocationFilter(e.target.value)}
          className="h-8 px-2 rounded-md border border-border bg-background text-[12px]"
        >
          <option value="__all__">All locations</option>
          {locationOptions.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
            className="rounded border-border"
          />
          Active employees only
        </label>
        <select
          value={granularity}
          onChange={(e) => setGranularity(e.target.value as Granularity)}
          className="h-8 px-2 rounded-md border border-border bg-background text-[12px] ml-auto"
        >
          <option value="daily">Daily trend</option>
          <option value="weekly">Weekly trend</option>
          <option value="monthly">Monthly trend</option>
        </select>
      </div>

      {q.isLoading ? (
        <div className="surface-card p-10 text-center text-muted-foreground text-[13px]">Loading analytics…</div>
      ) : !report ? (
        <div className="surface-card p-10 text-center text-muted-foreground text-[13px]">No data</div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Stat label="Total paid" value={fmtCurrency(report.summary.totalPaid)} />
            <Stat label="Payments" value={String(report.summary.paymentCount)} />
            <Stat label="Employees paid" value={String(report.summary.employeeCount)} />
            <Stat label="Avg per payment" value={fmtCurrency(report.summary.avgPerPayment)} />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="surface-card p-4">
              <div className="font-medium text-[13px]">Bonus over time</div>
              <div className="text-[12px] text-muted-foreground mt-0.5 capitalize">{granularity} totals from paid dates</div>
              <div className="h-[260px] mt-3">
                {timeSeries.length === 0 ? (
                  <EmptyChart />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={timeSeries} margin={{ left: 8, right: 10, top: 8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                      <YAxis
                        tick={{ fontSize: 11 }}
                        tickFormatter={(v) => (typeof v === "number" ? `$${Math.round(v / 1000)}k` : "")}
                      />
                      <Tooltip
                        formatter={(v: number) => fmtCurrency(v)}
                        labelFormatter={(l) => String(l)}
                      />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="total"
                        name="Bonus paid"
                        stroke="#10b981"
                        strokeWidth={2}
                        dot={{ r: 3 }}
                        connectNulls
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <div className="surface-card p-4">
              <div className="font-medium text-[13px]">By team</div>
              <div className="text-[12px] text-muted-foreground mt-0.5">Share of total bonus spend</div>
              <div className="h-[260px] mt-3">
                {pieData.length === 0 ? (
                  <EmptyChart />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={88} paddingAngle={2}>
                        {pieData.map((_, i) => (
                          <Cell key={i} fill={TEAM_COLORS[i % TEAM_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: number) => fmtCurrency(v)} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="surface-card p-4">
              <div className="font-medium text-[13px]">Team breakdown</div>
              <div className="h-[280px] mt-3">
                {report.byTeam.length === 0 ? (
                  <EmptyChart />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={report.byTeam} layout="vertical" margin={{ left: 8, right: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.25} horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} />
                      <YAxis type="category" dataKey="team" width={100} tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(v: number) => fmtCurrency(v)} />
                      <Bar dataKey="total" name="Total bonus" fill="#10b981" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <div className="surface-card p-4">
              <div className="font-medium text-[13px]">By location</div>
              <div className="h-[280px] mt-3">
                {report.byLocation.length === 0 ? (
                  <EmptyChart />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={report.byLocation} margin={{ left: 8, right: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                      <XAxis dataKey="location" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} />
                      <Tooltip formatter={(v: number) => fmtCurrency(v)} />
                      <Bar dataKey="total" name="Total bonus" fill="#64748b" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="surface-ops overflow-x-auto">
              <div className="px-4 py-3 font-medium text-[13px]">Top recipients</div>
              <table className="ops-table w-full min-w-[480px]">
                <thead>
                  <tr>
                    <th align="left">Employee</th>
                    <th align="left">Team</th>
                    <th align="right">Total</th>
                    <th align="right">#</th>
                  </tr>
                </thead>
                <tbody>
                  {report.topRecipients.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="text-center py-8 text-muted-foreground text-[12px]">
                        No payments yet
                      </td>
                    </tr>
                  ) : (
                    report.topRecipients.slice(0, 10).map((r) => (
                      <tr key={r.employeeId}>
                        <td className="font-medium">{r.name}</td>
                        <td className="text-muted-foreground">{r.team}</td>
                        <td align="right" className="font-mono">
                          {fmtCurrency(r.total)}
                        </td>
                        <td align="right" className="text-muted-foreground">
                          {r.count}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="surface-ops overflow-x-auto">
              <div className="px-4 py-3 font-medium text-[13px]">Recent payments</div>
              <table className="ops-table w-full min-w-[520px]">
                <thead>
                  <tr>
                    <th align="left">Paid</th>
                    <th align="left">Employee</th>
                    <th align="left">Team</th>
                    <th align="right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {report.recentPayments.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="text-center py-8 text-muted-foreground text-[12px]">
                        No payments yet —{" "}
                        <Link to="/bonus" className="underline">
                          record a bonus
                        </Link>
                      </td>
                    </tr>
                  ) : (
                    report.recentPayments.map((p) => (
                      <tr key={p.eventId}>
                        <td className="text-muted-foreground text-[12px]">{fmtDate(p.paidOn)}</td>
                        <td className="font-medium">{p.employeeName}</td>
                        <td className="text-muted-foreground">{p.team}</td>
                        <td align="right" className="font-mono">
                          {fmtCurrency(p.amountUsd)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface-card p-4">
      <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">{label}</div>
      <div className="font-display text-xl mt-1">{value}</div>
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="h-full grid place-items-center text-[12px] text-muted-foreground border border-dashed border-border rounded-lg">
      No bonus data for current filters
    </div>
  );
}
