import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, FileText, Loader2, RefreshCw, Search, Trophy } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, PageHeader, TableScroll } from "@/components/AppShell";
import { TableSkeleton } from "@/components/Skeleton";
import { downloadCSV } from "@/lib/csv";
import { getEmployeeScoring } from "@/lib/employee-scoring-functions";
import { downloadEmployeeScoringPdf } from "@/lib/employee-scoring-pdf";
import {
  loadEmployeeScoringSession,
  readEmployeeScoringSnapshot,
  saveEmployeeScoringSession,
  scoringSnapshotKey,
  type EmployeeScoringStoredState,
} from "@/lib/employee-scoring-session";
import { SCORING_WEIGHTS } from "@/lib/employee-scoring-rules";
import { medalRowClass, rankCellContent } from "@/lib/rank-medals";
import { HourlyActivityReport } from "@/components/HourlyActivityReport";

const PRESET_DAYS = [7, 14, 30, 45, 90] as const;

export const Route = createFileRoute("/employee-scoring")({
  head: () => ({ meta: [{ title: "Employee Scoring — Alyson HR" }] }),
  component: EmployeeScoringPage,
});

function isoForInput(d: Date) {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fmtIso(iso: string) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

function gradeClass(grade: string) {
  switch (grade) {
    case "A":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    case "B":
      return "bg-sky-500/15 text-sky-700 dark:text-sky-300";
    case "C":
      return "bg-amber-500/15 text-amber-800 dark:text-amber-200";
    case "D":
      return "bg-orange-500/15 text-orange-800 dark:text-orange-200";
    default:
      return "bg-rose-500/15 text-rose-700 dark:text-rose-300";
  }
}

function draftToApplied(draftStart: string, draftEnd: string) {
  const s = new Date(draftStart);
  const e = new Date(draftEnd);
  return { start: s.toISOString(), end: e.toISOString() };
}

function rangesMatch(
  a: { start: string; end: string } | null,
  b: { start: string; end: string } | null,
) {
  if (!a || !b) return false;
  return a.start === b.start && a.end === b.end;
}

function EmployeeScoringPage() {
  const now = useMemo(() => new Date(), []);
  const boot = useMemo(() => loadEmployeeScoringSession(), []);
  const fallbackStart = useMemo(
    () => new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    [now],
  );
  const fallbackEnd = useMemo(() => now.toISOString(), [now]);

  const [draftEnd, setDraftEnd] = useState(() => boot?.draftEnd ?? isoForInput(now));
  const [draftStart, setDraftStart] = useState(
    () => boot?.draftStart ?? isoForInput(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)),
  );
  const [applied, setApplied] = useState<{ start: string; end: string } | null>(
    () => boot?.applied ?? { start: fallbackStart, end: fallbackEnd },
  );
  const [search, setSearch] = useState(() => boot?.search ?? "");
  const [hourlyEmployeeEmail, setHourlyEmployeeEmail] = useState<string | null>(null);

  const persisted = useMemo(() => {
    const snapshot = readEmployeeScoringSnapshot(applied);
    if (!snapshot || !applied) return null;
    const stored = loadEmployeeScoringSession();
    return {
      snapshot,
      at: stored?.snapshotAt ?? boot?.snapshotAt ?? Date.now(),
    };
  }, [applied, boot?.snapshotAt]);

  const q = useQuery({
    queryKey: ["employee-scoring", applied?.start ?? "idle", applied?.end ?? "idle"],
    queryFn: () =>
      getEmployeeScoring({
        data: applied ? { start: applied.start, end: applied.end } : undefined,
      }),
    enabled: applied !== null,
    initialData: persisted?.snapshot,
    initialDataUpdatedAt: persisted?.at,
    placeholderData: keepPreviousData,
    staleTime: 120_000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const draftRange = useMemo(() => {
    try {
      return draftToApplied(draftStart, draftEnd);
    } catch {
      return null;
    }
  }, [draftStart, draftEnd]);

  const draftMatchesApplied = rangesMatch(draftRange, applied);
  const isBusy = q.isFetching;
  const showingStaleWindow = q.isPlaceholderData && isBusy;
  const coldLoad = q.isPending && !q.data;

  const filteredRows = useMemo(() => {
    const rows = q.data?.rows ?? [];
    const s = search.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter(
      (r) => r.userEmail.toLowerCase().includes(s) || r.displayName.toLowerCase().includes(s),
    );
  }, [q.data?.rows, search]);

  const hourlyEmployeeOptions = useMemo(
    () =>
      (q.data?.rows ?? []).slice(0, 80).map((r) => ({
        email: r.userEmail,
        label: `${r.displayName} (${r.userEmail})`,
      })),
    [q.data?.rows],
  );

  const lastToastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!q.isSuccess || q.isPlaceholderData || !q.data || !applied) return;
    const key = scoringSnapshotKey(applied);
    if (lastToastKey.current === key) return;
    if (lastToastKey.current !== null) {
      toast.success("Scores updated for the selected window");
    }
    lastToastKey.current = key;
  }, [q.isSuccess, q.isPlaceholderData, q.data, applied]);

  const apply = () => {
    if (!draftStart || !draftEnd) return toast.error("Select start and end datetime");
    const s = new Date(draftStart);
    const e = new Date(draftEnd);
    if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) {
      return toast.error("Invalid datetime range");
    }
    if (s.getTime() >= e.getTime()) return toast.error("Start must be before end");
    const next = draftToApplied(draftStart, draftEnd);
    if (rangesMatch(next, applied)) {
      void q.refetch();
      return;
    }
    setApplied(next);
  };

  const applyPreset = (days: (typeof PRESET_DAYS)[number]) => {
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    setDraftStart(isoForInput(start));
    setDraftEnd(isoForInput(end));
    setApplied({ start: start.toISOString(), end: end.toISOString() });
  };

  const exportCsv = () => {
    if (!filteredRows.length || showingStaleWindow) return toast.error("Wait for scores to finish loading");
    const suffix = q.data?.range?.start?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
    downloadCSV(
      `employee-scoring-${suffix}.csv`,
      filteredRows.map((r) => ({
        rank: r.rank,
        grade: r.grade,
        composite_score: r.compositeScore,
        user_email: r.userEmail,
        display_name: r.displayName,
        work_hours: r.workHours,
        hours_per_day: r.hoursPerDay,
        emails_sent: r.emailsSent,
        meetings_in_window: r.meetingsCreated,
        docs_created: r.docsCreated,
        chat_messages: r.chatMessagesSent,
        pct_work_hours: r.percentile.workHours,
        pct_meetings: r.percentile.meetings,
        pct_emails: r.percentile.emails,
        pct_chat: r.percentile.chat,
        pct_docs: r.percentile.docs,
      })),
      [
        "rank",
        "grade",
        "composite_score",
        "user_email",
        "display_name",
        "work_hours",
        "hours_per_day",
        "emails_sent",
        "meetings_in_window",
        "docs_created",
        "chat_messages",
        "pct_work_hours",
        "pct_meetings",
        "pct_emails",
        "pct_chat",
        "pct_docs",
      ],
    );
    toast.success("Employee scoring exported");
  };

  const exportPdf = () => {
    if (!q.data || !filteredRows.length || showingStaleWindow) {
      toast.error("Wait for scores to finish loading");
      return;
    }
    downloadEmployeeScoringPdf({
      rows: filteredRows,
      meta: {
        range: q.data.range,
        timeDoctorRange: q.data.timeDoctorRange,
        windowDays: q.data.windowDays,
        generatedAt: q.data.generatedAt,
        rules: q.data.rules,
      },
      filteredBy: search,
    });
    toast.success("Employee scoring PDF exported");
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!q.isSuccess || q.isPlaceholderData || !q.data || !applied) {
      const filtersOnly: EmployeeScoringStoredState = {
        version: 2,
        draftStart,
        draftEnd,
        applied,
        search,
      };
      saveEmployeeScoringSession(filtersOnly);
      return;
    }
    saveEmployeeScoringSession({
      version: 2,
      draftStart,
      draftEnd,
      applied,
      search,
      snapshot: q.data,
      snapshotKey: scoringSnapshotKey(applied),
      snapshotAt: Date.now(),
    });
  }, [draftStart, draftEnd, applied, search, q.data, q.isSuccess, q.isPlaceholderData]);

  const weightPct = (k: keyof typeof SCORING_WEIGHTS) => Math.round(SCORING_WEIGHTS[k] * 100);

  const statusBanner = (() => {
    if (coldLoad) {
      return {
        tone: "loading" as const,
        text: "Computing scores from Google Workspace and Time Doctor — this can take a minute for large teams.",
      };
    }
    if (showingStaleWindow) {
      return {
        tone: "loading" as const,
        text: "Updating scores for the new window — previous rankings stay visible until ready.",
      };
    }
    if (isBusy) {
      return { tone: "loading" as const, text: "Refreshing scores…" };
    }
    if (q.isError) {
      return {
        tone: "error" as const,
        text: q.error instanceof Error ? q.error.message : "Failed to load employee scoring",
      };
    }
    return null;
  })();

  return (
    <div className="ops-dense">
      <PageHeader
        eyebrow="Operations"
        title="Employee Scoring"
        description="Rank every user on one shared window: Workspace activity + Time Doctor hours, using percentile-based rules."
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => q.refetch()}
              disabled={!applied || isBusy}
              className="h-8 px-3 rounded-md border border-border text-xs inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isBusy ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <button
              onClick={exportCsv}
              disabled={!filteredRows.length || showingStaleWindow}
              className="h-8 px-3 rounded-md border border-border text-xs inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
            <button
              onClick={exportPdf}
              disabled={!filteredRows.length || showingStaleWindow}
              className="h-8 px-3 rounded-md border border-border text-xs inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
            >
              <FileText className="h-3.5 w-3.5" />
              Export PDF
            </button>
          </div>
        }
      />

      <div className="px-5 md:px-8 py-6 space-y-5">
        <div
          className={`surface-card p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end transition-opacity ${isBusy ? "opacity-90" : ""}`}
        >
          <label className="space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Start (local)</span>
            <input
              type="datetime-local"
              value={draftStart}
              onChange={(e) => setDraftStart(e.target.value)}
              disabled={isBusy}
              className="w-full h-8 px-2 rounded-md border border-border bg-background text-sm disabled:opacity-60"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">End (local)</span>
            <input
              type="datetime-local"
              value={draftEnd}
              onChange={(e) => setDraftEnd(e.target.value)}
              disabled={isBusy}
              className="w-full h-8 px-2 rounded-md border border-border bg-background text-sm disabled:opacity-60"
            />
          </label>
          <button
            type="button"
            onClick={apply}
            disabled={isBusy}
            className="h-8 px-4 rounded-md bg-foreground text-background text-xs font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-70 min-w-[10.5rem]"
          >
            {isBusy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Computing…
              </>
            ) : draftMatchesApplied ? (
              "Recompute scores"
            ) : (
              "Apply scoring window"
            )}
          </button>
          <div className="text-[11px] text-muted-foreground">
            {draftMatchesApplied
              ? "Window applied. Change dates or use a preset to load another range."
              : "Pick dates, then apply — table stays visible while new scores load."}
          </div>
          <div className="md:col-span-4 flex flex-wrap gap-1.5">
            {PRESET_DAYS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => applyPreset(d)}
                disabled={isBusy}
                className="h-7 px-3 rounded-full text-[11px] font-medium border border-border bg-paper text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Last {d} days
              </button>
            ))}
          </div>
        </div>

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
          </div>
        ) : null}

        <div className="surface-card p-4">
          <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium mb-2">
            Scoring rules
          </div>
          <ul className="text-[12px] text-muted-foreground space-y-1 list-disc pl-4">
            {(q.data?.rules ?? []).map((rule, i) => (
              <li key={i}>{rule}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            <span className="px-2 py-0.5 rounded-full border border-border">
              Work hours {weightPct("workHours")}%
            </span>
            <span className="px-2 py-0.5 rounded-full border border-border">
              Meetings {weightPct("meetings")}%
            </span>
            <span className="px-2 py-0.5 rounded-full border border-border">
              Emails {weightPct("emails")}%
            </span>
            <span className="px-2 py-0.5 rounded-full border border-border">
              Chat {weightPct("chat")}%
            </span>
            <span className="px-2 py-0.5 rounded-full border border-border">
              Docs {weightPct("docs")}%
            </span>
          </div>
        </div>

        {q.data && !coldLoad ? (
          <div className="surface-card p-3 text-[12px] text-muted-foreground">
            {showingStaleWindow ? (
              <span className="text-foreground font-medium">Pending window (IST): </span>
            ) : (
              <span>Workspace window (IST): </span>
            )}
            {applied ? (
              <>
                {fmtIso(applied.start)} → {fmtIso(applied.end)}
              </>
            ) : (
              "—"
            )}
            {!showingStaleWindow && q.data ? (
              <>
                {" "}
                · Time Doctor: {q.data.timeDoctorRange.start} → {q.data.timeDoctorRange.end} ({q.data.windowDays}{" "}
                days) · Ranked: {q.data.rows.length}
              </>
            ) : null}
            {search.trim() ? ` · Showing: ${filteredRows.length}` : ""}
          </div>
        ) : null}

        <div className="relative max-w-sm">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or email..."
            disabled={coldLoad}
            className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-background text-[13px] disabled:opacity-60"
          />
        </div>

        {q.data?.warnings?.length && !showingStaleWindow ? (
          <div className="surface-card p-4">
            <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium mb-2">
              Warnings
            </div>
            <ul className="text-xs text-muted-foreground space-y-1">
              {q.data.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {coldLoad ? <TableSkeleton rows={10} /> : null}

        {!coldLoad && !isBusy && q.data && filteredRows.length === 0 ? (
          <EmptyState
            icon={Trophy}
            title="No scored users"
            description="No users matched your search in this window."
          />
        ) : null}

        {!coldLoad && !!filteredRows.length ? (
          <div className="relative min-h-[12rem]">
            {showingStaleWindow ? (
              <div
                className="absolute inset-0 z-10 rounded-lg bg-background/55 backdrop-blur-[1px] pointer-events-none flex items-start justify-center pt-8"
                aria-hidden
              >
                <span className="text-[12px] text-muted-foreground bg-paper border border-border px-3 py-1.5 rounded-full shadow-sm">
                  Updating rankings…
                </span>
              </div>
            ) : null}
            <div
              className={
                showingStaleWindow ? "opacity-60 pointer-events-none select-none transition-opacity" : ""
              }
            >
              <TableScroll>
                <table className="ops-table w-full">
                  <thead>
                    <tr>
                      <th align="center">Medal</th>
                      <th align="left">Employee</th>
                      <th align="center">Grade</th>
                      <th align="right">Score</th>
                      <th align="right">Work hrs</th>
                      <th align="right">Hrs/day</th>
                      <th align="right">Meetings</th>
                      <th align="right">Emails</th>
                      <th align="right">Chat</th>
                      <th align="right">Docs</th>
                      <th align="right" title="Percentile contributions">
                        %ile mix
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((r) => (
                      <tr
                        key={r.userEmail}
                        className={
                          medalRowClass(r.rank) +
                          (hourlyEmployeeEmail === r.userEmail ? " ring-1 ring-inset ring-foreground/25" : "") +
                          " cursor-pointer hover:opacity-95"
                        }
                        onClick={() => setHourlyEmployeeEmail(r.userEmail)}
                        title="Click to load hourly breakdown below"
                      >
                        <td align="center">{rankCellContent(r.rank)}</td>
                        <td>
                          <div className="font-medium text-[13px]">{r.displayName}</div>
                          <div className="text-[11px] text-muted-foreground">{r.userEmail}</div>
                        </td>
                        <td align="center">
                          <span
                            className={`inline-flex px-2 py-0.5 rounded text-[11px] font-semibold ${gradeClass(r.grade)}`}
                          >
                            {r.grade}
                          </span>
                        </td>
                        <td align="right" className="font-mono font-medium">
                          {r.compositeScore.toFixed(1)}
                        </td>
                        <td align="right" className="font-mono">
                          {r.workHours.toFixed(1)}
                        </td>
                        <td align="right" className="font-mono text-muted-foreground">
                          {r.hoursPerDay.toFixed(2)}
                        </td>
                        <td align="right" className="font-mono">
                          {r.meetingsCreated}
                        </td>
                        <td align="right" className="font-mono">
                          {r.emailsSent}
                        </td>
                        <td align="right" className="font-mono">
                          {r.chatMessagesSent}
                        </td>
                        <td align="right" className="font-mono">
                          {r.docsCreated}
                        </td>
                        <td align="right" className="text-[10px] text-muted-foreground font-mono">
                          {r.percentile.workHours}/{r.percentile.meetings}/{r.percentile.emails}/
                          {r.percentile.chat}/{r.percentile.docs}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </div>
          </div>
        ) : null}

        <div className="pt-4 border-t border-border">
          <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium mb-3">
            Hourly breakdown
          </div>
          <p className="text-[12px] text-muted-foreground mb-4 max-w-2xl">
            Click a row above or pick an employee — uses the same scoring window (max 7 days per hourly load). Top 3
            get gold, silver, and bronze medals with row highlights.
          </p>
          <HourlyActivityReport
            compact
            syncRange={applied}
            selectedEmail={hourlyEmployeeEmail}
            employeeOptions={hourlyEmployeeOptions}
          />
        </div>
      </div>
    </div>
  );
}
