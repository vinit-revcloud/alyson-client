import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/AppShell";
import { CostTrackingSkeleton, FetchingBar } from "@/components/Skeleton";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BarChart3, CalendarDays, Captions, DollarSign, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { getRecallCostInsights, getRecallCostReport } from "@/lib/recall-cost-functions";
import type { RecallCostReport } from "@/lib/recall-cost-report.server";
import {
  getCachedRecallCostReport,
  loadRecallCostSession,
  saveRecallCostSession,
} from "@/lib/recall-cost-session";

export const Route = createFileRoute("/alyson-notetaker/cost-tracking")({
  head: () => ({ meta: [{ title: "Recall Cost Tracking — Alyson Notetaker" }] }),
  component: CostTrackingPage,
});

const PERIOD_DAYS = [7, 30, 60, 90] as const;
type PeriodDays = (typeof PERIOD_DAYS)[number];
const DEFAULT_PERIOD: PeriodDays = 30;

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

function rangeForLastDays(days: number) {
  const end = isoDay(new Date());
  const startDate = new Date();
  startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
  return { start: isoDay(startDate), end };
}

function defaultApplied() {
  return { ...rangeForLastDays(DEFAULT_PERIOD), periodDays: DEFAULT_PERIOD };
}

function usd(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function hours(n: number) {
  if (!Number.isFinite(n)) return "—";
  return n < 10 ? `${n.toFixed(1)}h` : `${Math.round(n)}h`;
}

function CostTrackingPage() {
  const boot = useMemo(() => loadRecallCostSession(), []);
  const queryClient = useQueryClient();

  const [applied, setApplied] = useState(() => boot?.applied ?? defaultApplied());
  const [insightsMd, setInsightsMd] = useState<string | null>(() => boot?.insightsMd ?? null);

  const q = useQuery({
    queryKey: ["recall-cost-report", applied.start, applied.end],
    queryFn: () => getRecallCostReport({ data: { start: applied.start, end: applied.end } }),
    staleTime: 60 * 60_000,
    gcTime: 4 * 60 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    placeholderData: (prev) => {
      const cached = getCachedRecallCostReport(applied.start, applied.end);
      if (cached) return { report: cached };
      return prev;
    },
    initialData: () => {
      const cached = getCachedRecallCostReport(applied.start, applied.end);
      return cached ? { report: cached } : undefined;
    },
    retry: 1,
  });

  const report = q.data?.report;
  const coldLoad = q.isPending && !report;
  const isRefreshing = q.isFetching && Boolean(report);

  useEffect(() => {
    if (!report) return;
    saveRecallCostSession({
      applied,
      insightsMd,
      report,
    });
  }, [report, applied, insightsMd]);

  const insightsM = useMutation({
    mutationFn: async () => {
      if (!report) throw new Error("Load cost report first");
      return getRecallCostInsights({ data: { report } });
    },
    onSuccess: (r) => {
      setInsightsMd(r.insightsMd);
      toast.success("AI insights ready");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const chartData = useMemo(() => {
    if (!report) return [];
    return report.daily.map((d) => ({
      day: d.day.slice(5),
      botCost: Number(d.botCostUsd.toFixed(2)),
      transcriptCost: Number(d.transcriptCostUsd.toFixed(2)),
      cost: Number(d.totalCostUsd.toFixed(2)),
      meetings: d.meetings,
      hours: Number(d.botHours.toFixed(2)),
    }));
  }, [report]);

  const applyPeriod = (days: PeriodDays) => {
    const range = rangeForLastDays(days);
    const next = { ...range, periodDays: days };
    const cached = getCachedRecallCostReport(next.start, next.end);
    if (cached) {
      queryClient.setQueryData(["recall-cost-report", next.start, next.end], { report: cached });
    }
    setApplied(next);
    setInsightsMd(null);
    if (cached) {
      saveRecallCostSession({ applied: next, insightsMd: null, report: cached });
    }
  };

  return (
    <div className="ops-dense">
      <PageHeader
        eyebrow="Operations"
        title="Recall cost tracking"
        description="Bot ($0.50/hr) + Recall transcription ($0.15/hr) from billing API, with meeting counts from S3."
        dense
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/alyson-notetaker/calendar"
              className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
            >
              <CalendarDays className="h-3.5 w-3.5" />
              Calendar
            </Link>
            <Link
              to="/alyson-notetaker/analytics"
              className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
            >
              <BarChart3 className="h-3.5 w-3.5" />
              Analytics
            </Link>
            <Link
              to="/alyson-notetaker"
              reloadDocument
              className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
            >
              <Captions className="h-3.5 w-3.5" />
              Notetaker
            </Link>
          </div>
        }
      />

      <div className="px-5 md:px-8 py-6 space-y-5">
        <FetchingBar active={isRefreshing} />

        <div className="surface-card p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Period</span>
            {PERIOD_DAYS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => applyPeriod(d)}
                disabled={coldLoad && applied.periodDays === d}
                className={
                  "h-7 px-3 rounded-full text-[11.5px] font-medium border transition-colors disabled:opacity-50 " +
                  (applied.periodDays === d
                    ? "bg-foreground text-background border-foreground"
                    : "bg-paper border-border text-muted-foreground hover:text-foreground")
                }
              >
                Last {d} days
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                void q.refetch();
                toast.message("Refreshing cost data…");
              }}
              disabled={q.isFetching}
              className="ml-auto h-7 px-2.5 rounded-md border border-border text-[11px] inline-flex items-center gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
          <div className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {applied.start} → {applied.end}
            </span>
            {isRefreshing ? (
              <span className="text-foreground/70">Updating…</span>
            ) : null}
            {report && !report.recallConfigured ? (
              <span className="text-amber-600 dark:text-amber-400">
                RECALL_API_KEY not set — usage from Recall unavailable.
              </span>
            ) : null}
          </div>
        </div>

        {q.isError && !report ? (
          <div className="surface-card p-4 text-sm text-destructive">
            {(q.error as Error)?.message || "Failed to load cost report"}
          </div>
        ) : null}

        {coldLoad ? <CostTrackingSkeleton /> : null}

        {report ? (
          <div className={isRefreshing ? "opacity-80 transition-opacity" : undefined}>
            <CostTrackingContent
              report={report}
              chartData={chartData}
              insightsMd={insightsMd}
              insightsPending={insightsM.isPending}
              onGenerateInsights={() => insightsM.mutate()}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

type ChartPoint = {
  day: string;
  botCost: number;
  transcriptCost: number;
  cost: number;
  meetings: number;
  hours: number;
};

function CostTrackingContent({
  report,
  chartData,
  insightsMd,
  insightsPending,
  onGenerateInsights,
}: {
  report: RecallCostReport;
  chartData: ChartPoint[];
  insightsMd: string | null;
  insightsPending: boolean;
  onGenerateInsights: () => void;
}) {
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi label="Total (period)" value={usd(report.costs.totalUsageCostUsd)} hint={hours(report.usage.botTotalHours)} />
        <Kpi label="Bot cost" value={usd(report.costs.botUsageCostUsd)} hint={`$${report.costs.botHourRateUsd}/hr`} />
        <Kpi label="Transcript cost" value={usd(report.costs.transcriptUsageCostUsd)} hint={`$${report.costs.transcriptHourRateUsd}/hr`} />
        <Kpi
          label="Cost / Recall bot"
          value={usd(report.costs.costPerRecallMeetingUsd ?? report.costs.costPerMeetingUsd)}
          hint={
            report.meetings.withBot > 0
              ? `${report.meetings.withBot} Recall bots · $${report.costs.combinedHourRateUsd.toFixed(2)}/hr`
              : `${report.meetings.total} S3 meetings (no bot id)`
          }
        />
        <Kpi
          label="This month"
          value={usd(report.calendarMonth.totalUsageCostUsd)}
          hint={`${hours(report.calendarMonth.botTotalHours)} billed · ${report.calendarMonth.withBot} Recall · ${report.calendarMonth.meetings} S3`}
        />
        <Kpi label="Bots created" value={String(report.meetings.botsCreated)} hint="S3 bot-index in range" />
      </div>

      {report.calendarMonth.meetings > report.calendarMonth.withBot + 5 ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-900 dark:text-amber-200">
          Recall bills by <strong>bot hours</strong> (${report.costs.combinedHourRateUsd.toFixed(2)}/hr = bot + transcript), not per S3 meeting.
          {" "}
          This month: {hours(report.calendarMonth.botTotalHours)} billed from Recall vs {report.calendarMonth.meetings} S3 folders
          ({report.calendarMonth.withBot} linked to a Recall bot).
          {" "}
          A 1-hour meeting ≈ ${report.costs.combinedHourRateUsd.toFixed(2)}; shorter meetings cost less.
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Daily usage cost" subtitle="Estimated split of period total by meeting count (1 Recall API call per range)">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="day" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `$${v}`} />
              <Tooltip formatter={(v: number) => usd(v)} />
              <Legend />
              <Bar dataKey="botCost" stackId="cost" fill="var(--chart-1)" name="Bot" radius={[0, 0, 0, 0]} />
              <Bar dataKey="transcriptCost" stackId="cost" fill="var(--chart-2)" name="Transcription" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Meetings per day" subtitle="Persisted meetings in S3">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="day" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="meetings" stroke="var(--chart-2)" name="Meetings" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="hours" stroke="var(--chart-3)" name="Bot hours" dot={false} strokeWidth={2} yAxisId={0} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="surface-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-medium text-[13px] flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" />
              AI cost insights
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              Summarizes bot vs transcription spend and cost per meeting.
            </div>
          </div>
          <button
            type="button"
            onClick={onGenerateInsights}
            disabled={insightsPending}
            className="h-8 px-3 rounded-md bg-foreground text-background text-[11.5px] font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {insightsPending ? "Analyzing…" : "Generate insights"}
          </button>
        </div>
        {insightsMd ? (
          <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] whitespace-pre-wrap border-t border-border pt-3">
            {insightsMd}
          </div>
        ) : (
          <div className="text-[12px] text-muted-foreground">No insights yet — click Generate.</div>
        )}
      </div>

      <CostBreakdownTable report={report} />
    </>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="surface-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-display text-xl mt-1 flex items-center gap-1.5">
        <DollarSign className="h-4 w-4 text-muted-foreground opacity-60" />
        {value}
      </div>
      {hint && <div className="text-[10px] text-muted-foreground mt-1">{hint}</div>}
    </div>
  );
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="surface-card p-4">
      <div className="font-medium text-[13px]">{title}</div>
      <div className="text-[11px] text-muted-foreground mb-3">{subtitle}</div>
      {children}
    </div>
  );
}

function CostBreakdownTable({ report }: { report: RecallCostReport }) {
  return (
    <div className="surface-card p-4 overflow-x-auto">
      <div className="font-medium text-[13px] mb-3">Rate assumptions</div>
      <table className="w-full text-[12px]">
        <tbody className="divide-y divide-border">
          <Row label="Bot hour rate" value={`${usd(report.costs.botHourRateUsd)}/hr`} />
          <Row label="Transcription rate" value={`${usd(report.costs.transcriptHourRateUsd)}/hr`} />
          <Row label="Combined rate" value={`${usd(report.costs.combinedHourRateUsd)}/hr (not per meeting)`} />
          <Row label="S3 meetings in period" value={String(report.meetings.total)} />
          <Row label="S3 meetings with Recall bot id" value={String(report.meetings.withBot)} />
          <Row label="Avg cost / Recall bot (period)" value={usd(report.costs.costPerRecallMeetingUsd)} />
          <Row label="Avg cost / S3 meeting (period)" value={usd(report.costs.costPerMeetingUsd)} />
          <Row label="Meetings with transcript" value={String(report.meetings.withTranscript)} />
          <Row label="Meetings with notes" value={String(report.meetings.withNotes)} />
          <Row label="Period total" value={usd(report.costs.totalUsageCostUsd)} />
          <Row label="Month bot hours (Recall)" value={hours(report.calendarMonth.botTotalHours)} />
          <Row label="Month total" value={usd(report.calendarMonth.totalUsageCostUsd)} />
        </tbody>
      </table>
      <p className="text-[10px] text-muted-foreground mt-3">
        Dollar totals come from{" "}
        <a href="https://docs.recall.ai/reference/billing_usage_retrieve" className="underline" target="_blank" rel="noreferrer">
          Recall billing API
        </a>{" "}
        (actual bot seconds × hourly rates). S3 meeting counts include every notes/transcript folder — many are not Recall-billed.
        Transcription cost uses the same active bot hours (Recall.ai streaming transcript).
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td className="py-2 pr-4 text-muted-foreground">{label}</td>
      <td className="py-2 font-medium text-right">{value}</td>
    </tr>
  );
}
