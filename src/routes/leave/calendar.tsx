import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, RefreshCw, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { LeaveCalendarView } from "@/components/LeaveCalendarView";
import { LeaveTeamLeavePanel } from "@/components/LeaveTeamLeavePanel";
import { FetchingBar } from "@/components/Skeleton";
import { useAuth } from "@/lib/auth";
import { fmtDate } from "@/lib/format";
import {
  buildLeaveCalendarEvents,
  filterCalendarEventsByKind,
  leaveEventTiming,
  listLeaveByTiming,
  monthContaining,
  timingLabel,
  type LeaveCalendarEvent,
} from "@/lib/leave-calendar";
import {
  getLeaveLedger,
  recordTeamLeave,
  voidTeamLeave,
} from "@/lib/leave-ledger-functions";
import { pacingTodayIso, PACING_LEAVE_HOURS_PER_DAY } from "@/lib/weekly-pacing";

export const Route = createFileRoute("/leave/calendar")({
  component: LeaveCalendarPage,
});

const QUERY_KEY = ["leave-ledger"];

function LeaveCalendarPage() {
  const auth = useAuth();
  const canEdit = auth.hasAnyRole(["super_admin", "ceo", "hr"]);
  const actor = auth.user?.email ?? null;
  const qc = useQueryClient();
  const today = pacingTodayIso();

  const [yearMonth, setYearMonth] = useState(() => today.slice(0, 7));
  const [selectedDay, setSelectedDay] = useState<string | null>(today);
  const [scheduleStart, setScheduleStart] = useState(today);
  const [scheduleEnd, setScheduleEnd] = useState(today);

  const q = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => getLeaveLedger(),
    staleTime: 0,
    refetchOnMount: "always",
  });

  const ledgers = q.data?.ledgers ?? [];
  const teamLeaves = q.data?.teamLeaves ?? [];

  const events = useMemo(
    () => buildLeaveCalendarEvents(teamLeaves, ledgers),
    [teamLeaves, ledgers],
  );

  const teamEvents = useMemo(() => filterCalendarEventsByKind(events, "team"), [events]);
  const personalEvents = useMemo(() => filterCalendarEventsByKind(events, "personal"), [events]);

  const personalLeaveCount = useMemo(
    () => ledgers.reduce((n, l) => n + l.leaveEvents.length, 0),
    [ledgers],
  );

  const teamBuckets = useMemo(() => listLeaveByTiming(teamEvents, today), [teamEvents, today]);
  const personalBuckets = useMemo(
    () => listLeaveByTiming(personalEvents, today),
    [personalEvents, today],
  );

  const selectedDayTeamEvents = useMemo(() => {
    if (!selectedDay) return [];
    return teamEvents.filter((e) => e.startDate <= selectedDay && e.endDate >= selectedDay);
  }, [teamEvents, selectedDay]);

  const selectedDayPersonalEvents = useMemo(() => {
    if (!selectedDay) return [];
    return personalEvents.filter((e) => e.startDate <= selectedDay && e.endDate >= selectedDay);
  }, [personalEvents, selectedDay]);

  const teamLeaveM = useMutation({
    mutationFn: (payload: {
      location: string;
      team: string;
      leaveType: "annual" | "sick" | "personal" | "unpaid" | "other";
      startDate: string;
      endDate: string;
      note?: string;
    }) => recordTeamLeave({ data: { ...payload, actor } }),
    onSuccess: (r) => {
      toast.success(
        `Team leave saved — ${r.affectedCount} employee${r.affectedCount === 1 ? "" : "s"} · shows on calendar & Weekly Pacing (+${r.event.days * PACING_LEAVE_HOURS_PER_DAY}h/day)`,
      );
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["leave-audit-log"] });
      void qc.invalidateQueries({ queryKey: ["weekly-pacing-report"] });
      setYearMonth(monthContaining(r.event.startDate));
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to save team leave"),
  });

  const voidTeamM = useMutation({
    mutationFn: (eventId: string) => voidTeamLeave({ data: { eventId, actor } }),
    onSuccess: () => {
      toast.success("Team leave removed from calendar");
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["leave-audit-log"] });
      void qc.invalidateQueries({ queryKey: ["weekly-pacing-report"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to remove team leave"),
  });

  function selectDay(iso: string) {
    setSelectedDay(iso);
    setScheduleStart(iso);
    setScheduleEnd(iso);
  }

  function focusEvent(ev: LeaveCalendarEvent) {
    setYearMonth(monthContaining(ev.startDate));
    setSelectedDay(ev.startDate);
    setScheduleStart(ev.startDate);
    setScheduleEnd(ev.endDate);
  }

  return (
    <div className="px-5 md:px-8 py-6 space-y-5">
      <FetchingBar active={q.isFetching} />

      <div className="surface-card p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="font-medium text-[13px] flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-sky-600" />
            Team leave calendar
          </div>
          <p className="text-[12px] text-muted-foreground mt-1 max-w-2xl">
            Team blocks and individual employee leave — synced from{" "}
            <Link to="/leave" className="text-foreground underline underline-offset-2">
              Leave → Employees
            </Link>
            . Schedule team holidays here; record personal leave per employee on the ledger. Both
            appear on this calendar · +{PACING_LEAVE_HOURS_PER_DAY}h/workday credit in Weekly Pacing.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void q.refetch()}
            disabled={q.isFetching}
            className="h-8 px-3 rounded-md border border-border text-xs font-medium hover:bg-muted disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
            Sync
          </button>
          <Link
            to="/leave"
            className="h-8 px-3 rounded-md border border-border text-xs font-medium hover:bg-muted inline-flex items-center gap-1.5"
          >
            <Users className="h-3.5 w-3.5" />
            Employee ledger
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="xl:col-span-2 space-y-4">
          <LeaveCalendarView
            yearMonth={yearMonth}
            todayIso={today}
            events={events}
            totalTeamLeaveCount={teamLeaves.length}
            totalPersonalLeaveCount={personalLeaveCount}
            selectedDay={selectedDay}
            onMonthChange={setYearMonth}
            onSelectDay={selectDay}
            onSelectEvent={focusEvent}
          />

          {selectedDay ? (
            <div className="surface-card p-4 space-y-4">
              <div className="font-medium text-[13px]">{fmtDate(selectedDay)}</div>

              <div className="space-y-2">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                  Team leave ({selectedDayTeamEvents.length})
                </div>
                {selectedDayTeamEvents.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">
                    No team leave on this day. Use the form to schedule one.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {selectedDayTeamEvents.map((ev) => (
                      <TeamLeaveEventCard
                        key={ev.id}
                        ev={ev}
                        today={today}
                        canEdit={canEdit}
                        removing={voidTeamM.isPending}
                        onRemove={() => voidTeamM.mutate(ev.teamEventId!)}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2 border-t border-border pt-3">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                  Personal leave ({selectedDayPersonalEvents.length})
                </div>
                {selectedDayPersonalEvents.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">
                    No individual leave on this day. Record on{" "}
                    <Link to="/leave" className="underline underline-offset-2">
                      Leave → Employees
                    </Link>
                    .
                  </p>
                ) : (
                  <div className="space-y-2">
                    {selectedDayPersonalEvents.map((ev) => (
                      <PersonalLeaveEventCard key={ev.id} ev={ev} today={today} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <TeamLeaveRegistry
            title="All team leave (ledger sync)"
            events={teamEvents}
            today={today}
            canEdit={canEdit}
            removing={voidTeamM.isPending}
            onFocus={focusEvent}
            onRemove={(id) => voidTeamM.mutate(id)}
            empty="No team leave in S3 yet — add from here or Leave → Employees."
          />
        </div>

        <div className="space-y-4">
          <LeaveTeamLeavePanel
            ledgers={ledgers}
            teamLeaves={teamLeaves}
            canEdit={canEdit}
            saving={teamLeaveM.isPending || voidTeamM.isPending}
            initialStartDate={scheduleStart}
            initialEndDate={scheduleEnd}
            showRecentList={false}
            onRecord={(payload) => teamLeaveM.mutate(payload)}
            onVoid={(eventId) => voidTeamM.mutate(eventId)}
          />

          <TeamLeaveScheduleList
            title="Personal — active now"
            events={personalBuckets.active}
            today={today}
            onFocus={focusEvent}
            empty="No personal leave active today."
            variant="personal"
          />
          <TeamLeaveScheduleList
            title="Personal — upcoming"
            events={personalBuckets.upcoming}
            today={today}
            onFocus={focusEvent}
            empty="No upcoming personal leave."
            variant="personal"
          />

          <TeamLeaveScheduleList
            title="Team — active now"
            events={teamBuckets.active}
            today={today}
            onFocus={focusEvent}
            empty="No team leave active today."
            variant="team"
          />
          <TeamLeaveScheduleList
            title="Team — upcoming"
            events={teamBuckets.upcoming}
            today={today}
            onFocus={focusEvent}
            empty="No scheduled team leave."
            variant="team"
          />
          <TeamLeaveScheduleList
            title="Team — past"
            events={teamBuckets.past}
            today={today}
            onFocus={focusEvent}
            empty="No past team leave recorded."
            variant="team"
          />
        </div>
      </div>
    </div>
  );
}

function PersonalLeaveEventCard({ ev, today }: { ev: LeaveCalendarEvent; today: string }) {
  const timing = leaveEventTiming(ev.startDate, ev.endDate, today);
  return (
    <div className="rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[12px] flex flex-col sm:flex-row sm:items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="font-medium">{ev.label}</div>
        <div className="text-muted-foreground">
          {ev.team || ev.location ? (
            <>
              {[ev.team, ev.location].filter(Boolean).join(" · ")} ·{" "}
            </>
          ) : null}
          {fmtDate(ev.startDate)} – {fmtDate(ev.endDate)} · {ev.days} workday{ev.days === 1 ? "" : "s"} ·{" "}
          {ev.leaveType} · {timingLabel(timing)}
        </div>
        {ev.employeeEmail ? (
          <div className="text-muted-foreground text-[11px] mt-0.5">{ev.employeeEmail}</div>
        ) : null}
        {ev.note ? <div className="text-muted-foreground mt-0.5">{ev.note}</div> : null}
      </div>
      <Link
        to="/leave"
        className="h-7 px-2 rounded border border-border text-[11px] hover:bg-muted shrink-0 inline-flex items-center"
      >
        Edit on ledger
      </Link>
    </div>
  );
}

function TeamLeaveEventCard({
  ev,
  today,
  canEdit,
  removing,
  onRemove,
}: {
  ev: LeaveCalendarEvent;
  today: string;
  canEdit: boolean;
  removing: boolean;
  onRemove: () => void;
}) {
  const timing = leaveEventTiming(ev.startDate, ev.endDate, today);
  return (
    <div className="rounded-md border border-sky-500/25 bg-sky-500/[0.06] px-3 py-2 text-[12px] flex flex-col sm:flex-row sm:items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="font-medium">
          {ev.label} · {ev.location}
        </div>
        <div className="text-muted-foreground">
          {fmtDate(ev.startDate)} – {fmtDate(ev.endDate)} · {ev.days} workday{ev.days === 1 ? "" : "s"} ·{" "}
          {ev.leaveType} · {timingLabel(timing)} · +{PACING_LEAVE_HOURS_PER_DAY}h/day
        </div>
        {ev.note ? <div className="text-muted-foreground mt-0.5">{ev.note}</div> : null}
      </div>
      {canEdit ? (
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          className="h-7 px-2 rounded border border-border text-[11px] text-destructive hover:bg-destructive/5 flex items-center gap-1 shrink-0"
        >
          <Trash2 className="h-3 w-3" />
          Remove
        </button>
      ) : null}
    </div>
  );
}

function TeamLeaveScheduleList({
  title,
  events,
  today,
  onFocus,
  empty,
  variant = "team",
}: {
  title: string;
  events: LeaveCalendarEvent[];
  today: string;
  onFocus: (ev: LeaveCalendarEvent) => void;
  empty: string;
  variant?: "team" | "personal";
}) {
  const titleClass =
    variant === "personal"
      ? "font-medium text-amber-900 dark:text-amber-200"
      : "font-medium text-sky-800 dark:text-sky-200";
  return (
    <div className="surface-card p-4 space-y-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{title}</div>
      {events.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">{empty}</p>
      ) : (
        <div className="space-y-2">
          {events.slice(0, 8).map((ev) => {
            const timing = leaveEventTiming(ev.startDate, ev.endDate, today);
            return (
              <button
                key={ev.id}
                type="button"
                onClick={() => onFocus(ev)}
                className="w-full text-left rounded-md border border-border px-2.5 py-2 text-[11px] hover:bg-muted/50 transition-colors"
              >
                <div className={titleClass}>
                  {variant === "team" ? `${ev.label} · ${ev.location}` : ev.label}
                </div>
                <div className="text-muted-foreground">
                  {variant === "personal" && (ev.team || ev.location) ? (
                    <>{[ev.team, ev.location].filter(Boolean).join(" · ")} · </>
                  ) : null}
                  {fmtDate(ev.startDate)} – {fmtDate(ev.endDate)} · {ev.days}d · {ev.leaveType} ·{" "}
                  {timingLabel(timing)}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TeamLeaveRegistry({
  title,
  events,
  today,
  canEdit,
  removing,
  onFocus,
  onRemove,
  empty,
}: {
  title: string;
  events: LeaveCalendarEvent[];
  today: string;
  canEdit: boolean;
  removing: boolean;
  onFocus: (ev: LeaveCalendarEvent) => void;
  onRemove: (teamEventId: string) => void;
  empty: string;
}) {
  return (
    <div className="surface-card p-4 space-y-3">
      <div className="font-medium text-[13px]">{title}</div>
      <p className="text-[11px] text-muted-foreground">
        Every team leave saved from this UI or Leave → Employees — same S3 ledger, always in sync.
      </p>
      {events.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">{empty}</p>
      ) : (
        <div className="space-y-2 max-h-[320px] overflow-y-auto">
          {[...events].reverse().map((ev) => (
            <div
              key={ev.id}
              className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-md border border-border px-3 py-2 text-[12px]"
            >
              <button type="button" onClick={() => onFocus(ev)} className="flex-1 text-left min-w-0">
                <div className="font-medium">
                  {ev.label} · {ev.location}
                </div>
                <div className="text-muted-foreground">
                  {fmtDate(ev.startDate)} – {fmtDate(ev.endDate)} · {timingLabel(leaveEventTiming(ev.startDate, ev.endDate, today))}
                </div>
              </button>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => onRemove(ev.teamEventId!)}
                  disabled={removing}
                  className="h-7 px-2 rounded border border-border text-[11px] text-destructive hover:bg-destructive/5 shrink-0"
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
