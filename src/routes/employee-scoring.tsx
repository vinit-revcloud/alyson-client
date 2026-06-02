import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, FileText, RefreshCw, Search, Trophy } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, PageHeader, TableScroll } from "@/components/AppShell";
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

function EmployeeScoringPage() {
  const now = useMemo(() => new Date(), []);
  const boot = useMemo(() => loadEmployeeScoringSession(), []);
  const fallbackStart = useMemo(() => new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), [now]);
  const fallbackEnd = useMemo(() => now.toISOString(), [now]);

  const [draftEnd, setDraftEnd] = useState(() => boot?.draftEnd ?? isoForInput(now));
  const [draftStart, setDraftStart] = useState(
    () => boot?.draftStart ?? isoForInput(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)),
  );
  const [applied, setApplied] = useState<{ start: string; end: string } | null>(
    () => boot?.applied ?? { start: fallbackStart, end: fallbackEnd },
  );
  const [search, setSearch] = useState(() => boot?.search ?? "");

  const cachedSnapshot = useMemo(() => readEmployeeScoringSnapshot(applied), [applied]);

  const q = useQuery({
    queryKey: ["employee-scoring", applied?.start ?? "idle", applied?.end ?? "idle"],
    queryFn: () =>
      getEmployeeScoring({
        data: applied ? { start: applied.start, end: applied.end } : undefined,
      }),
    enabled: applied !== null,
    initialData: () => readEmployeeScoringSnapshot(applied),
    initialDataUpdatedAt: boot?.snapshotAt,
    placeholderData: keepPreviousData,
    staleTime: 120_000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const filteredRows = useMemo(() => {
    const rows = q.data?.rows ?? [];
    const s = search.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter(
      (r) =>
        r.userEmail.toLowerCase().includes(s) ||
        r.displayName.toLowerCase().includes(s),
    );
  }, [q.data?.rows, search]);

  const apply = () => {
    if (!draftStart || !draftEnd) return toast.error("Select start and end datetime");
    const s = new Date(draftStart);
    const e = new Date(draftEnd);
    if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) return toast.error("Invalid datetime range");
    if (s.getTime() >= e.getTime()) return toast.error("Start must be before end");
    setApplied({ start: s.toISOString(), end: e.toISOString() });
  };

  const applyPreset = (days: (typeof PRESET_DAYS)[number]) => {
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    setDraftStart(isoForInput(start));
    setDraftEnd(isoForInput(end));
    setApplied({ start: start.toISOString(), end: end.toISOString() });
  };

  const exportCsv = () => {
    if (!filteredRows.length) return toast.error("No rows to export");
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
    if (!q.data || !filteredRows.length) {
      toast.error("No rows to export");
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
    const payload: EmployeeScoringStoredState = {
      version: 2,
      draftStart,
      draftEnd,
      applied,
      search,
      ...(q.data && applied
        ? {
            snapshot: q.data,
            snapshotKey: scoringSnapshotKey(applied),
            snapshotAt: Date.now(),
          }
        : {}),
    };
    saveEmployeeScoringSession(payload);
  }, [draftStart, draftEnd, applied, search, q.data]);

  const weightPct = (k: keyof typeof SCORING_WEIGHTS) => Math.round(SCORING_WEIGHTS[k] * 100);

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
              disabled={!applied || q.isFetching}
              className="h-8 px-3 rounded-md border border-border text-xs inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
            <button
              onClick={exportCsv}
              disabled={!filteredRows.length}
              className="h-8 px-3 rounded-md border border-border text-xs inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
            <button
              onClick={exportPdf}
              disabled={!filteredRows.length}
              className="h-8 px-3 rounded-md border border-border text-xs inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
            >
              <FileText className="h-3.5 w-3.5" />
              Export PDF
            </button>
          </div>
        }
      />

      <div className="px-5 md:px-8 py-6 space-y-5">
        <div className="surface-card p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <label className="space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Start (local)</span>
            <input
              type="datetime-local"
              value={draftStart}
              onChange={(e) => setDraftStart(e.target.value)}
              className="w-full h-8 px-2 rounded-md border border-border bg-background text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">End (local)</span>
            <input
              type="datetime-local"
              value={draftEnd}
              onChange={(e) => setDraftEnd(e.target.value)}
              className="w-full h-8 px-2 rounded-md border border-border bg-background text-sm"
            />
          </label>
          <button
            type="button"
            onClick={apply}
            className="h-8 px-4 rounded-md bg-foreground text-background text-xs font-medium"
          >
            Apply scoring window
          </button>
          <div className="text-[11px] text-muted-foreground">
            Default: last 7 days. All metrics use this same window.
          </div>
          <div className="md:col-span-4 flex flex-wrap gap-1.5">
            {PRESET_DAYS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => applyPreset(d)}
                className="h-7 px-3 rounded-full text-[11px] font-medium border border-border bg-paper text-muted-foreground hover:text-foreground"
              >
                Last {d} days
              </button>
            ))}
          </div>
        </div>

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
            <span className="px-2 py-0.5 rounded-full border border-border">Work hours {weightPct("workHours")}%</span>
            <span className="px-2 py-0.5 rounded-full border border-border">Meetings {weightPct("meetings")}%</span>
            <span className="px-2 py-0.5 rounded-full border border-border">Emails {weightPct("emails")}%</span>
            <span className="px-2 py-0.5 rounded-full border border-border">Chat {weightPct("chat")}%</span>
            <span className="px-2 py-0.5 rounded-full border border-border">Docs {weightPct("docs")}%</span>
          </div>
        </div>

        {q.data && (
          <div className="surface-card p-3 text-[12px] text-muted-foreground">
            Workspace window (IST): {fmtIso(q.data.range.start)} → {fmtIso(q.data.range.end)} · Time Doctor dates:{" "}
            {q.data.timeDoctorRange.start} → {q.data.timeDoctorRange.end} ({q.data.windowDays} days) · Ranked:{" "}
            {q.data.rows.length}
            {search.trim() ? ` · Showing: ${filteredRows.length}` : ""}
            {q.isFetching ? " · Refreshing…" : cachedSnapshot && !q.isFetching ? " · Restored from session" : ""}
          </div>
        )}

        <div className="relative max-w-sm">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or email..."
            className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-background text-[13px]"
          />
        </div>

        {q.data?.warnings?.length ? (
          <div className="surface-card p-4">
            <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium mb-2">Warnings</div>
            <ul className="text-xs text-muted-foreground space-y-1">
              {q.data.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {q.isLoading && !q.data ? (
          <div className="text-sm text-muted-foreground">Computing scores (Workspace + Time Doctor)...</div>
        ) : null}

        {q.isFetching && q.data ? (
          <div className="text-[11px] text-muted-foreground">Refreshing scores in background...</div>
        ) : null}

        {!q.isLoading && !q.isFetching && q.isError ? (
          <div className="surface-card p-4 text-sm text-destructive">
            {q.error instanceof Error ? q.error.message : "Failed to load employee scoring"}
          </div>
        ) : null}

        {!q.isLoading && !q.isFetching && q.data && filteredRows.length === 0 ? (
          <EmptyState icon={Trophy} title="No scored users" description="No users matched your search in this window." />
        ) : null}

        {!!filteredRows.length && (
          <TableScroll>
            <table className="ops-table w-full">
              <thead>
                <tr>
                  <th align="left">Rank</th>
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
                  <tr key={r.userEmail}>
                    <td className="font-mono text-muted-foreground">#{r.rank}</td>
                    <td>
                      <div className="font-medium text-[13px]">{r.displayName}</div>
                      <div className="text-[11px] text-muted-foreground">{r.userEmail}</div>
                    </td>
                    <td align="center">
                      <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-semibold ${gradeClass(r.grade)}`}>
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
                      {r.percentile.workHours}/{r.percentile.meetings}/{r.percentile.emails}/{r.percentile.chat}/
                      {r.percentile.docs}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </div>
    </div>
  );
}
