import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2, MapPin, Users, X } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  pacingFilterSummaryLabel,
  type WeeklyHoursTrendPoint,
  type WeeklyHoursTrendReport,
} from "@/lib/weekly-pacing";

const QUICK_LOCATIONS = ["Pune", "Lahore", "Bahawalpur"] as const;

type Props = {
  trend: WeeklyHoursTrendReport | undefined;
  trendError: Error | null;
  isTrendLoading: boolean;
  isTrendRefetching: boolean;
  locationFilter: string;
  teamFilter: string;
  activeFilter: string;
  onLocationFilter: (value: string) => void;
  onTeamFilter: (value: string) => void;
  onActiveFilter: (value: string) => void;
  onClearFilters: () => void;
  locationOptions: string[];
  teamOptions: string[];
  filteredEmployeeCount: number;
  totalEmployeeCount: number;
};

type ChartRow = WeeklyHoursTrendPoint & {
  shortLabel: string;
  priorAvg: number;
};

function shortWeekLabel(weekStart: string): string {
  const d = new Date(`${weekStart}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function filterLabel(value: string, kind: "location" | "team"): string {
  if (value === "__all__") return kind === "location" ? "All locations" : "All teams";
  if (value === "__empty__") return kind === "location" ? "No location" : "No team";
  return value;
}

function Pill({
  active,
  onClick,
  children,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`h-8 px-3 rounded-full border text-[12px] font-medium transition-all duration-200 disabled:opacity-50 ${
        active
          ? "border-primary bg-primary text-primary-foreground shadow-sm scale-[1.02]"
          : "border-border bg-background text-muted-foreground hover:border-foreground/25 hover:text-foreground hover:bg-muted/40"
      }`}
    >
      {children}
    </button>
  );
}

function KpiCard({
  label,
  value,
  sub,
  tone,
  dimmed,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "positive" | "negative" | "neutral";
  dimmed?: boolean;
}) {
  const toneClass =
    tone === "positive"
      ? "border-emerald-500/30 bg-emerald-500/5"
      : tone === "negative"
        ? "border-orange-500/30 bg-orange-500/5"
        : "border-border bg-muted/10";

  const valueClass =
    tone === "positive"
      ? "text-emerald-700 dark:text-emerald-300"
      : tone === "negative"
        ? "text-orange-700 dark:text-orange-300"
        : "text-foreground";

  return (
    <div
      className={`rounded-lg border px-3 py-2.5 transition-all duration-300 ${toneClass} ${
        dimmed ? "opacity-50" : "opacity-100"
      }`}
    >
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold tabular-nums mt-0.5 ${valueClass}`}>{value}</div>
      {sub ? <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div> : null}
    </div>
  );
}

export function WeeklyPacingTrendPanel({
  trend,
  trendError,
  isTrendLoading,
  isTrendRefetching,
  locationFilter,
  teamFilter,
  activeFilter,
  onLocationFilter,
  onTeamFilter,
  onActiveFilter,
  onClearFilters,
  locationOptions,
  teamOptions,
  filteredEmployeeCount,
  totalEmployeeCount,
}: Props) {
  const [selected, setSelected] = useState<WeeklyHoursTrendPoint | null>(null);
  const filterKey = `${locationFilter}|${teamFilter}|${activeFilter}`;

  useEffect(() => {
    setSelected(null);
  }, [filterKey]);

  const facetFilters = useMemo(
    () => ({ location: locationFilter, team: teamFilter, active: activeFilter }),
    [activeFilter, locationFilter, teamFilter],
  );
  const filterSummary = pacingFilterSummaryLabel(facetFilters);
  const hasFacetFilters =
    locationFilter !== "__all__" || teamFilter !== "__all__" || activeFilter !== "__all__";

  const extraLocations = locationOptions.filter(
    (opt) => opt !== "__empty__" && !QUICK_LOCATIONS.includes(opt as (typeof QUICK_LOCATIONS)[number]),
  );

  const chartData = useMemo<ChartRow[]>(
    () =>
      (trend?.points ?? []).map((p) => ({
        ...p,
        shortLabel: shortWeekLabel(p.weekStart),
        priorAvg: trend?.priorAverageHours ?? 0,
      })),
    [trend?.points, trend?.priorAverageHours],
  );

  const activePoint = selected ?? trend?.latestWeek ?? null;
  const liftPositive = (trend?.liftHours ?? 0) >= 0;
  const chartBusy = isTrendLoading || isTrendRefetching;

  return (
    <div className="surface-card overflow-hidden">
      <div className="border-b border-border bg-muted/20 px-4 py-3 md:px-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-base">Weekly hours trend</h3>
              {chartBusy ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Updating
                </span>
              ) : null}
            </div>
            <p className="text-[12px] text-muted-foreground mt-1 max-w-2xl">
              8-week average logged hours per employee. Filters below update the chart and the table
              together.
            </p>
          </div>
          <div className="text-[11px] text-muted-foreground tabular-nums shrink-0">
            <Users className="h-3.5 w-3.5 inline -mt-0.5 mr-1" />
            {filteredEmployeeCount}
            {hasFacetFilters ? ` of ${totalEmployeeCount}` : ""} in view
          </div>
        </div>

        <div className="mt-4 space-y-3">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              <MapPin className="h-3 w-3" />
              Location
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Pill active={locationFilter === "__all__"} onClick={() => onLocationFilter("__all__")}>
                All
              </Pill>
              {QUICK_LOCATIONS.map((loc) =>
                locationOptions.includes(loc) ? (
                  <Pill
                    key={loc}
                    active={locationFilter === loc}
                    onClick={() => onLocationFilter(locationFilter === loc ? "__all__" : loc)}
                  >
                    {loc}
                  </Pill>
                ) : null,
              )}
              {extraLocations.length > 0 ? (
                <select
                  value={extraLocations.includes(locationFilter) ? locationFilter : ""}
                  onChange={(e) => onLocationFilter(e.target.value || "__all__")}
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
                <Pill
                  active={locationFilter === "__empty__"}
                  onClick={() =>
                    onLocationFilter(locationFilter === "__empty__" ? "__all__" : "__empty__")
                  }
                >
                  No location
                </Pill>
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
                onChange={(e) => onTeamFilter(e.target.value)}
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
                  <Pill
                    key={value}
                    active={activeFilter === value}
                    onClick={() => onActiveFilter(value)}
                  >
                    {label}
                  </Pill>
                ))}
              </div>
            </div>

            {hasFacetFilters ? (
              <button
                type="button"
                onClick={onClearFilters}
                className="h-8 px-3 rounded-lg border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 sm:ml-auto"
              >
                Clear all
              </button>
            ) : null}
          </div>

          {filterSummary ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Applied</span>
              {locationFilter !== "__all__" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[11px]">
                  {filterLabel(locationFilter, "location")}
                  <button
                    type="button"
                    aria-label="Clear location filter"
                    onClick={() => onLocationFilter("__all__")}
                    className="hover:opacity-70"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ) : null}
              {teamFilter !== "__all__" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[11px]">
                  {filterLabel(teamFilter, "team")}
                  <button
                    type="button"
                    aria-label="Clear team filter"
                    onClick={() => onTeamFilter("__all__")}
                    className="hover:opacity-70"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ) : null}
              {activeFilter !== "__all__" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[11px]">
                  {activeFilter === "yes" ? "Active only" : "Inactive only"}
                  <button
                    type="button"
                    aria-label="Clear active filter"
                    onClick={() => onActiveFilter("__all__")}
                    className="hover:opacity-70"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="p-4 md:p-5 space-y-4">
        {trendError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {trendError.message}
          </div>
        ) : null}

        {trend ? (
          <div
            key={filterKey}
            className="grid gap-2 sm:grid-cols-3 animate-in fade-in duration-300"
          >
            <KpiCard
              label="Prior 7-week avg"
              value={`${trend.priorAverageHours.toFixed(1)}h`}
              sub="Baseline before latest week"
              dimmed={chartBusy}
            />
            <KpiCard
              label="Latest week"
              value={trend.latestWeek ? `${trend.latestWeek.avgHoursWorked.toFixed(1)}h` : "—"}
              sub={
                trend.latestWeek
                  ? `${trend.latestWeek.employeeCount} employees`
                  : "No data this week"
              }
              dimmed={chartBusy}
            />
            <KpiCard
              label="Lift vs baseline"
              value={`${trend.liftHours >= 0 ? "+" : ""}${trend.liftHours.toFixed(1)}h`}
              sub={`${trend.liftPct >= 0 ? "+" : ""}${trend.liftPct}% vs prior avg`}
              tone={liftPositive ? "positive" : "negative"}
              dimmed={chartBusy}
            />
          </div>
        ) : isTrendLoading ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[72px] rounded-lg bg-muted/40 animate-pulse" />
            ))}
          </div>
        ) : null}

        <div className="relative min-h-[300px]">
          {isTrendLoading && chartData.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              Loading trend data…
            </div>
          ) : chartData.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-sm text-muted-foreground text-center px-6">
              <span>No weekly data for this filter.</span>
              {hasFacetFilters ? (
                <button
                  type="button"
                  onClick={onClearFilters}
                  className="text-primary underline text-[12px]"
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <div
                className={`h-[300px] w-full transition-all duration-300 ${
                  isTrendRefetching ? "opacity-35 blur-[1px] scale-[0.99]" : "opacity-100 scale-100"
                }`}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 12, right: 16, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" vertical={false} />
                    <XAxis
                      dataKey="shortLabel"
                      tick={{ fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      domain={[0, "auto"]}
                      tickFormatter={(v) => `${v}h`}
                      axisLine={false}
                      tickLine={false}
                      width={40}
                    />
                    <Tooltip
                      cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const row = payload[0]?.payload as ChartRow;
                        const delta = row.avgHoursWorked - row.priorAvg;
                        return (
                          <div className="rounded-lg border border-border bg-background px-3 py-2 text-[12px] shadow-lg">
                            <div className="font-medium">{row.weekLabel}</div>
                            <div className="text-muted-foreground mt-0.5">
                              {row.employeeCount} employee{row.employeeCount === 1 ? "" : "s"}
                              {row.isCurrentWeek ? " · current week" : ""}
                            </div>
                            <div className="mt-1.5 tabular-nums">
                              Avg: <strong>{row.avgHoursWorked.toFixed(1)}h</strong>
                            </div>
                            <div className="tabular-nums text-muted-foreground">
                              vs baseline {row.priorAvg.toFixed(1)}h (
                              <span
                                className={
                                  delta >= 0
                                    ? "text-emerald-700 dark:text-emerald-300"
                                    : "text-orange-700 dark:text-orange-300"
                                }
                              >
                                {delta >= 0 ? "+" : ""}
                                {delta.toFixed(1)}h
                              </span>
                              )
                            </div>
                          </div>
                        );
                      }}
                    />
                    <ReferenceLine
                      y={trend?.priorAverageHours ?? 0}
                      stroke="var(--chart-4)"
                      strokeDasharray="6 4"
                      strokeOpacity={isTrendRefetching ? 0.4 : 1}
                    />
                    <ReferenceLine
                      y={trend?.targetHours ?? 35}
                      stroke="var(--chart-2)"
                      strokeDasharray="4 4"
                      strokeOpacity={isTrendRefetching ? 0.4 : 1}
                    />
                    <Line
                      type="monotone"
                      dataKey="avgHoursWorked"
                      name="Avg hours"
                      stroke="var(--chart-1)"
                      strokeWidth={2.5}
                      animationDuration={450}
                      animationEasing="ease-out"
                      dot={(props) => {
                        const { cx, cy, payload } = props;
                        if (cx == null || cy == null) return null;
                        const row = payload as ChartRow;
                        const isSelected = activePoint?.weekStart === row.weekStart;
                        return (
                          <circle
                            cx={cx}
                            cy={cy}
                            r={isSelected ? 6 : 4}
                            fill={isSelected ? "var(--chart-1)" : "var(--background)"}
                            stroke="var(--chart-1)"
                            strokeWidth={2}
                            style={{ cursor: "pointer", transition: "r 150ms ease" }}
                            onClick={() => setSelected(row)}
                          />
                        );
                      }}
                      activeDot={{ r: 7, strokeWidth: 0 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {isTrendRefetching ? (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="flex items-center gap-2 rounded-full border border-border bg-background/95 px-4 py-2 text-[12px] shadow-md backdrop-blur-sm">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span>Updating for {filterSummary || "selected filters"}…</span>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground border-t border-border pt-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-5 rounded bg-[var(--chart-1)]" />
            Weekly avg hours
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0 w-5 border-t-2 border-dashed border-[var(--chart-4)]" />
            Prior 7-week baseline
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0 w-5 border-t-2 border-dashed border-[var(--chart-2)]" />
            {trend?.targetHours ?? 35}h target
          </span>
        </div>

        {activePoint && trend ? (
          <div className="rounded-lg border border-border bg-muted/15 px-3 py-2.5 text-[12px] flex flex-wrap gap-x-4 gap-y-1 animate-in fade-in slide-in-from-bottom-1 duration-200">
            <span>
              <strong className="text-foreground">Selected week:</strong> {activePoint.weekLabel}
            </span>
            <span className="tabular-nums">
              <strong className="text-foreground">{activePoint.avgHoursWorked.toFixed(1)}h</strong> avg
              · {activePoint.employeeCount} employees
            </span>
            <span className="tabular-nums">
              vs baseline{" "}
              <strong
                className={
                  activePoint.avgHoursWorked - trend.priorAverageHours >= 0
                    ? "text-emerald-700 dark:text-emerald-300"
                    : "text-orange-700 dark:text-orange-300"
                }
              >
                {activePoint.avgHoursWorked - trend.priorAverageHours >= 0 ? "+" : ""}
                {(activePoint.avgHoursWorked - trend.priorAverageHours).toFixed(1)}h
              </strong>
            </span>
          </div>
        ) : null}

        {trend?.warnings.length ? (
          <div className="text-[11px] text-amber-800 dark:text-amber-200">
            {trend.warnings.map((w) => (
              <div key={w}>• {w}</div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
