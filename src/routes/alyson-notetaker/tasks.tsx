import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/AppShell";
import { EmployeeEmailPicker, resolveEmployeeFromQuery } from "@/components/EmployeeEmailPicker";
import { CalendarDays, Captions, ListTodo, RefreshCw, Sparkles, User } from "lucide-react";
import { toast } from "sonner";
import { getEmployeePickerDirectory } from "@/lib/employee-picker-functions";
import { getNotetakerTasksInsights, getNotetakerTasksReport } from "@/lib/notetaker-tasks-functions";
import type { MeetingTask, UserTaskRollup } from "@/lib/notetaker-tasks-types";

export const Route = createFileRoute("/alyson-notetaker/tasks")({
  head: () => ({ meta: [{ title: "Meeting Tasks — Alyson Notetaker" }] }),
  component: TasksPage,
});

const PERIOD_DAYS = [7, 14, 30] as const;
type PeriodDays = (typeof PERIOD_DAYS)[number];
const DEFAULT_PERIOD: PeriodDays = 7;
const MAX_CUSTOM_RANGE_DAYS = 90;

type PeriodMode = "preset" | "custom";

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

function isIsoDate(v: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function rangeForLastDays(days: number) {
  const end = isoDay(new Date());
  const startDate = new Date();
  startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
  return { start: isoDay(startDate), end };
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

const PRIORITY_CLASS: Record<string, string> = {
  high: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  medium: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  low: "border-border bg-muted/40 text-muted-foreground",
};

function TaskRow({ task }: { task: MeetingTask }) {
  return (
    <div className="rounded-md border border-border bg-paper px-3 py-2.5 space-y-1.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="font-medium text-[13px] leading-snug">{task.title}</div>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${PRIORITY_CLASS[task.priority] ?? PRIORITY_CLASS.medium}`}
        >
          {task.priority}
        </span>
      </div>
      <div className="text-[11.5px] text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>{task.meetingTitle}</span>
        <span>·</span>
        <span>{task.meetingDay}</span>
        {task.dueHint ? (
          <>
            <span>·</span>
            <span>Due: {task.dueHint}</span>
          </>
        ) : null}
        {task.status !== "open" ? (
          <>
            <span>·</span>
            <span className="capitalize">{task.status}</span>
          </>
        ) : null}
      </div>
      {task.sourceQuote ? (
        <div className="text-[11px] text-muted-foreground italic border-l-2 border-border pl-2">
          “{task.sourceQuote}”
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2 pt-0.5">
        {task.transcriptKey ? (
          <Link
            to="/alyson-notetaker/calendar"
            search={{ day: task.meetingDay, transcriptKey: task.transcriptKey, open: "transcript" }}
            className="text-[11px] text-foreground underline underline-offset-2"
          >
            View transcript
          </Link>
        ) : null}
        {task.notesKey ? (
          <Link
            to="/alyson-notetaker/calendar"
            search={{ day: task.meetingDay, transcriptKey: task.notesKey, open: "notes" }}
            className="text-[11px] text-foreground underline underline-offset-2"
          >
            View notes
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function UserSection({ rollup }: { rollup: UserTaskRollup }) {
  return (
    <section className="surface-card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-8 w-8 rounded-full bg-muted grid place-items-center shrink-0">
            <User className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="font-medium text-[14px] truncate">{rollup.assigneeName}</div>
            <div className="text-[11px] text-muted-foreground truncate">{rollup.assigneeEmail}</div>
          </div>
        </div>
        <div className="text-[12px] text-muted-foreground">
          {rollup.openCount} open · {rollup.tasks.length} total
        </div>
      </div>
      <div className="space-y-2">
        {rollup.tasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </div>
    </section>
  );
}

function TasksPage() {
  const defaultRange = rangeForLastDays(DEFAULT_PERIOD);
  const [periodMode, setPeriodMode] = useState<PeriodMode>("preset");
  const [periodDays, setPeriodDays] = useState<PeriodDays>(DEFAULT_PERIOD);
  const [customStart, setCustomStart] = useState(defaultRange.start);
  const [customEnd, setCustomEnd] = useState(defaultRange.end);
  const [personSearch, setPersonSearch] = useState("");
  const [assigneeEmail, setAssigneeEmail] = useState<string | null>(null);
  const [assigneeName, setAssigneeName] = useState<string | null>(null);
  const [insightsMd, setInsightsMd] = useState<string | null>(null);

  const range = useMemo(
    () => (periodMode === "preset" ? rangeForLastDays(periodDays) : { start: customStart, end: customEnd }),
    [periodMode, periodDays, customStart, customEnd],
  );

  const customRangeError = periodMode === "custom" ? validateCustomRange(customStart, customEnd) : null;

  const directoryQ = useQuery({
    queryKey: ["employee-picker-directory"],
    queryFn: () => getEmployeePickerDirectory(),
    staleTime: 10 * 60_000,
  });

  const resolvedPerson = useMemo(
    () => resolveEmployeeFromQuery(personSearch, directoryQ.data?.employees ?? []),
    [personSearch, directoryQ.data?.employees],
  );

  const focusEmail = assigneeEmail ?? resolvedPerson?.email ?? null;
  const focusName = assigneeName ?? resolvedPerson?.name ?? null;
  const canCrawl = Boolean(focusEmail?.trim());

  const crawlM = useMutation({
    mutationFn: async (forceRefresh?: boolean) => {
      if (periodMode === "custom") {
        const err = validateCustomRange(customStart, customEnd);
        if (err) throw new Error(err);
      }
      const email = (assigneeEmail ?? resolvedPerson?.email)?.trim();
      if (!email) {
        throw new Error("Select a person from the search list before crawling.");
      }
      const res = await getNotetakerTasksReport({
        data: {
          start: range.start,
          end: range.end,
          assigneeEmail: email,
          assigneeName: (assigneeName ?? resolvedPerson?.name)?.trim() || undefined,
          maxMeetings: 25,
          forceRefresh,
        },
      });
      return res.report;
    },
    onSuccess: (report) => {
      setInsightsMd(null);
      toast.success(`Extracted ${report.totalTasks} tasks from ${report.analyzedMeetings} meetings`);
    },
    onError: (e: Error) => toast.error(e.message || "Task crawl failed"),
  });

  const insightsM = useMutation({
    mutationFn: async () => {
      if (!crawlM.data) throw new Error("Run the task crawl first");
      const res = await getNotetakerTasksInsights({ data: { report: crawlM.data } });
      return res.insightsMd;
    },
    onSuccess: (md) => {
      setInsightsMd(md);
      toast.success("AI insights ready");
    },
    onError: (e: Error) => toast.error(e.message || "Insights failed"),
  });

  const report = crawlM.data;

  return (
    <div className="ops-dense">
      <PageHeader
        eyebrow="Operations"
        title="Meeting tasks"
        description="Search a person, then crawl only their meetings and action items from S3 — scoped Groq extraction to save tokens."
        dense
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/alyson-notetaker/unified-meetings"
              className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
            >
              <CalendarDays className="h-3.5 w-3.5" />
              Unified meetings
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
        <div className="surface-card p-4 space-y-4">
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[11.5px] text-muted-foreground">
            <span className="font-medium text-foreground">How it works:</span> Pick one person, then we only scan meetings
            they joined and extract <span className="font-medium text-foreground">their</span> action items via Groq — saves
            tokens vs crawling everyone.
          </div>

          <div className="space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Meeting window</span>
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
                  {range.start} → {range.end}
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
                  <span className="text-[11px] text-muted-foreground">
                    {daysBetweenInclusive(customStart, customEnd)} day
                    {daysBetweenInclusive(customStart, customEnd) === 1 ? "" : "s"}
                  </span>
                </div>
              )}
            </div>
            {customRangeError ? (
              <div className="text-[11px] text-destructive">{customRangeError}</div>
            ) : null}
          </div>

          <div className="space-y-1 max-w-md">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Person (required)
              </span>
              {focusEmail ? (
                <button
                  type="button"
                  onClick={() => {
                    setAssigneeEmail(null);
                    setAssigneeName(null);
                    setPersonSearch("");
                  }}
                  className="text-[10px] text-muted-foreground underline hover:no-underline"
                >
                  Clear
                </button>
              ) : null}
            </div>
            <EmployeeEmailPicker
              query={personSearch}
              onQueryChange={(v) => {
                setPersonSearch(v);
                setAssigneeEmail(null);
                setAssigneeName(null);
              }}
              selectedEmail={assigneeEmail}
              onSelect={(emp) => {
                setAssigneeEmail(emp.email);
                setAssigneeName(emp.name);
                setPersonSearch(emp.name);
              }}
              disabled={crawlM.isPending}
              placeholder="Search by name or email…"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => crawlM.mutate(false)}
              disabled={crawlM.isPending || Boolean(customRangeError) || !canCrawl}
              className="h-8 px-3 rounded-md bg-foreground text-background text-[12px] font-medium inline-flex items-center gap-1.5 hover:opacity-90 disabled:opacity-50"
            >
              {crawlM.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ListTodo className="h-3.5 w-3.5" />}
              {crawlM.isPending ? "Crawling meetings…" : "Crawl tasks for person"}
            </button>
            {report ? (
              <button
                type="button"
                onClick={() => crawlM.mutate(true)}
                disabled={crawlM.isPending || Boolean(customRangeError) || !canCrawl}
                className="h-8 px-3 rounded-md border border-border text-[12px] inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </button>
            ) : null}
            {report ? (
              <button
                type="button"
                onClick={() => insightsM.mutate()}
                disabled={insightsM.isPending}
                className="h-8 px-3 rounded-md border border-border text-[12px] inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {insightsM.isPending ? "Generating insights…" : "AI insights"}
              </button>
            ) : null}
          </div>

          {crawlM.isPending ? (
            <div className="text-[12px] text-muted-foreground">
              Finding meetings for {focusName || "selected person"} and extracting only their action items…
            </div>
          ) : null}
        </div>

        {report ? (
          <div className="text-[11px] text-muted-foreground">
            {report.focusPerson.name} · {report.range.start} → {report.range.end}
            <span className="mx-2">·</span>
            Model: Groq / {report.model}
          </div>
        ) : null}

        {report ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Meetings in range" value={String(report.meetingCount)} />
            <StatCard label="Their meetings" value={String(report.personMeetingCount)} />
            <StatCard label="Meetings with tasks" value={String(report.analyzedMeetings)} />
            <StatCard label="Tasks extracted" value={String(report.totalTasks)} />
          </div>
        ) : null}

        {insightsMd ? (
          <div className="surface-card p-4 space-y-2">
            <div className="text-[12px] font-medium">AI insights</div>
            <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] whitespace-pre-wrap">{insightsMd}</div>
          </div>
        ) : null}

        {report?.warnings.length ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-900 dark:text-amber-200">
            {report.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        ) : null}

        {report && report.users.length === 0 && report.unassigned.length === 0 ? (
          <div className="surface-card p-8 text-center text-[13px] text-muted-foreground">
            No tasks found for this person in this window. Try a longer period or confirm their meetings were persisted to S3.
          </div>
        ) : null}

        {report?.users.map((rollup) => (
          <UserSection key={rollup.assigneeEmail} rollup={rollup} />
        ))}

        {report && report.unassigned.length > 0 ? (
          <section className="surface-card p-4 space-y-3">
            <div>
              <div className="font-medium text-[14px]">Unassigned</div>
              <div className="text-[11px] text-muted-foreground">
                Action items without a matched owner in the workspace directory
              </div>
            </div>
            <div className="space-y-2">
              {report.unassigned.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-[20px] font-semibold mt-1">{value}</div>
    </div>
  );
}
