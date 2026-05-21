import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/AppShell";
import { CalendarDays, Captions, Copy } from "lucide-react";
import { listMeetingsFromS3Range, getMeetingNotesMdFromS3, getMeetingTranscriptTextFromS3 } from "@/lib/notetaker-s3-calendar-functions";
import { toast } from "sonner";
import { z } from "zod";

type MeetingRow = {
  prefix: string;
  day: string;
  title: string;
  startedAt: string | null;
  notesKey: string | null;
  transcriptKey: string | null;
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

function CalendarPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const deepLinkHandled = useRef(false);

  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [picked, setPicked] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [openKind, setOpenKind] = useState<"notes" | "transcript">("notes");

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
      setOpenKind("transcript");
      setOpenKey(transcriptKey);
      toast.message("Opening transcript…");
    } else if (transcriptKey && open === "notes") {
      setOpenKind("notes");
      setOpenKey(transcriptKey);
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

  const days = useMemo(() => {
    const s = startOfMonth(month);
    const e = endOfMonth(month);
    const out: string[] = [];
    for (let d = new Date(s); d <= e; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))) {
      out.push(isoDay(d));
    }
    return out;
  }, [month]);

  const pickedMeetings = picked ? byDay.get(picked) ?? [] : [];
  const total = meetings.length;

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
    queryKey: ["notetaker-s3-doc", openKind, openKey],
    queryFn: async () => {
      if (!openKey) return { text: "" };
      if (openKind === "notes") {
        const r = await getMeetingNotesMdFromS3({ data: { notesKey: openKey } });
        return { text: r.notesMd };
      }
      const r = await getMeetingTranscriptTextFromS3({ data: { transcriptKey: openKey } });
      return { text: r.transcriptText };
    },
    enabled: Boolean(openKey),
  });

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
              onClick={() => toast.message("Notetaker view")}
              reloadDocument
              className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
            >
              <Captions className="h-3.5 w-3.5" />
              Notetaker
            </Link>
          </div>
        }
      />

      <div className="px-5 md:px-8 py-6 space-y-4">
        <div className="surface-card p-4 flex items-center gap-3">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <div className="font-medium">{monthLabel(month)}</div>
          <div className="text-[12px] text-muted-foreground ml-2">{q.isLoading ? "Loading…" : `${total} meeting${total === 1 ? "" : "s"}`}</div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setMonth((m) => addMonths(m, -1))} className="h-8 px-3 rounded-md border border-border text-xs hover:bg-muted">
              Prev
            </button>
            <button onClick={() => setMonth((m) => addMonths(m, 1))} className="h-8 px-3 rounded-md border border-border text-xs hover:bg-muted">
              Next
            </button>
          </div>
        </div>

        {q.isError && (
          <div className="surface-card p-4 text-sm text-destructive whitespace-pre-wrap">
            {q.error instanceof Error ? q.error.message : "Failed to load calendar."}
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          {days.map((d) => {
            const count = byDay.get(d)?.length ?? 0;
            const active = picked === d;
            return (
              <button
                key={d}
                onClick={() => setPicked(d)}
                className={
                  "surface-card p-3 text-left hover:shadow-md transition-shadow relative " +
                  (active ? "ring-2 ring-foreground/20" : "") +
                  (count ? " border-foreground/15" : "")
                }
              >
                <div className="text-[11px] text-muted-foreground">{d}</div>
                <div className="mt-1 text-[13px] font-medium">{count ? `${count} meeting${count === 1 ? "" : "s"}` : "—"}</div>
                {count > 0 && (
                  <div className="absolute top-2 right-2 h-2 w-2 rounded-full bg-foreground/70" aria-hidden />
                )}
              </button>
            );
          })}
        </div>

        {picked && (
          <div className="surface-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground font-medium">
                Meetings on {picked}
              </div>
              <button
                onClick={() => setPicked(null)}
                className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
              >
                Clear
              </button>
            </div>
            <div className="mt-3 space-y-2">
              {pickedMeetings.length === 0 ? (
                <div className="text-sm text-muted-foreground">No meetings.</div>
              ) : (
                pickedMeetings.map((m) => (
                  <div key={m.prefix} className="rounded-md border border-border p-3 flex items-center gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-[14px] truncate">{m.title}</div>
                      <div className="text-[12px] text-muted-foreground truncate">{m.startedAt ? new Date(m.startedAt).toUTCString() : m.day}</div>
                    </div>
                    <div className="ml-auto">
                      <button
                        onClick={() => {
                          if (!m.notesKey) return toast.error("Notes not available");
                          setOpenKind("notes");
                          setOpenKey(m.notesKey);
                          toast.message("Opening notes…");
                        }}
                        className="h-7 px-2.5 rounded-md bg-foreground text-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
                      >
                        View notes
                      </button>
                    </div>
                    <div>
                      <button
                        onClick={() => {
                          if (!m.transcriptKey) return toast.error("Transcript not available");
                          setOpenKind("transcript");
                          setOpenKey(m.transcriptKey);
                          toast.message("Opening transcript…");
                        }}
                        className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
                      >
                        View transcript
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {openKey && (
        <div className="fixed inset-0 z-[60] bg-black/50 grid place-items-center px-4">
          <div className="w-full max-w-3xl rounded-lg border border-border bg-background shadow-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <div className="font-medium text-[13px]">{openKind === "notes" ? "Meeting notes" : "Transcript"}</div>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={async () => {
                    const text = notesQ.data?.text ?? "";
                    if (!text.trim()) return toast.error("Nothing to copy");
                    try {
                      await navigator.clipboard.writeText(text);
                      toast.success(openKind === "notes" ? "Notes copied to clipboard" : "Transcript copied to clipboard");
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
                  onClick={() => setOpenKey(null)}
                  className="h-8 px-3 rounded-md border border-border text-xs hover:bg-muted"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="p-4 max-h-[70vh] overflow-y-auto">
              {notesQ.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
              {notesQ.isError && (
                <div className="text-sm text-destructive whitespace-pre-wrap">
                  {notesQ.error instanceof Error ? notesQ.error.message : "Failed to load."}
                </div>
              )}
              {notesQ.data?.text && (
                <pre className="whitespace-pre-wrap text-[13px] leading-relaxed">{notesQ.data.text}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
