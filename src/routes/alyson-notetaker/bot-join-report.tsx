import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/AppShell";
import { BotJoinReportSkeleton, FetchingBar } from "@/components/Skeleton";
import {
  AlertTriangle,
  BarChart3,
  Bot,
  CalendarDays,
  Captions,
  CheckCircle2,
  Clock,
  DoorOpen,
  Download,
  RefreshCw,
  XCircle,
} from "lucide-react";
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
import { toast } from "sonner";
import {
  clearBotJoinReportSession,
  getCachedBotJoinReport,
  loadBotJoinReportSession,
  saveBotJoinReportSession,
} from "@/lib/bot-join-report-session";
import { getBotJoinReport } from "@/lib/notetaker-bot-join-functions";
import { downloadBotJoinReportPdf } from "@/lib/notetaker-bot-join-report-pdf";
import {
  DEFAULT_BOT_JOIN_REPORT_EMAIL,
  BOT_JOIN_REPORT_24H_WINDOW_HOURS,
  type BotJoinReport,
  type BotJoinReportRow,
} from "@/lib/notetaker-bot-join-report.types";

const PIE_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

export const Route = createFileRoute("/alyson-notetaker/bot-join-report")({
  head: () => ({ meta: [{ title: "Bot Join Report — Alyson Notetaker" }] }),
  component: BotJoinReportPage,
});

const PERIOD_DAYS = [7, 15, 30, 60] as const;
type PeriodDays = (typeof PERIOD_DAYS)[number];
const DEFAULT_PERIOD: PeriodDays = 30;

type AppliedFilter = {
  start: string;
  end: string;
  periodDays: number;
  windowHours?: number;
};

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

function rangeForLastDays(days: number) {
  const end = isoDay(new Date());
  const startDate = new Date();
  startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
  return { start: isoDay(startDate), end };
}

function rangeForLast24Hours(): AppliedFilter {
  const end = new Date();
  const start = new Date(end.getTime() - BOT_JOIN_REPORT_24H_WINDOW_HOURS * 3600_000);
  return {
    start: isoDay(start),
    end: isoDay(end),
    periodDays: 0,
    windowHours: BOT_JOIN_REPORT_24H_WINDOW_HOURS,
  };
}

function defaultApplied(): AppliedFilter {
  return { ...rangeForLastDays(DEFAULT_PERIOD), periodDays: DEFAULT_PERIOD };
}

function isLast24HoursApplied(applied: AppliedFilter) {
  return applied.windowHours === BOT_JOIN_REPORT_24H_WINDOW_HOURS;
}

function formatTs(iso: string | null | undefined) {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusBadge(row: BotJoinReportRow) {
  if (row.joinedMeeting) {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
        Joined
      </span>
    );
  }
  if (row.stuckInWaitingRoom) {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-800 dark:text-amber-200">
        Waiting room
      </span>
    );
  }
  if (row.finalStatus === "fatal") {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-red-500/15 text-red-700 dark:text-red-300">
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">
      Not joined
    </span>
  );
}

function lateBadge(label: string, minutes: number | null) {
  if (!label || label === "—") return <span className="text-muted-foreground">—</span>;
  if (label === "On time" || minutes == null) {
    return <span className="text-emerald-600 dark:text-emerald-400">{label}</span>;
  }
  return <span className="text-amber-700 dark:text-amber-300 font-medium">{label}</span>;
}

function BotJoinReportPage() {
  const calendarEmail = DEFAULT_BOT_JOIN_REPORT_EMAIL;
  const queryClient = useQueryClient();
  const boot = useMemo(() => loadBotJoinReportSession(), []);
  const forceRefreshRef = useRef(false);

  const [applied, setApplied] = useState(() => boot?.applied ?? defaultApplied());

  const q = useQuery({
    queryKey: ["bot-join-report", applied.start, applied.end, calendarEmail, applied.windowHours ?? null],
    queryFn: () =>
      getBotJoinReport({
        data: {
          start: applied.start,
          end: applied.end,
          calendarEmail,
          forceRefresh: forceRefreshRef.current,
          windowHours: applied.windowHours,
        },
      }),
    staleTime: applied.windowHours ? 5 * 60_000 : 30 * 60_000,
    gcTime: 60 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    placeholderData: keepPreviousData,
    initialData: () => {
      const cached = getCachedBotJoinReport(
        calendarEmail,
        applied.start,
        applied.end,
        applied.windowHours,
      );
      return cached ? { report: cached } : undefined;
    },
    retry: 1,
  });

  const report = q.data?.report;
  const coldLoad = q.isPending && !report;
  const isRefreshing = q.isFetching && Boolean(report);

  useEffect(() => {
    if (!report) return;
    saveBotJoinReportSession({ applied, calendarEmail, report });
  }, [report, applied, calendarEmail]);

  useEffect(() => {
    return () => {
      clearBotJoinReportSession();
      queryClient.removeQueries({ queryKey: ["bot-join-report"] });
    };
  }, [queryClient]);

  const applyPeriod = (days: PeriodDays) => {
    const range = rangeForLastDays(days);
    const next: AppliedFilter = { ...range, periodDays: days };
    const cached = getCachedBotJoinReport(calendarEmail, next.start, next.end);
    if (cached) {
      queryClient.setQueryData(
        ["bot-join-report", next.start, next.end, calendarEmail, null],
        { report: cached },
      );
      saveBotJoinReportSession({ applied: next, calendarEmail, report: cached });
    }
    setApplied(next);
  };

  const applyLast24Hours = () => {
    const next = rangeForLast24Hours();
    const cached = getCachedBotJoinReport(
      calendarEmail,
      next.start,
      next.end,
      next.windowHours,
    );
    if (cached) {
      queryClient.setQueryData(
        ["bot-join-report", next.start, next.end, calendarEmail, next.windowHours ?? null],
        { report: cached },
      );
      saveBotJoinReportSession({ applied: next, calendarEmail, report: cached });
    }
    setApplied(next);
  };

  const handleRefresh = () => {
    forceRefreshRef.current = true;
    void q.refetch().finally(() => {
      forceRefreshRef.current = false;
    });
    toast.message("Refreshing bot join report…");
  };
  const c = report?.critical;

  const periodLabel = useMemo(() => {
    if (isLast24HoursApplied(applied)) {
      const windowStart = report?.range.windowStart;
      if (windowStart) {
        return `Last 24 hours (since ${formatTs(windowStart)})`;
      }
      return "Last 24 hours (rolling)";
    }
    if (applied.start === applied.end) return applied.start;
    return `${applied.start} → ${applied.end}`;
  }, [applied, report?.range.windowStart]);

  const chartDaily = useMemo(() => {
    if (!report?.daily?.length) return [];
    return report.daily.filter((d) => d.eligibleMeetings > 0 || d.meetingsJoined > 0);
  }, [report?.daily]);

  const outcomePie = useMemo(() => {
    if (!c) return [];
    return [
      { name: "Joined", value: c.meetingsJoined },
      { name: "Missed", value: c.meetingsMissed },
      { name: "Failed", value: c.failedJoins },
      { name: "Not joined", value: c.scheduledNotJoined },
    ].filter((x) => x.value > 0);
  }, [c]);

  const handleDownloadPdf = () => {
    if (!report) return;
    try {
      downloadBotJoinReportPdf(report);
      toast.success("PDF downloaded");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "PDF export failed");
    }
  };

  return (
    <div className="ops-dense">
      <PageHeader
        eyebrow="Operations"
        title="Bot join report"
        description={`Critical join metrics for ${calendarEmail} — how many meetings Alyson joined, which ones, join %, and lateness vs scheduled start.`}
        dense
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/alyson-notetaker/analytics"
              className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
            >
              <BarChart3 className="h-3.5 w-3.5" />
              Analytics
            </Link>
            <Link
              to="/alyson-notetaker/unified-meetings"
              className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
            >
              <CalendarDays className="h-3.5 w-3.5" />
              Unified Meetings
            </Link>
            <Link
              to="/alyson-notetaker"
              reloadDocument
              className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
            >
              <Captions className="h-3.5 w-3.5" />
              Alyson Notetaker
            </Link>
          </div>
        }
      />

      <div className="px-5 md:px-8 py-6 space-y-5">
        <div className="surface-card p-4 space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Period</span>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={applyLast24Hours}
                  disabled={coldLoad && isLast24HoursApplied(applied)}
                  className={
                    "h-7 px-3 rounded-full text-[11.5px] font-medium border transition-colors " +
                    (isLast24HoursApplied(applied)
                      ? "bg-foreground text-background border-foreground"
                      : "bg-paper border-border text-muted-foreground hover:text-foreground")
                  }
                >
                  Last 24 hours
                </button>
                {PERIOD_DAYS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => applyPeriod(d)}
                    disabled={coldLoad && applied.periodDays === d && !applied.windowHours}
                    className={
                      "h-7 px-3 rounded-full text-[11.5px] font-medium border transition-colors " +
                      (applied.periodDays === d && !applied.windowHours
                        ? "bg-foreground text-background border-foreground"
                        : "bg-paper border-border text-muted-foreground hover:text-foreground")
                    }
                  >
                    Last {d} days
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={handleDownloadPdf}
              disabled={!report}
              className="h-8 px-3 rounded-md border border-border bg-background text-[12px] font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              Download PDF
            </button>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={q.isFetching}
              className="h-8 px-3 rounded-md border border-border bg-background text-[12px] font-medium inline-flex items-center gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
          <p className="text-[12px] text-muted-foreground">
            Account: <span className="text-foreground font-medium">{calendarEmail}</span>
            {" · "}
            Window: <span className="text-foreground font-medium">{periodLabel}</span>
            {isRefreshing ? <span className="text-foreground/70"> · Updating…</span> : null}
            {report?.generatedAt ? <> · Generated {formatTs(report.generatedAt)}</> : null}
          </p>
        </div>

        <FetchingBar active={isRefreshing} />

        {q.isError && !report ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-4 py-3 space-y-1">
            <p className="text-sm font-medium text-red-700 dark:text-red-300">Failed to load report</p>
            <p className="text-[12px] text-red-600 dark:text-red-400">{(q.error as Error).message}</p>
            <p className="text-[11px] text-muted-foreground pt-1">
              Try Refresh. Large date ranges can take a minute on first load.
            </p>
          </div>
        ) : null}

        {coldLoad ? <BotJoinReportSkeleton /> : null}

        {report ? (
          <div className={isRefreshing ? "opacity-90 transition-opacity space-y-5" : "space-y-5"}>
            <DiagnosticsPanel report={report} />

            {!report.recallConfigured ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-900 dark:text-amber-200">
                <strong>RECALL_API_KEY</strong> is not set — join/lateness details need Recall bot status history.
              </div>
            ) : null}
            {!report.calendarAvailable && report.calendarError ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-900 dark:text-amber-200">
                Calendar baseline unavailable: {report.calendarError}. Join % uses bot data only.
              </div>
            ) : null}

            <div className="surface-card p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-primary" />
                <h3 className="font-display text-base">Critical metrics</h3>
              </div>
              {c ? (
              <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <CriticalKpi
                  label="Meetings joined"
                  value={String(c.meetingsJoined)}
                  sub={`of ${c.totalEligibleMeetings} eligible`}
                  icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />}
                  highlight
                />
                <CriticalKpi
                  label="Join rate"
                  value={c.joinRatePercent != null ? `${c.joinRatePercent}%` : "—"}
                  sub="Joined ÷ eligible calendar meetings"
                  icon={<DoorOpen className="h-4 w-4" />}
                />
                <CriticalKpi
                  label="Avg minutes late"
                  value={c.avgLateMinutes != null ? `${c.avgLateMinutes}m` : "—"}
                  sub={`${c.meetingsJoinedLate} joined late (>2m after start)`}
                  icon={<Clock className="h-4 w-4" />}
                />
                <CriticalKpi
                  label="Max minutes late"
                  value={c.maxLateMinutes != null ? `${c.maxLateMinutes}m` : "—"}
                  sub="Worst admission delay vs start"
                  icon={<AlertTriangle className="h-4 w-4 text-amber-600" />}
                />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-1 border-t border-border">
                <MiniStat label="Missed meetings" value={c.meetingsMissed} tone="bad" />
                <MiniStat label="Stuck in waiting room" value={c.stuckInWaitingRoom} tone="warn" />
                <MiniStat label="Failed joins" value={c.failedJoins} tone="bad" />
                <MiniStat label="Scheduled, not joined" value={c.scheduledNotJoined} tone="muted" />
              </div>
              </>
              ) : null}
            </div>

            {chartDaily.length > 0 ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <ChartCard title="Join rate over time" subtitle="Daily % of eligible meetings joined">
                  <ResponsiveContainer width="100%" height={240}>
                    <LineChart data={chartDaily}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                      <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                      <Tooltip formatter={(v: number) => `${v}%`} />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="joinRatePercent"
                        name="Join rate"
                        stroke="var(--chart-1)"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </ChartCard>

                <ChartCard title="Meetings per day" subtitle="Eligible vs joined vs missed">
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={chartDaily}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                      <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="eligibleMeetings" fill="var(--chart-4)" name="Eligible" radius={[2, 2, 0, 0]} />
                      <Bar dataKey="meetingsJoined" fill="var(--chart-1)" name="Joined" radius={[2, 2, 0, 0]} />
                      <Bar dataKey="meetingsMissed" fill="var(--chart-3)" name="Missed" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>

                <ChartCard title="Lateness trend" subtitle="Avg minutes late per day (when late)">
                  <ResponsiveContainer width="100%" height={240}>
                    <LineChart data={chartDaily}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                      <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}m`} />
                      <Tooltip formatter={(v: number | null) => (v != null ? `${v}m` : "—")} />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="avgLateMinutes"
                        name="Avg late"
                        stroke="var(--chart-2)"
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                      <Line
                        type="monotone"
                        dataKey="maxLateMinutes"
                        name="Max late"
                        stroke="var(--chart-5)"
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </ChartCard>

                {outcomePie.length > 0 ? (
                  <ChartCard title="Join outcomes" subtitle="Period totals">
                    <ResponsiveContainer width="100%" height={240}>
                      <PieChart>
                        <Pie data={outcomePie} dataKey="value" nameKey="name" innerRadius={50} outerRadius={85} paddingAngle={2}>
                          {outcomePie.map((_, i) => (
                            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip />
                        <Legend />
                      </PieChart>
                    </ResponsiveContainer>
                  </ChartCard>
                ) : null}
              </div>
            ) : null}

            <MeetingTable
              title="Meetings Alyson joined"
              description={`${report.joinedMeetings.length} meeting(s) where the bot was admitted to the call.`}
              rows={report.joinedMeetings}
              emptyMessage="No successful joins in this period."
              showLate
            />

            {report.missedMeetings.length > 0 ? (
              <div className="surface-card overflow-hidden">
                <div className="px-4 py-3 border-b border-border">
                  <h3 className="font-display text-base flex items-center gap-2">
                    <XCircle className="h-4 w-4 text-red-500" />
                    Eligible meetings not joined
                  </h3>
                  <p className="text-[12px] text-muted-foreground mt-0.5">
                    {report.missedMeetings.length} calendar meeting(s) with a Meet link where Alyson did not join the call.
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border text-left text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Meeting</th>
                        <th className="px-3 py-2 font-medium">Scheduled start</th>
                        <th className="px-3 py-2 font-medium">Meet link</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.missedMeetings.map((m) => (
                        <tr key={m.dedupeKey} className="border-b border-border/60 hover:bg-muted/20">
                          <td className="px-3 py-2.5 font-medium">{m.title}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap">{formatTs(m.startTime)}</td>
                          <td className="px-3 py-2.5">
                            <a
                              href={m.meetingUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary hover:underline truncate block max-w-[240px]"
                            >
                              {m.meetingUrl.replace(/^https?:\/\//, "")}
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            <MeetingTable
              title="All bot attempts"
              description="Full log including waiting room, lateness, and Recall status."
              rows={report.rows}
              emptyMessage="No bots scheduled in this period."
              showLate
            />
          </div>
        ) : !coldLoad && !q.isError ? (
          <div className="text-sm text-muted-foreground">No report data — click Refresh.</div>
        ) : null}
      </div>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="surface-card p-4 space-y-2">
      <div>
        <h3 className="font-display text-base">{title}</h3>
        <p className="text-[12px] text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function DiagnosticsPanel({ report }: { report: BotJoinReport }) {
  const d = report.diagnostics;
  return (
    <div className="surface-card p-4 space-y-2 text-[12px]">
      <div className="font-medium text-foreground">Data sources</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>Notetaker sessions: {d.botsFromNotetakerSessions}</span>
        <span>Unified schedule: {d.botsFromUnifiedState}</span>
        <span>S3 index: {d.botsFromS3Index}</span>
        <span>Recall calendar: {d.botsFromRecallCalendar}</span>
        <span>Calendar eligible: {report.critical.totalEligibleMeetings}</span>
        <span>Recall API: {report.recallConfigured ? "configured" : "missing"}</span>
        <span>Google DWD: {report.calendarAvailable ? "ok" : "unavailable"}</span>
        {d.recallBotsFromListApi != null ? (
          <span>List API bots: {d.recallBotsFromListApi}</span>
        ) : null}
        {d.recallBotsFromCache != null ? (
          <span>Cached: {d.recallBotsFromCache}</span>
        ) : null}
        {d.recallBotsSkippedFetch ? (
          <span className="text-amber-700 dark:text-amber-300">
            Skipped fetch: {d.recallBotsSkippedFetch}
          </span>
        ) : null}
      </div>
      {d.warnings.length > 0 ? (
        <ul className="space-y-1 pt-1 border-t border-border">
          {d.warnings.map((w) => (
            <li key={w} className="text-amber-800 dark:text-amber-200">
              • {w}
            </li>
          ))}
        </ul>
      ) : null}
      {report.calendarError ? (
        <p className="text-amber-800 dark:text-amber-200">Calendar: {report.calendarError}</p>
      ) : null}
    </div>
  );
}

function MeetingTable({
  title,
  description,
  rows,
  emptyMessage,
  showLate,
}: {
  title: string;
  description: string;
  rows: BotJoinReportRow[];
  emptyMessage: string;
  showLate?: boolean;
}) {
  return (
    <div className="surface-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
        <div>
          <h3 className="font-display text-base">{title}</h3>
          <p className="text-[12px] text-muted-foreground mt-0.5">{description}</p>
        </div>
        <span className="text-[11px] text-muted-foreground">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-sm text-muted-foreground text-center">{emptyMessage}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Meeting</th>
                <th className="px-3 py-2 font-medium">Scheduled start</th>
                <th className="px-3 py-2 font-medium">Admitted</th>
                {showLate ? <th className="px-3 py-2 font-medium">Late to start</th> : null}
                <th className="px-3 py-2 font-medium">Waiting room</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.botId} className="border-b border-border/60 hover:bg-muted/20">
                  <td className="px-3 py-2.5 align-top">
                    <div className="font-medium text-foreground max-w-[240px] truncate" title={row.title}>
                      {row.title}
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono mt-0.5" title={row.botId}>
                      {row.botId.slice(0, 10)}…
                    </div>
                  </td>
                  <td className="px-3 py-2.5 align-top whitespace-nowrap">{formatTs(row.scheduledStart)}</td>
                  <td className="px-3 py-2.5 align-top whitespace-nowrap">{formatTs(row.admittedAt)}</td>
                  {showLate ? (
                    <td className="px-3 py-2.5 align-top whitespace-nowrap">
                      {lateBadge(row.lateToStartLabel, row.lateMinutes)}
                    </td>
                  ) : null}
                  <td className="px-3 py-2.5 align-top whitespace-nowrap">{row.waitingRoomLabel}</td>
                  <td className="px-3 py-2.5 align-top">{statusBadge(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CriticalKpi({
  label,
  value,
  sub,
  icon,
  highlight,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div className={"rounded-lg border p-3 space-y-1 " + (highlight ? "border-emerald-500/30 bg-emerald-500/5" : "border-border")}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
        {icon}
      </div>
      <div className="text-2xl font-display font-semibold">{value}</div>
      <div className="text-[11px] text-muted-foreground leading-snug">{sub}</div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "bad" | "warn" | "muted";
}) {
  const color =
    tone === "bad"
      ? "text-red-600 dark:text-red-400"
      : tone === "warn"
        ? "text-amber-700 dark:text-amber-300"
        : "text-muted-foreground";
  return (
    <div className="text-center md:text-left">
      <div className={"text-lg font-semibold " + color}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}
