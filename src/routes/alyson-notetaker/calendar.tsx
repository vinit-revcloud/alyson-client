import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/AppShell";
import { CalendarDays, Captions, Copy, FileText, X } from "lucide-react";
import { listMeetingsFromS3Range, getMeetingNotesMdFromS3, getMeetingTranscriptTextFromS3, ensureMeetingNotesInS3Fn, auditNotetakerNotesCoverage, backfillMissingNotetakerNotes } from "@/lib/notetaker-s3-calendar-functions";
import { toast } from "sonner";
import { z } from "zod";

type MeetingRow = {
  prefix: string;
  botId: string | null;
  day: string;
  title: string;
  startedAt: string | null;
  notesKey: string | null;
  transcriptKey: string | null;
  hasNotes?: boolean;
  hasTranscript?: boolean;
};

const calendarSearchSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  transcriptKey: z.string().min(1).optional(),
  open: z.enum(["transcript", "notes"]).optional(),
});

export const Route = createFileRoute("/alyson-notetaker/calendar")({
  head: () => ({ meta: [{ title: "Meeting Calendar — Alyson Notetaker" }] }),
  validateSearch: (search) => calendarSearchSchema.parse(search),
  component: CalendarPage,
});

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

function startOfMonth(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function endOfMonth(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

function addMonths(d: Date, delta: number) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1));
}

function monthLabel(d: Date) {
  return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** 0 = Monday … 6 = Sunday */
function weekdayIndexMondayFirst(iso: string): number {
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return (dow + 6) % 7;
}

function weekdayName(iso: string, short = false): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    weekday: short ? "short" : "long",
    timeZone: "UTC",
  });
}

function formatMeetingTime(startedAt: string | null, day: string) {
  if (!startedAt) return day;
  const d = new Date(startedAt);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function meetingNotesKey(m: MeetingRow): string {
  return m.notesKey ?? `alyson-notetaker/meetingnotes/${m.prefix}/notes.md`;
}

function meetingTranscriptKey(m: MeetingRow): string {
  return m.transcriptKey ?? `alyson-notetaker/transcripts/${m.prefix}/transcript.txt`;
}

function CalendarPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();
  const deepLinkHandled = useRef(false);
  const detailPanelRef = useRef<HTMLDivElement>(null);

  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [picked, setPicked] = useState<string | null>(null);
  const [viewDoc, setViewDoc] = useState<{
    kind: "notes" | "transcript";
    key: string;
    meetingTitle: string;
    botId: string | null;
    prefix: string;
  } | null>(null);

  useEffect(() => {
    const { day, transcriptKey, open } = search;
    if (!day && !transcriptKey) {
      deepLinkHandled.current = false;
      return;
    }
    if (deepLinkHandled.current) return;
    deepLinkHandled.current = true;

    if (day) {
      const d = new Date(`${day}T12:00:00Z`);
      if (!Number.isNaN(d.getTime())) {
        setMonth(startOfMonth(d));
        setPicked(day);
      }
    }

    if (transcriptKey && (open === "transcript" || open === undefined)) {
      setViewDoc({ kind: "transcript", key: transcriptKey, meetingTitle: "Meeting transcript", botId: null, prefix: "" });
      toast.message("Opening transcript…");
    } else if (transcriptKey && open === "notes") {
      setViewDoc({ kind: "notes", key: transcriptKey, meetingTitle: "Meeting notes", botId: null, prefix: "" });
      toast.message("Opening notes…");
    }

    navigate({ search: {}, replace: true });
  }, [search, navigate]);

  const range = useMemo(() => {
    const s = startOfMonth(month);
    const e = endOfMonth(month);
    return { start: isoDay(s), end: isoDay(e) };
  }, [month]);

  const q = useQuery({
    queryKey: ["notetaker-calendar", range.start, range.end],
    queryFn: () => listMeetingsFromS3Range({ data: range }),
    staleTime: 60_000,
  });

  const meetings = (q.data?.meetings ?? []) as MeetingRow[];

  const byDay = useMemo(() => {
    const m = new Map<string, MeetingRow[]>();
    for (const row of meetings) {
      const arr = m.get(row.day) ?? [];
      arr.push(row);
      m.set(row.day, arr);
    }
    return m;
  }, [meetings]);

  const calendarCells = useMemo(() => {
    const s = startOfMonth(month);
    const e = endOfMonth(month);
    const firstIso = isoDay(s);
    const lead = weekdayIndexMondayFirst(firstIso);
    const cells: (string | null)[] = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = new Date(s); d <= e; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))) {
      cells.push(isoDay(d));
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [month]);

  const pickedMeetings = picked ? byDay.get(picked) ?? [] : [];
  const total = meetings.length;

  function pickDay(day: string) {
    setPicked(day);
    setViewDoc(null);
  }

  function openMeetingDoc(kind: "notes" | "transcript", m: MeetingRow) {
    setViewDoc({
      kind,
      key: kind === "notes" ? meetingNotesKey(m) : meetingTranscriptKey(m),
      meetingTitle: m.title,
      botId: m.botId,
      prefix: m.prefix,
    });
  }

  function closeMeetingDoc() {
    setViewDoc(null);
  }

  useEffect(() => {
    if (!picked) return;
    const t = window.setTimeout(() => {
      detailPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    return () => window.clearTimeout(t);
  }, [picked]);

  function clearPickedDay() {
    setPicked(null);
    setViewDoc(null);
  }

  useEffect(() => {
    if (!viewDoc) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeMeetingDoc();
    }
    document.addEventListener("keydown", onKeyDown);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prev;
    };
  }, [viewDoc]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__ALYSON_MINI_CONTEXT__ = {
      module: "notetaker-calendar",
      range,
      monthLabel: monthLabel(month),
      totalMeetingsInMonth: total,
      pickedDay: picked,
      meetingsShown: (picked ? pickedMeetings : meetings).map((m) => ({
        title: m.title,
        day: m.day,
        startedAt: m.startedAt,
        prefix: m.prefix,
      })),
    };
  }, [month, range, total, picked, pickedMeetings, meetings]);

  const notesQ = useQuery({
    queryKey: ["notetaker-s3-doc", viewDoc?.kind, viewDoc?.key],
    queryFn: async () => {
      if (!viewDoc) return { text: "" };
      if (viewDoc.kind === "notes") {
        const r = await getMeetingNotesMdFromS3({ data: { notesKey: viewDoc.key } });
        return { text: r.notesMd };
      }
      const r = await getMeetingTranscriptTextFromS3({ data: { transcriptKey: viewDoc.key } });
      return { text: r.transcriptText };
    },
    enabled: Boolean(viewDoc?.key),
    staleTime: 10 * 60_000,
    retry: false,
  });

  const generateNotesM = useMutation({
    mutationFn: async () => {
      if (!viewDoc) throw new Error("No meeting selected");
      return ensureMeetingNotesInS3Fn({
        data: { botId: viewDoc.botId ?? undefined, prefix: viewDoc.prefix },
      });
    },
    onSuccess: (res) => {
      if (res.ok && res.notesMd) {
        toast.success("Notes saved to S3");
        qc.setQueryData(["notetaker-s3-doc", "notes", viewDoc?.key], { text: res.notesMd });
        void qc.invalidateQueries({ queryKey: ["notetaker-calendar"] });
        void qc.invalidateQueries({ queryKey: ["notetaker-notes-coverage"] });
        void notesQ.refetch();
      } else if (res.ok) {
        toast.success("Notes saved to S3");
        void notesQ.refetch();
      } else {
        toast.error(String(res.skipped || "Could not generate notes"));
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to generate notes"),
  });

  const coverageQ = useQuery({
    queryKey: ["notetaker-notes-coverage"],
    queryFn: () => auditNotetakerNotesCoverage(),
    staleTime: 5 * 60_000,
  });

  const backfillM = useMutation({
    mutationFn: (all: boolean) => backfillMissingNotetakerNotes({ data: all ? { all: true } : { limit: 20 } }),
    onSuccess: (res) => {
      toast.success(
        `Notes generated — ${"succeeded" in res ? res.succeeded : 0} saved, ${res.remainingMissing} still missing`,
      );
      void qc.invalidateQueries({ queryKey: ["notetaker-calendar"] });
      void qc.invalidateQueries({ queryKey: ["notetaker-notes-coverage"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Backfill failed"),
  });

  const coverage = coverageQ.data?.report;

  return (
    <div className="ops-dense">
      <PageHeader
        eyebrow="Operations"
        title="Meeting calendar"
        description="Browse meeting notes (from S3) by date."
        dense
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/alyson-notetaker"
              onClick={() => toast.message("Alyson Notetaker")}
              reloadDocument
              className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
            >
              <Captions className="h-3.5 w-3.5" />
              Alyson Notetaker
            </Link>
          </div>
        }
      />

      <div className="px-5 md:px-8 py-4 space-y-3">
        <div className="surface-card p-2.5 sm:p-3 flex items-center gap-2">
          <CalendarDays className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <div className="text-[13px] font-medium">{monthLabel(month)}</div>
          <div className="text-[11px] text-muted-foreground">{q.isLoading ? "Loading…" : `${total} meeting${total === 1 ? "" : "s"}`}</div>
          {coverage && (
            <div className="text-[10px] text-muted-foreground flex flex-wrap items-center gap-x-1.5">
              <span>{coverage.withBoth}/{coverage.withTranscript} have notes</span>
              {coverage.missingNotes.length > 0 && (
                <button
                  type="button"
                  onClick={() => backfillM.mutate(true)}
                  disabled={backfillM.isPending}
                  className="underline underline-offset-2 hover:text-foreground disabled:opacity-50 font-medium text-foreground"
                >
                  {backfillM.isPending ? "Generating all notes…" : `Generate all ${coverage.missingNotes.length} missing`}
                </button>
              )}
            </div>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={() => setMonth((m) => addMonths(m, -1))} className="h-7 px-2.5 rounded-md border border-border text-[11px] hover:bg-muted">
              Prev
            </button>
            <button onClick={() => setMonth((m) => addMonths(m, 1))} className="h-7 px-2.5 rounded-md border border-border text-[11px] hover:bg-muted">
              Next
            </button>
          </div>
        </div>

        {q.isError && (
          <div className="surface-card p-4 text-sm text-destructive whitespace-pre-wrap">
            {q.error instanceof Error ? q.error.message : "Failed to load calendar."}
          </div>
        )}

        <div className="space-y-1.5">
          <div className="grid grid-cols-7 gap-1.5">
            {WEEKDAYS.map((label, i) => (
              <div
                key={label}
                className="text-center text-[9px] sm:text-[10px] uppercase tracking-wide font-medium text-muted-foreground py-1 px-0.5 rounded bg-muted/40 border border-border/60"
                title={label}
              >
                <span className="hidden sm:inline">{label}</span>
                <span className="sm:hidden">{WEEKDAYS_SHORT[i]}</span>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1.5">
            {calendarCells.map((d, idx) => {
              if (!d) {
                return <div key={`pad-${idx}`} className="min-h-[58px] sm:min-h-[62px] rounded border border-transparent" aria-hidden />;
              }
              const count = byDay.get(d)?.length ?? 0;
              const active = picked === d;
              const isToday = d === isoDay(new Date());
              const hasMeetings = count > 0;
              return (
                <button
                  key={d}
                  onClick={() => pickDay(d)}
                  aria-pressed={active}
                  aria-current={isToday ? "date" : undefined}
                  aria-label={
                    isToday
                      ? `Today, ${weekdayName(d)}, ${count} meetings${active ? ", selected" : ""}`
                      : `${weekdayName(d)} ${d.slice(8)}, ${count} meetings${active ? ", selected" : ""}`
                  }
                  className={
                    "surface-card text-left hover:shadow-sm transition-all relative flex flex-col rounded " +
                    (active
                      ? "ring-2 ring-offset-1 ring-offset-background ring-foreground border-2 border-foreground bg-muted/60 shadow-sm z-[1] "
                      : "") +
                    (isToday
                      ? "min-h-[72px] sm:min-h-[76px] -m-0.5 p-2 sm:p-2.5 border-2 border-foreground/55 bg-muted/80 ring-2 ring-foreground/15 shadow-sm z-10 "
                      : "min-h-[58px] sm:min-h-[62px] p-1.5 sm:p-2 border ") +
                    (!active && !isToday && hasMeetings ? "border-foreground/15 bg-muted/40 " : "") +
                    (!active && !isToday && !hasMeetings ? "border-border " : "")
                  }
                >
                  {active && (
                    <span className="absolute top-1 right-1 text-[8px] font-semibold uppercase tracking-wide px-1 py-px rounded bg-foreground text-background">
                      Selected
                    </span>
                  )}
                  <div className={"truncate text-[9px] sm:text-[10px] " + (isToday ? "text-muted-foreground font-medium" : "text-muted-foreground/70")}>
                    {weekdayName(d, true)}
                  </div>

                  <div className="flex items-baseline gap-1 mt-0.5">
                    <span
                      className={
                        "font-bold tabular-nums leading-none " +
                        (isToday ? "text-lg sm:text-xl text-foreground " : "text-base sm:text-lg ") +
                        (!isToday && (hasMeetings ? "text-foreground " : "text-muted-foreground "))
                      }
                    >
                      {d.slice(8)}
                    </span>
                    {isToday && (
                      <span className="text-[9px] font-semibold uppercase tracking-wide text-foreground/70">
                        Today
                      </span>
                    )}
                  </div>

                  <div className={"mt-auto " + (isToday ? "pt-1.5" : "pt-1")}>
                    {hasMeetings ? (
                      <span
                        className={
                          "inline-flex items-center rounded-full bg-foreground text-background font-semibold tabular-nums " +
                          (isToday ? "text-[10px] sm:text-[11px] px-1.5 py-px " : "text-[10px] px-1.5 py-px ")
                        }
                      >
                        {count} mtg{count === 1 ? "" : "s"}
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground/45">—</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {!picked && (
            <p className="text-center text-[11px] text-muted-foreground py-0.5">
              Select a date — meetings list below, notes/transcripts open in a popup
            </p>
          )}
        </div>

        <div
          ref={detailPanelRef}
          id="calendar-day-detail"
          className={
            "surface-card overflow-hidden scroll-mt-4 transition-all " +
            (picked ? "ring-1 ring-foreground/20 border-foreground/25" : "border-dashed")
          }
        >
          {!picked ? (
            <div className="px-4 py-5 text-center">
              <CalendarDays className="h-4 w-4 text-muted-foreground mx-auto mb-1.5" />
              <div className="text-[12px] font-medium text-foreground">No date selected</div>
              <p className="mt-1 text-[11px] text-muted-foreground max-w-sm mx-auto">
                Pick a day above to see meetings for that date.
              </p>
            </div>
          ) : (
            <>
              <div className="px-3 py-2.5 border-b border-border bg-muted/30">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="inline-flex items-center rounded-full bg-foreground text-background text-[9px] font-semibold uppercase tracking-wide px-1.5 py-px">
                      Selected
                    </div>
                    <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-xl font-bold tabular-nums">{picked.slice(8)}</span>
                      <span className="text-[12px] font-medium">{weekdayName(picked)}</span>
                      <span className="text-[11px] text-muted-foreground">{picked}</span>
                      <span className="text-[10px] font-semibold tabular-nums text-muted-foreground">
                        · {pickedMeetings.length} meeting{pickedMeetings.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={clearPickedDay}
                    className="h-7 px-2 rounded-md border border-border bg-background text-[10px] font-medium hover:bg-muted inline-flex items-center gap-1 shrink-0"
                  >
                    <X className="h-3 w-3" />
                    Clear
                  </button>
                </div>
              </div>

              <div className="p-2 space-y-1">
                {q.isLoading ? (
                  <div className="space-y-1.5">
                    {[0, 1].map((i) => (
                      <div key={i} className="rounded border border-border p-2.5 animate-pulse">
                        <div className="h-3 w-2/3 bg-muted rounded" />
                        <div className="h-2.5 w-1/3 bg-muted rounded mt-1.5" />
                      </div>
                    ))}
                  </div>
                ) : pickedMeetings.length === 0 ? (
                  <div className="rounded border border-dashed border-border p-4 text-center text-[12px] text-muted-foreground">
                    No meetings for this day.
                  </div>
                ) : (
                  pickedMeetings.map((m) => {
                    const notesKey = meetingNotesKey(m);
                    const transcriptKey = meetingTranscriptKey(m);
                    const notesOpen = viewDoc?.kind === "notes" && viewDoc.key === notesKey;
                    const transcriptOpen = viewDoc?.kind === "transcript" && viewDoc.key === transcriptKey;
                    const rowActive = notesOpen || transcriptOpen;
                    return (
                      <div
                        key={m.prefix}
                        className={
                          "rounded border px-2 py-1.5 transition-colors flex items-center gap-2 " +
                          (rowActive ? "border-foreground/30 bg-muted/50" : "border-border")
                        }
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-[12px] truncate leading-tight">{m.title}</div>
                          <div className="text-[10px] text-muted-foreground truncate leading-tight">
                            {formatMeetingTime(m.startedAt, m.day)}
                            {m.hasNotes === false && m.hasTranscript !== false && (
                              <span className="ml-1 text-amber-600 dark:text-amber-400">· no notes</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => openMeetingDoc("notes", m)}
                            className={
                              "h-6 px-2 rounded text-[10px] font-medium inline-flex items-center gap-0.5 " +
                              (notesOpen
                                ? "bg-foreground text-background"
                                : "border border-border bg-background hover:bg-muted")
                            }
                          >
                            <FileText className="h-3 w-3" />
                            Notes
                          </button>
                          <button
                            onClick={() => openMeetingDoc("transcript", m)}
                            className={
                              "h-6 px-2 rounded text-[10px] font-medium inline-flex items-center gap-0.5 " +
                              (transcriptOpen
                                ? "bg-foreground text-background"
                                : "border border-border bg-background hover:bg-muted")
                            }
                          >
                            <Captions className="h-3 w-3" />
                            Transcript
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {viewDoc && (
        <div
          className="fixed inset-0 z-[60] bg-black/55 grid place-items-center px-4 py-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="calendar-doc-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeMeetingDoc();
          }}
        >
          <div className="w-full max-w-3xl max-h-[min(88vh,820px)] rounded-lg border border-border bg-background shadow-2xl overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-border bg-muted/40 flex items-center gap-2 shrink-0">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
                  {viewDoc.kind === "notes" ? "Meeting notes" : "Transcript"}
                </div>
                <div id="calendar-doc-title" className="font-medium text-[14px] truncate">
                  {viewDoc.meetingTitle}
                </div>
              </div>
              <div className="ml-auto flex items-center gap-2 shrink-0">
                <button
                  onClick={async () => {
                    const text = notesQ.data?.text ?? "";
                    if (!text.trim()) return toast.error("Nothing to copy");
                    try {
                      await navigator.clipboard.writeText(text);
                      toast.success(viewDoc.kind === "notes" ? "Notes copied" : "Transcript copied");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Failed to copy");
                    }
                  }}
                  disabled={notesQ.isLoading || notesQ.isError || !notesQ.data?.text?.trim()}
                  className="h-8 w-8 grid place-items-center rounded-md border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted/40 disabled:opacity-50"
                  title="Copy"
                  aria-label="Copy"
                >
                  <Copy className="h-4 w-4" />
                </button>
                <button
                  onClick={closeMeetingDoc}
                  className="h-8 px-3 rounded-md border border-border bg-background text-xs hover:bg-muted inline-flex items-center gap-1"
                >
                  <X className="h-3.5 w-3.5" />
                  Close
                </button>
              </div>
            </div>
            <div className="p-4 overflow-y-auto flex-1 min-h-0">
              {(notesQ.isLoading || generateNotesM.isPending) && (
                <div className="space-y-2 animate-pulse">
                  <div className="h-3 bg-muted rounded w-full" />
                  <div className="h-3 bg-muted rounded w-5/6" />
                  <div className="h-3 bg-muted rounded w-4/5" />
                  <p className="text-sm text-muted-foreground pt-2">
                    {generateNotesM.isPending
                      ? "Generating notes from transcript and saving to S3…"
                      : viewDoc.kind === "notes"
                        ? "Reading notes from S3…"
                        : "Reading transcript from S3…"}
                  </p>
                </div>
              )}
              {notesQ.isError && !generateNotesM.isPending && (
                <div className="text-sm space-y-3">
                  <p className="text-muted-foreground">
                    Notes are not in S3 yet for this meeting.
                  </p>
                  {viewDoc.kind === "notes" && (
                    <button
                      type="button"
                      onClick={() => generateNotesM.mutate()}
                      disabled={generateNotesM.isPending}
                      className="h-8 px-3 rounded-md bg-foreground text-background text-xs font-medium disabled:opacity-50"
                    >
                      Generate notes from transcript
                    </button>
                  )}
                </div>
              )}
              {!notesQ.isLoading && !generateNotesM.isPending && !notesQ.isError && notesQ.data?.text && (
                <pre className="whitespace-pre-wrap text-[13px] leading-relaxed">{notesQ.data.text}</pre>
              )}
              {!notesQ.isLoading && !generateNotesM.isPending && !notesQ.isError && !notesQ.data?.text?.trim() && (
                <div className="text-sm text-muted-foreground space-y-3">
                  <p>No {viewDoc.kind === "notes" ? "notes" : "transcript"} in S3 for this meeting yet.</p>
                  {viewDoc.kind === "notes" && (
                    <button
                      type="button"
                      onClick={() => generateNotesM.mutate()}
                      disabled={generateNotesM.isPending}
                      className="h-8 px-3 rounded-md bg-foreground text-background text-xs font-medium disabled:opacity-50"
                    >
                      Generate notes from transcript
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
