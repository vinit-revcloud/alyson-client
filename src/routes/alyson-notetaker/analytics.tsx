import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import {
  analyticsQueryKey,
  loadAnalyticsSession,
  saveAnalyticsSession,
} from "@/lib/notetaker-analytics-session";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { PageHeader } from "@/components/AppShell";
import { BarChart3, CalendarDays, Captions, Download, FileText, Sparkles, X } from "lucide-react";
import {
  analyticsExportFilename,
  buildAnalyticsExportHtml,
  downloadAnalyticsHtml,
  printAnalyticsExport,
} from "@/lib/notetaker-analytics-export";
import { downloadAnalyticsPdf } from "@/lib/notetaker-analytics-pdf";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getNotetakerAnalyticsInsights, getNotetakerAnalyticsReport } from "@/lib/notetaker-analytics-functions";
import { listMeetingsFromS3Range } from "@/lib/notetaker-s3-calendar-functions";
import { dateMatchesSearchQuery, textMatchesSearchQuery } from "@/lib/fuzzy-text-search";
import { toast } from "sonner";

export const Route = createFileRoute("/alyson-notetaker/analytics")({
  head: () => ({ meta: [{ title: "Meeting Analytics — Alyson Notetaker" }] }),
  component: AnalyticsPage,
});

const PIE_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

const PERIOD_DAYS = [7, 15, 30, 45, 60, 90] as const;
type PeriodDays = (typeof PERIOD_DAYS)[number];
const DEFAULT_PERIOD: PeriodDays = 30;
const MAX_CUSTOM_RANGE_DAYS = 365;

type PeriodMode = "preset" | "custom";

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

function isIsoDate(v: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function rangeForLastDays(days: number) {
  const end = new Date();
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - days);
  return { start: isoDay(start), end: isoDay(end) };
}

function daysBetweenInclusive(start: string, end: string) {
  const s = new Date(`${start}T00:00:00Z`).getTime();
  const e = new Date(`${end}T00:00:00Z`).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return 0;
  return Math.floor((e - s) / 86400000) + 1;
}

function validateCustomRange(start: string, end: string): string | null {
  if (!isIsoDate(start) || !isIsoDate(end)) return "Enter valid start and end dates (YYYY-MM-DD).";
  if (start > end) return "Start date must be on or before end date.";
  const today = isoDay(new Date());
  if (end > today) return "End date cannot be in the future.";
  const span = daysBetweenInclusive(start, end);
  if (span < 1) return "Range must include at least one day.";
  if (span > MAX_CUSTOM_RANGE_DAYS) return `Range cannot exceed ${MAX_CUSTOM_RANGE_DAYS} days.`;
  return null;
}

function inferPeriodMode(applied: { periodDays: number; start: string; end: string }): PeriodMode {
  const expected = rangeForLastDays(asPeriodDays(applied.periodDays));
  if (applied.start === expected.start && applied.end === expected.end) return "preset";
  return "custom";
}

type AppliedFilters = {
  periodMode: PeriodMode;
  periodDays: PeriodDays;
  start: string;
  end: string;
  speakers: string[];
  meetingPrefixes: string[];
};

type MeetingOption = {
  prefix: string;
  day: string;
  title: string;
  transcriptKey: string | null;
};

function speakersEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const norm = (list: string[]) => [...list].map((s) => s.trim().toLowerCase()).sort();
  const sa = norm(a);
  const sb = norm(b);
  return sa.every((v, i) => v === sb[i]);
}

function prefixesEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function draftMatchesApplied(
  periodMode: PeriodMode,
  periodDays: PeriodDays,
  customStart: string,
  customEnd: string,
  speakers: string[],
  meetingPrefixes: string[],
  applied: AppliedFilters | null,
) {
  if (!applied) return false;
  const periodMatch =
    periodMode === applied.periodMode &&
    (periodMode === "preset"
      ? periodDays === applied.periodDays
      : customStart === applied.start && customEnd === applied.end);
  return (
    periodMatch &&
    speakersEqual(speakers, applied.speakers) &&
    prefixesEqual(meetingPrefixes, applied.meetingPrefixes)
  );
}

function formatAppliedPeriod(applied: AppliedFilters) {
  if (applied.periodMode === "custom") {
    return `${applied.start} → ${applied.end}`;
  }
  return `Last ${applied.periodDays} days (${applied.start} → ${applied.end})`;
}

type MeetingNavTarget = {
  title: string;
  day: string;
  prefix: string;
  transcriptKey: string;
};

function asPeriodDays(n: number): PeriodDays {
  return (PERIOD_DAYS as readonly number[]).includes(n) ? (n as PeriodDays) : DEFAULT_PERIOD;
}

function bootstrapFromSession() {
  const s = loadAnalyticsSession();
  if (!s) return null;
  const periodDays = asPeriodDays(s.applied.periodDays);
  const periodMode = s.applied.periodMode ?? s.periodMode ?? inferPeriodMode(s.applied);
  const applied: AppliedFilters = {
    periodMode,
    periodDays,
    start: s.applied.start,
    end: s.applied.end,
    speakers: s.applied.speakers,
    meetingPrefixes: s.applied.meetingPrefixes ?? [],
  };
  return {
    applied,
    periodMode,
    periodDays: asPeriodDays(s.periodDays),
    customStart: s.customStart ?? s.applied.start,
    customEnd: s.customEnd ?? s.applied.end,
    speakerChips: s.speakerChips,
    selectedMeetingPrefixes: s.selectedMeetingPrefixes ?? s.applied.meetingPrefixes ?? [],
    meetingSearch: s.meetingSearch ?? "",
    insightsMd: s.insightsMd,
  };
}

function AnalyticsPage() {
  const navigate = useNavigate();
  const boot = useMemo(() => bootstrapFromSession(), []);

  const [periodMode, setPeriodMode] = useState<PeriodMode>(() => boot?.periodMode ?? "preset");
  const [periodDays, setPeriodDays] = useState<PeriodDays>(() => boot?.periodDays ?? DEFAULT_PERIOD);
  const [customStart, setCustomStart] = useState(() => boot?.customStart ?? rangeForLastDays(DEFAULT_PERIOD).start);
  const [customEnd, setCustomEnd] = useState(() => boot?.customEnd ?? rangeForLastDays(DEFAULT_PERIOD).end);
  const [speakerChips, setSpeakerChips] = useState<string[]>(() => boot?.speakerChips ?? []);
  const [selectedMeetingPrefixes, setSelectedMeetingPrefixes] = useState<string[]>(
    () => boot?.selectedMeetingPrefixes ?? [],
  );
  const [meetingSearch, setMeetingSearch] = useState(() => boot?.meetingSearch ?? "");
  /** Set when user clicks Apply; restored from session when returning to this page. */
  const [applied, setApplied] = useState<AppliedFilters | null>(() => boot?.applied ?? null);
  const [insightsMd, setInsightsMd] = useState<string | null>(() => boot?.insightsMd ?? null);
  const [goToMeeting, setGoToMeeting] = useState<MeetingNavTarget | null>(null);

  const draftRange = useMemo(
    () => (periodMode === "preset" ? rangeForLastDays(periodDays) : { start: customStart, end: customEnd }),
    [periodMode, periodDays, customStart, customEnd],
  );

  const filtersDirty = !draftMatchesApplied(
    periodMode,
    periodDays,
    customStart,
    customEnd,
    speakerChips,
    selectedMeetingPrefixes,
    applied,
  );

  const meetingsQ = useQuery({
    queryKey: ["notetaker-analytics-meetings", draftRange.start, draftRange.end],
    queryFn: () => listMeetingsFromS3Range({ data: draftRange }),
    staleTime: 5 * 60 * 1000,
  });

  const meetingOptions = (meetingsQ.data?.meetings ?? []) as MeetingOption[];

  const q = useQuery({
    queryKey: analyticsQueryKey(
      applied
        ? {
            periodDays: applied.periodDays,
            start: applied.start,
            end: applied.end,
            speakers: applied.speakers,
            meetingPrefixes: applied.meetingPrefixes,
          }
        : null,
    ),
    queryFn: () => {
      if (!applied) throw new Error("No filters applied");
      return getNotetakerAnalyticsReport({
        data: {
          start: applied.start,
          end: applied.end,
          speakerFilters: applied.speakers.length ? applied.speakers : undefined,
          meetingPrefixes: applied.meetingPrefixes.length ? applied.meetingPrefixes : undefined,
          maxMeetings: 100,
        },
      });
    },
    enabled: applied !== null,
    staleTime: 30 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    placeholderData: keepPreviousData,
  });

  const report = q.data?.report;

  const topSpeakerChart = useMemo(
    () => (report?.topSpeakers ?? []).slice(0, 12).map((s) => ({ name: s.speaker, utterances: s.utterances, words: s.words })),
    [report],
  );

  const meetingsTrend = report?.meetingsByDay ?? [];

  const participationPie = useMemo(() => {
    const top = report?.topSpeakers?.slice(0, 6) ?? [];
    const restUtterances =
      (report?.totalUtterances ?? 0) - top.reduce((n, s) => n + s.utterances, 0);
    const slices = top.map((s) => ({ name: s.speaker, value: s.utterances }));
    if (restUtterances > 0) slices.push({ name: "Others", value: restUtterances });
    const filtered = slices.filter((s) => s.value > 0);
    const total = filtered.reduce((n, s) => n + s.value, 0);
    return { slices: filtered, total };
  }, [report]);

  const insightsMut = useMutation({
    mutationFn: async () => {
      if (!report) throw new Error("Load analytics first");
      const r = await getNotetakerAnalyticsInsights({ data: { report } });
      return r.insightsMd;
    },
    onSuccess: (md) => {
      setInsightsMd(md);
      toast.success("AI insights ready");
    },
    onError: (e: Error) => toast.error(e.message || "Insights failed"),
  });

  useEffect(() => {
    if (!applied) return;
    saveAnalyticsSession({
      applied: {
        periodMode: applied.periodMode,
        periodDays: applied.periodDays,
        start: applied.start,
        end: applied.end,
        speakers: applied.speakers,
        meetingPrefixes: applied.meetingPrefixes,
      },
      periodMode,
      periodDays,
      customStart,
      customEnd,
      speakerChips,
      selectedMeetingPrefixes,
      meetingSearch,
      insightsMd,
    });
  }, [applied, periodMode, periodDays, customStart, customEnd, speakerChips, selectedMeetingPrefixes, meetingSearch, insightsMd]);

  useEffect(() => {
    if (typeof window === "undefined" || !report) return;
    (window as any).__ALYSON_MINI_CONTEXT__ = {
      module: "notetaker-analytics",
      range: report.range,
      analyzedCount: report.analyzedCount,
      uniqueSpeakers: report.uniqueSpeakersGlobal,
      topSpeakers: report.topSpeakers.slice(0, 10),
      filters: report.filters,
    };
  }, [report]);

  const applyFilters = () => {
    let start: string;
    let end: string;
    if (periodMode === "custom") {
      const err = validateCustomRange(customStart, customEnd);
      if (err) {
        toast.error(err);
        return;
      }
      start = customStart;
      end = customEnd;
    } else {
      ({ start, end } = rangeForLastDays(periodDays));
    }
    setApplied({
      periodMode,
      periodDays,
      start,
      end,
      speakers: [...speakerChips],
      meetingPrefixes: [...selectedMeetingPrefixes],
    });
    setInsightsMd(null);
  };

  const addSpeakerChips = (raw: string) => {
    const parts = raw
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return;
    setSpeakerChips((prev) => {
      const seen = new Set(prev.map((s) => s.toLowerCase()));
      const next = [...prev];
      for (const p of parts) {
        const key = p.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(p);
      }
      return next;
    });
  };

  const removeSpeakerChip = (name: string) => {
    setSpeakerChips((prev) => prev.filter((s) => s !== name));
  };

  const allSpeakersSelected = speakerChips.length === 0;
  const allMeetingsSelected = selectedMeetingPrefixes.length === 0;

  const periodDraftMatchesApplied = (nextApplied: AppliedFilters | null) => {
    if (!nextApplied) return false;
    return (
      periodMode === nextApplied.periodMode &&
      (periodMode === "preset"
        ? periodDays === nextApplied.periodDays
        : customStart === nextApplied.start && customEnd === nextApplied.end)
    );
  };

  const selectAllSpeakers = () => {
    if (allSpeakersSelected) return;
    setSpeakerChips([]);
    if (applied && periodDraftMatchesApplied(applied) && prefixesEqual(selectedMeetingPrefixes, applied.meetingPrefixes)) {
      setApplied({ ...applied, speakers: [] });
      setInsightsMd(null);
    }
  };

  const selectAllMeetings = () => {
    if (allMeetingsSelected) return;
    setSelectedMeetingPrefixes([]);
    setMeetingSearch("");
    if (applied && periodDraftMatchesApplied(applied) && speakersEqual(speakerChips, applied.speakers)) {
      setApplied({ ...applied, meetingPrefixes: [] });
      setInsightsMd(null);
    }
  };

  const toggleMeetingPrefix = (prefix: string) => {
    setSelectedMeetingPrefixes((prev) =>
      prev.includes(prefix) ? prev.filter((p) => p !== prefix) : [...prev, prefix],
    );
  };

  const removeMeetingPrefix = (prefix: string) => {
    setSelectedMeetingPrefixes((prev) => prev.filter((p) => p !== prefix));
  };

  const confirmGoToMeeting = () => {
    if (!goToMeeting) return;
    setGoToMeeting(null);
    navigate({
      to: "/alyson-notetaker/calendar",
      search: {
        day: goToMeeting.day,
        transcriptKey: goToMeeting.transcriptKey,
        open: "transcript",
      },
    });
  };

  const [exportingPdf, setExportingPdf] = useState(false);

  const exportReport = async (mode: "html" | "pdf" | "print") => {
    if (!report) return;
    const exportArgs = {
      report,
      origin: window.location.origin,
      periodLabel: applied ? formatAppliedPeriod(applied) : undefined,
      insightsMd,
    };
    try {
      if (mode === "pdf") {
        setExportingPdf(true);
        try {
          downloadAnalyticsPdf(exportArgs);
          toast.success("PDF downloaded — meeting titles are clickable links to transcripts");
        } finally {
          setExportingPdf(false);
        }
        return;
      }

      const html = buildAnalyticsExportHtml(exportArgs);
      if (mode === "html") {
        downloadAnalyticsHtml(html, analyticsExportFilename(report));
        toast.success("HTML downloaded — includes talk-time pie; click meeting titles for transcripts");
      } else {
        printAnalyticsExport(html);
        toast.message("Print tab opened — choose Save as PDF in the print dialog");
      }
    } catch (e) {
      if (mode === "pdf") {
        try {
          const html = buildAnalyticsExportHtml(exportArgs);
          printAnalyticsExport(html);
          toast.message("PDF build failed — opened print view instead. Use Save as PDF in the dialog.");
        } catch (fallbackErr) {
          toast.error(fallbackErr instanceof Error ? fallbackErr.message : "Export failed");
        }
      } else {
        toast.error(e instanceof Error ? e.message : "Export failed");
      }
    }
  };

  return (
    <div className="ops-dense">
      <PageHeader
        eyebrow="Operations"
        title="Meeting analytics"
        description="Speaker participation across finalized meetings (S3 transcripts). Pick meetings by title, choose speakers, then Apply."
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
        <form
          className="surface-card p-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters();
          }}
        >
          <div className="space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Period</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {PERIOD_DAYS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => {
                    setPeriodMode("preset");
                    setPeriodDays(d);
                  }}
                  className={
                    "h-7 px-3 rounded-full text-[11.5px] font-medium border transition-colors " +
                    (periodMode === "preset" && periodDays === d
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
                  setPeriodMode("custom");
                  if (!isIsoDate(customStart) || !isIsoDate(customEnd)) {
                    const r = rangeForLastDays(periodDays);
                    setCustomStart(r.start);
                    setCustomEnd(r.end);
                  }
                }}
                className={
                  "h-7 px-3 rounded-full text-[11.5px] font-medium border transition-colors " +
                  (periodMode === "custom"
                    ? "bg-foreground text-background border-foreground"
                    : "bg-paper border-border text-muted-foreground hover:text-foreground")
                }
              >
                Custom
              </button>
              {periodMode === "preset" ? (
                <span className="text-[11px] text-muted-foreground ml-1">
                  {draftRange.start} → {draftRange.end}
                </span>
              ) : (
                <div className="flex flex-wrap items-center gap-2 ml-1 rounded-md border border-border bg-paper px-2 py-1">
                  <input
                    type="date"
                    value={customStart}
                    max={customEnd || isoDay(new Date())}
                    onChange={(e) => setCustomStart(e.target.value)}
                    className="h-7 rounded bg-transparent text-[12px] text-foreground"
                    aria-label="Custom range start"
                  />
                  <span className="text-muted-foreground text-xs">→</span>
                  <input
                    type="date"
                    value={customEnd}
                    min={customStart}
                    max={isoDay(new Date())}
                    onChange={(e) => setCustomEnd(e.target.value)}
                    className="h-7 rounded bg-transparent text-[12px] text-foreground"
                    aria-label="Custom range end"
                  />
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
            <div className="space-y-1 lg:col-span-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Speakers</span>
                <button
                  type="button"
                  onClick={selectAllSpeakers}
                  title="Include everyone who spoke in matching meetings"
                  className={
                    "h-6 px-2.5 rounded-full text-[11px] font-medium border transition-colors " +
                    (allSpeakersSelected
                      ? "bg-foreground text-background border-foreground"
                      : "bg-paper border-border text-muted-foreground hover:text-foreground")
                  }
                >
                  All
                </button>
              </div>
              <SpeakerChipsInput
                chips={speakerChips}
                onAdd={addSpeakerChips}
                onRemove={removeSpeakerChip}
                placeholder={allSpeakersSelected ? "All speakers — type a name to filter" : "Type name, press Enter"}
              />
            </div>
            <button
              type="submit"
              disabled={!filtersDirty && applied !== null}
              className={
                "h-8 px-4 rounded-md text-xs font-medium " +
                (filtersDirty || applied === null
                  ? "bg-foreground text-background hover:opacity-90"
                  : "bg-muted text-muted-foreground cursor-default")
              }
            >
              {q.isFetching ? "Loading…" : filtersDirty || applied === null ? "Apply filters" : "Up to date"}
            </button>
          </div>

          <MeetingPicker
            meetings={meetingOptions}
            loading={meetingsQ.isFetching}
            selectedPrefixes={selectedMeetingPrefixes}
            search={meetingSearch}
            onSearchChange={setMeetingSearch}
            onToggle={toggleMeetingPrefix}
            onRemove={removeMeetingPrefix}
            onSelectAll={selectAllMeetings}
            allSelected={allMeetingsSelected}
          />

          <p className="text-[11px] text-muted-foreground">
            {applied === null
              ? `Pick a period (default: last ${DEFAULT_PERIOD} days) or Custom dates. Use All for every meeting/speaker, or pick specific meetings by their actual titles. Then Apply.`
              : filtersDirty
                ? "Filters changed — click Apply to refresh charts (previous results stay visible until then)."
                : `${formatAppliedPeriod(applied)}${
                    applied.speakers.length
                      ? ` · speakers: ${applied.speakers.join(", ")} (any match)`
                      : " · all speakers"
                  }${
                    applied.meetingPrefixes.length
                      ? ` · ${applied.meetingPrefixes.length} meeting${applied.meetingPrefixes.length === 1 ? "" : "s"} selected`
                      : " · all meetings"
                  }`}
          </p>
        </form>

        {applied === null && !report && !q.isFetching && (
          <div className="surface-card p-8 text-center">
            <BarChart3 className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <div className="font-medium">No analytics loaded yet</div>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              Editing filters does not hit S3. Click <strong>Apply filters</strong> when you are ready.
            </p>
          </div>
        )}

        {applied !== null && q.isFetching && !report && (
          <div className="text-sm text-muted-foreground">Restoring analytics…</div>
        )}

        {applied !== null && filtersDirty && report && !q.isFetching && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-900 dark:text-amber-100">
            Filters changed — results below are from your last apply. Click Apply filters to update.
          </div>
        )}

        {q.isFetching && applied !== null && report && (
          <div className="text-[11px] text-muted-foreground">Refreshing analytics…</div>
        )}
        {q.isFetching && applied !== null && !report && (
          <div className="text-sm text-muted-foreground">Crawling S3 transcripts…</div>
        )}
        {q.isError && (
          <div className="surface-card p-4 text-sm text-destructive">
            {(q.error as Error)?.message || "Failed to load analytics"}
          </div>
        )}

        {report && applied !== null && (
          <>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => exportReport("html")}
                className="h-8 px-3 rounded-md border border-border text-xs font-medium inline-flex items-center gap-1.5 hover:bg-muted"
              >
                <Download className="h-3.5 w-3.5" />
                Export HTML
              </button>
              <button
                type="button"
                disabled={exportingPdf}
                onClick={() => void exportReport("pdf")}
                className="h-8 px-3 rounded-md border border-border text-xs font-medium inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
              >
                <FileText className="h-3.5 w-3.5" />
                {exportingPdf ? "Building PDF…" : "Download PDF"}
              </button>
              <button
                type="button"
                onClick={() => exportReport("print")}
                className="h-8 px-3 rounded-md border border-border text-xs font-medium inline-flex items-center gap-1.5 hover:bg-muted"
                title="Opens print preview in a new tab"
              >
                Print
              </button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Kpi label="Meetings in range" value={String(report.meetingCount)} />
              <Kpi label="Analyzed (transcript)" value={String(report.analyzedCount)} />
              <Kpi label="Unique speakers" value={String(report.uniqueSpeakersGlobal)} />
              <Kpi label="Total utterances" value={String(report.totalUtterances)} />
            </div>
            {(report.mergedSpeakerAccounts ?? 0) > 0 && (
              <p className="text-[12px] text-muted-foreground -mt-2">
                Merged {report.mergedSpeakerAccounts} duplicate account
                {report.mergedSpeakerAccounts === 1 ? "" : "s"} (same person, different emails or name variants) using the employee
                directory so rankings reflect one person.
              </p>
            )}
            {report.analyzedCount === 0 && report.meetingCount > 0 && (
              <p className="text-[12px] text-muted-foreground -mt-2">
                {report.skippedNoTranscript > 0
                  ? `${report.skippedNoTranscript} meeting(s) in range have no transcript in S3 yet. `
                  : null}
                {applied.speakers.length > 0
                  ? "With speaker filters, a meeting counts only if at least one transcript name contains any chip (substring match, e.g. “hamza” matches “Ameer Hamza”)."
                  : "Open Meeting Calendar and confirm transcripts exist for these dates."}
              </p>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <ChartCard title="Top speakers" subtitle="By utterance count">
                {topSpeakerChart.length === 0 ? (
                  <EmptyChart />
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={topSpeakerChart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="name" stroke="var(--muted-foreground)" fontSize={10} interval={0} angle={-25} textAnchor="end" height={70} />
                      <YAxis stroke="var(--muted-foreground)" fontSize={11} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Bar dataKey="utterances" name="Utterances" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>

              <ChartCard title="Participation share" subtitle="Top speakers vs others (utterances)">
                {participationPie.slices.length === 0 ? (
                  <EmptyChart />
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <PieChart>
                      <Pie data={participationPie.slices} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95}>
                        {participationPie.slices.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        content={({ active, payload }) => (
                          <ParticipationPieTooltip
                            active={active}
                            payload={payload}
                            totalUtterances={participationPie.total}
                          />
                        )}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>

              <ChartCard title="Meetings over time" subtitle="Days with at least one analyzed meeting" className="lg:col-span-2">
                {meetingsTrend.length === 0 ? (
                  <EmptyChart />
                ) : (
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={meetingsTrend}>
                      <CartesianGrid stroke="var(--border)" vertical={false} />
                      <XAxis
                        dataKey="day"
                        stroke="var(--muted-foreground)"
                        fontSize={11}
                        tickFormatter={(v) => new Date(v).toLocaleDateString("en", { month: "short", day: "numeric" })}
                      />
                      <YAxis stroke="var(--muted-foreground)" fontSize={11} allowDecimals={false} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Bar dataKey="meetings" name="Meetings" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>
            </div>

            <div className="surface-card p-4 md:p-5">
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">Meetings</div>
                  <h3 className="font-display text-lg mt-0.5">Speakers per meeting</h3>
                </div>
                <button
                  type="button"
                  disabled={insightsMut.isPending}
                  onClick={() => insightsMut.mutate()}
                  className="ml-auto h-8 px-3 rounded-md border border-border text-xs font-medium inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {insightsMut.isPending ? "Generating…" : "AI insights"}
                </button>
              </div>

              {insightsMd && (
                <div className="mb-4 rounded-md border border-border bg-muted/20 p-3 text-[13px] leading-relaxed whitespace-pre-wrap font-mono text-[12px]">
                  {insightsMd}
                </div>
              )}

              {report.meetings.length === 0 ? (
                <div className="text-sm text-muted-foreground">No meetings match filters in this range.</div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>
                      {report.meetings.length} meeting{report.meetings.length === 1 ? "" : "s"}
                    </span>
                    {report.meetings.length > 6 && <span>Scroll the table for more</span>}
                  </div>
                  <div className="rounded-md border border-border overflow-hidden">
                    <div className="max-h-[min(420px,55vh)] overflow-y-auto overflow-x-auto overscroll-contain">
                      <table className="ops-table w-full min-w-[640px]">
                        <thead className="sticky top-0 z-[1] bg-background">
                          <tr className="shadow-[inset_0_-1px_0_var(--border)]">
                            <th align="left">Day</th>
                            <th align="left">Meeting</th>
                            <th align="right">Speakers</th>
                            <th align="right">Utterances</th>
                            <th align="left">Who spoke</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.meetings.map((m) => (
                            <tr key={m.prefix} className="hover:bg-muted/40">
                              <td className="text-muted-foreground whitespace-nowrap">{m.day}</td>
                              <td className="max-w-[200px]">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setGoToMeeting({
                                      title: m.title,
                                      day: m.day,
                                      prefix: m.prefix,
                                      transcriptKey: m.transcriptKey,
                                    })
                                  }
                                  className="font-medium truncate text-left w-full hover:underline underline-offset-2 text-foreground"
                                  title={`Open ${m.title} in calendar`}
                                >
                                  {m.title}
                                </button>
                              </td>
                              <td align="right" className="font-mono text-xs">
                                {m.uniqueSpeakers}
                              </td>
                              <td align="right" className="font-mono text-xs">
                                {m.totalUtterances}
                              </td>
                              <td className="text-[12px] text-muted-foreground">
                                {m.speakers
                                  .slice(0, 5)
                                  .map((s) => `${s.speaker} (${s.utterances})`)
                                  .join(" · ")}
                                {m.speakers.length > 5 ? " …" : ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <p className="text-[11px] text-muted-foreground">
              Crawler reads <code className="text-[10px]">alyson-notetaker/transcripts/…/transcript.txt</code> lines as{" "}
              <code className="text-[10px]">Name: utterance</code>. Speakers with multiple emails (e.g. mohita@revcloud.com and
              mohita@cintara.ai) are merged via the employee directory. Max 100 meetings per request. Export includes talk-time % (pie +
              table) and clickable transcript links on Meeting Calendar.
            </p>
          </>
        )}
      </div>

      <AlertDialog.Root open={goToMeeting !== null} onOpenChange={(open) => !open && setGoToMeeting(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/40 z-[70]" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[70] w-[92vw] max-w-md surface-card p-4">
            <AlertDialog.Title className="font-medium text-[14px]">Open in Meeting Calendar?</AlertDialog.Title>
            <AlertDialog.Description className="text-[12px] text-muted-foreground mt-1 leading-relaxed">
              {goToMeeting ? (
                <>
                  Go to <span className="font-medium text-foreground">{goToMeeting.title}</span> on {goToMeeting.day} and open
                  the transcript.
                </>
              ) : (
                "View this meeting in the calendar."
              )}
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className="h-8 px-3 rounded-md border border-border text-xs hover:bg-muted"
                >
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  onClick={confirmGoToMeeting}
                  className="h-8 px-3 rounded-md bg-foreground text-background text-xs font-medium hover:opacity-90"
                >
                  Go to meeting
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

const tooltipStyle: React.CSSProperties = {
  background: "var(--paper)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: 12,
};

function ParticipationPieTooltip({
  active,
  payload,
  totalUtterances,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; payload?: { name?: string; value?: number } }>;
  totalUtterances: number;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0];
  const name = String(row.name ?? row.payload?.name ?? "Speaker");
  const utterances = Number(row.value ?? row.payload?.value ?? 0);
  const pct =
    totalUtterances > 0 ? ((utterances / totalUtterances) * 100).toFixed(1) : "0.0";

  return (
    <div style={{ ...tooltipStyle, padding: "8px 10px" }}>
      <div className="text-[12px] font-medium leading-tight">{name}</div>
      <div className="text-[11px] text-muted-foreground mt-1">
        {utterances} utterance{utterances === 1 ? "" : "s"}
      </div>
      <div className="text-[11px] font-medium mt-0.5">{pct}% of utterances</div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-display text-xl mt-1">{value}</div>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
  className = "",
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`surface-card p-4 md:p-5 ${className}`}>
      <div className="flex items-baseline gap-2 mb-3">
        <BarChart3 className="h-4 w-4 text-muted-foreground shrink-0" />
        <div>
          <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">{subtitle}</div>
          <h3 className="font-display text-lg mt-0.5">{title}</h3>
        </div>
      </div>
      {children}
    </div>
  );
}

function EmptyChart() {
  return <div className="h-[200px] grid place-items-center text-sm text-muted-foreground">No data for current filters</div>;
}

function MeetingPicker({
  meetings,
  loading,
  selectedPrefixes,
  search,
  onSearchChange,
  onToggle,
  onRemove,
  onSelectAll,
  allSelected,
}: {
  meetings: MeetingOption[];
  loading: boolean;
  selectedPrefixes: string[];
  search: string;
  onSearchChange: (v: string) => void;
  onToggle: (prefix: string) => void;
  onRemove: (prefix: string) => void;
  onSelectAll: () => void;
  allSelected: boolean;
}) {
  const withTranscript = useMemo(
    () => meetings.filter((m) => m.transcriptKey),
    [meetings],
  );
  const byPrefix = useMemo(() => new Map(withTranscript.map((m) => [m.prefix, m])), [withTranscript]);
  const selectedSet = useMemo(() => new Set(selectedPrefixes), [selectedPrefixes]);

  const filtered = useMemo(() => {
    const q = search.trim();
    if (!q) return withTranscript;
    return withTranscript.filter(
      (m) => textMatchesSearchQuery(m.title, q) || dateMatchesSearchQuery(m.day, q),
    );
  }, [withTranscript, search]);

  const selectedMeetings = selectedPrefixes
    .map((p) => byPrefix.get(p))
    .filter(Boolean) as MeetingOption[];

  return (
    <div className="space-y-1.5 rounded-md border border-border bg-paper/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Meetings</span>
        <button
          type="button"
          onClick={onSelectAll}
          title="Include every meeting with a transcript in this period"
          className={
            "h-6 px-2.5 rounded-full text-[11px] font-medium border transition-colors " +
            (allSelected
              ? "bg-foreground text-background border-foreground"
              : "bg-paper border-border text-muted-foreground hover:text-foreground")
          }
        >
          All
        </button>
        {!allSelected && selectedPrefixes.length > 0 && (
          <span className="text-[11px] text-muted-foreground">
            {selectedPrefixes.length} selected
          </span>
        )}
        <span className="text-[10px] text-muted-foreground ml-auto">
          {loading ? "Loading meetings…" : `${withTranscript.length} with transcript`}
        </span>
      </div>

      {!allSelected && selectedMeetings.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedMeetings.map((m) => (
            <span
              key={m.prefix}
              className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full bg-muted text-[11px] font-medium max-w-full"
              title={`${m.title} (${m.day})`}
            >
              <span className="truncate max-w-[180px]">{m.title}</span>
              <button
                type="button"
                onClick={() => onRemove(m.prefix)}
                className="h-4 w-4 rounded-full hover:bg-background/80 grid place-items-center text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${m.title}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search by title or date (fuzzy, e.g. data engineering)"
        className="w-full h-8 px-2 rounded-md border border-border bg-background text-sm"
      />

      <div className="rounded-md border border-border bg-background max-h-[min(200px,35vh)] overflow-y-auto overscroll-contain">
        {loading && withTranscript.length === 0 ? (
          <div className="px-3 py-4 text-[12px] text-muted-foreground">Loading meetings for this period…</div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-4 text-[12px] text-muted-foreground">
            {withTranscript.length === 0
              ? "No meetings with transcripts in this period."
              : "No meetings match your search."}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((m) => {
              const checked = selectedSet.has(m.prefix);
              return (
                <li key={m.prefix}>
                  <label className="flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-muted/40 text-[12px]">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(m.prefix)}
                      className="mt-0.5 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium block truncate">{m.title}</span>
                      <span className="text-muted-foreground">{m.day}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Pick meetings by their actual calendar titles — no need for a shared keyword like “standup”. Use All to analyze every
        meeting in the period, or check specific ones (e.g. your daily sync even if it is named differently each week).
      </p>
    </div>
  );
}

function SpeakerChipsInput({
  chips,
  onAdd,
  onRemove,
  placeholder,
}: {
  chips: string[];
  onAdd: (raw: string) => void;
  onRemove: (name: string) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");

  const commitDraft = () => {
    const v = draft.trim();
    if (!v) return;
    onAdd(v);
    setDraft("");
  };

  return (
    <div
      className="min-h-8 w-full rounded-md border border-border bg-background px-2 py-1 flex flex-wrap items-center gap-1.5 focus-within:ring-1 focus-within:ring-ring"
      onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}
    >
      {chips.map((name) => (
        <span
          key={name}
          className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full bg-muted text-[11px] font-medium max-w-full"
          title={name}
        >
          <span className="truncate max-w-[140px]">{name}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(name);
            }}
            className="h-4 w-4 rounded-full hover:bg-background/80 grid place-items-center text-muted-foreground hover:text-foreground"
            aria-label={`Remove ${name}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            e.stopPropagation();
            commitDraft();
            return;
          }
          if (e.key === "Backspace" && !draft && chips.length > 0) {
            onRemove(chips[chips.length - 1]);
          }
        }}
        onBlur={() => {
          if (draft.trim()) commitDraft();
        }}
        placeholder={chips.length ? "" : placeholder}
        className="flex-1 min-w-[120px] h-6 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
