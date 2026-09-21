import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarDays, Link2, RefreshCw, Unplug, Bot, CalendarPlus, CalendarX } from "lucide-react";

/** Auto-trigger Sync now on Unified Meetings when upcoming − scheduled > 0. Set VITE_RECALL_CALENDAR_AUTO_SYNC=false to disable. */
const RECALL_CALENDAR_AUTO_SYNC =
  String(import.meta.env.VITE_RECALL_CALENDAR_AUTO_SYNC ?? "true").trim().toLowerCase() !== "false";

const AUTO_SYNC_COOLDOWN_MS = 90_000;

import { PageHeader } from "@/components/AppShell";
import { toast } from "sonner";

type UnifiedMeeting = {
  id: string;
  googleEventId: string;
  iCalUID: string;
  calendarUserEmail: string;
  title: string;
  startTime: string;
  endTime: string;
  timezone: string;
  meetingUrl: string | null;
  meetingPlatform: "google_meet" | "unknown";
  eventType: string;
  status: string;
  organizerEmail: string | null;
  attendees: string[];
  shouldBotJoin: boolean;
  botScheduled: boolean;
  botJoinAt: string | null;
  recallBotId?: string | null;
  botStatus: "not_required" | "pending" | "scheduled" | "failed";
  skipReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export const Route = createFileRoute("/alyson-notetaker/analytics/unified-meetings")({
  head: () => ({ meta: [{ title: "Unified Meetings — Alyson Notetaker" }] }),
  component: UnifiedMeetingsPage,
});

type RecallCalendarPendingEvent = {
  eventId: string;
  title: string;
  startTime: string;
  endTime: string;
  meetingUrl: string;
  hasBot: boolean;
  scheduledInApp?: boolean;
  botJoinAt?: string;
  scheduledAt?: string;
  botId?: string;
};

type RecallCalendarConnection = {
  recallCalendarId: string;
  platform: string;
  email: string;
  status: string;
  connectedAt: string;
  lastSyncAt?: string;
  lastSyncSummary?: { scheduled: number; skipped: number; processed: number; errors: number };
  pending?: {
    pendingCount: number;
    needsConfigRefreshCount: number;
    upcomingWithLink: number;
    events: RecallCalendarPendingEvent[];
    transcriptWebhookUrl: string;
  };
};

export function UnifiedMeetingsPage() {
  const [search, setSearch] = useState("");
  const [email, setEmail] = useState("");
  const [hasMeetLink, setHasMeetLink] = useState("");
  const [bulkScheduledByCalendar, setBulkScheduledByCalendar] = useState<Record<string, string[]>>({});
  const [actingMeetingId, setActingMeetingId] = useState<string | null>(null);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (search.trim()) p.set("search", search.trim());
    if (email.trim()) p.set("email", email.trim());
    if (hasMeetLink) p.set("hasMeetLink", hasMeetLink);
    return p.toString();
  }, [search, email, hasMeetLink]);

  const q = useQuery({
    queryKey: ["unified-meetings", queryString],
    queryFn: async () => {
      const res = await fetch(`/api/analytics/unified-meetings${queryString ? `?${queryString}` : ""}`);
      const json = await res.json();
      if (!res.ok) throw new Error(String(json?.error || "Failed to load unified meetings"));
      return json as { meetings: UnifiedMeeting[] };
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const refreshM = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/analytics/unified-meetings/refresh", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(String(json?.error || "Refresh failed"));
      return json as { usersScanned: number; meetingsReturned: number };
    },
    onSuccess: (r) => {
      toast.success(`Refreshed: ${r.meetingsReturned} meetings`);
      void q.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const calendarQ = useQuery({
    queryKey: ["recall-calendar-status"],
    queryFn: async () => {
      const res = await fetch("/api/recall/calendar/status");
      const json = await res.json();
      if (!res.ok) throw new Error(String(json?.error || "Failed to load calendar status"));
      return json as {
        ok: boolean;
        webhookUrl: string;
        oauthRedirectUri?: string;
        connected: RecallCalendarConnection[];
        disconnected?: Array<{ email: string; recallCalendarId: string }>;
        total: number;
        allowlist?: string[];
        connectDomains?: string[] | "*";
      };
    },
    staleTime: 30_000,
    refetchInterval: (query) => {
      const connected = query.state.data?.connected ?? [];
      const pending = connected.reduce((n, c) => n + (c.pending?.pendingCount ?? 0), 0);
      return pending > 0 ? 20_000 : 60_000;
    },
  });

  const calendarActionM = useMutation({
    mutationFn: async (body: {
      action: string;
      calendarId?: string;
      eventIds?: string[];
      scheduleAll?: boolean;
      maxNewBots?: number;
    }) => {
      const res = await fetch("/api/recall/calendar/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(String(json?.error || "Calendar action failed"));
      return json;
    },
    onSuccess: (json, vars) => {
      if (vars.action === "sync") {
        const s = json.sync as {
          scheduled?: number;
          skipped?: number;
          errors?: string[];
          reason?: string;
          scheduledEventIds?: string[];
        } | undefined;
        const errCount = s?.errors?.length ?? 0;
        if (vars.scheduleAll && vars.calendarId) {
          const done = s?.scheduled ?? 0;
          const scheduledEventIds = s?.scheduledEventIds ?? [];
          if (scheduledEventIds.length) {
            setBulkScheduledByCalendar((prev) => ({
              ...prev,
              [vars.calendarId!]: [
                ...new Set([...(prev[vars.calendarId!] ?? []), ...scheduledEventIds]),
              ],
            }));
          }
          toast.success(
            done > 0
              ? `Sync now — reserved ${done} bot(s). Each joins ~2 min before its meeting (live transcripts when in call).`
              : `No new meetings to schedule${errCount ? ` (${errCount} errors)` : ""}`,
          );
        } else if (vars.eventIds?.length) {
          const n = vars.eventIds.length;
          const done = s?.scheduled ?? 0;
          toast.success(
            done > 0
              ? `Reserved ${done} of ${n} bot(s) — each joins ~2 min before its meeting start`
              : `Not scheduled${errCount ? ` (${errCount} errors)` : ""}`,
          );
        } else {
          toast.success(s?.reason || "Calendar meeting list refreshed");
        }
      } else if (vars.action === "disconnect") toast.success("Calendar disconnected");
      void calendarQ.refetch();
      void q.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const scheduleMeetingM = useMutation({
    mutationFn: async (meetingId: string) => {
      const res = await fetch(
        `/api/analytics/unified-meetings/${encodeURIComponent(meetingId)}/schedule`,
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        throw new Error(String(json?.message || json?.error || "Failed to schedule bot"));
      }
      return json as { ok: boolean; message: string; botId?: string };
    },
    onMutate: (meetingId) => setActingMeetingId(meetingId),
    onSettled: () => setActingMeetingId(null),
    onSuccess: (json) => {
      toast.success(json.message || "Bot scheduled");
      void q.refetch();
      void calendarQ.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const unscheduleMeetingM = useMutation({
    mutationFn: async (meetingId: string) => {
      const res = await fetch(
        `/api/analytics/unified-meetings/${encodeURIComponent(meetingId)}/unschedule`,
        { method: "DELETE" },
      );
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        throw new Error(String(json?.message || json?.error || "Failed to unschedule bot"));
      }
      return json as { ok: boolean; message: string; botId?: string };
    },
    onMutate: (meetingId) => setActingMeetingId(meetingId),
    onSettled: () => setActingMeetingId(null),
    onSuccess: (json) => {
      toast.success(json.message || "Bot unscheduled");
      void q.refetch();
      void calendarQ.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const meetingActionBusy = scheduleMeetingM.isPending || unscheduleMeetingM.isPending;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("calendarConnected") === "1") {
      const n = Number(params.get("scheduled") || 0);
      toast.success(
        n > 0
          ? `Google Calendar connected — Alyson attached to ${n} upcoming meeting${n === 1 ? "" : "s"}`
          : "Google Calendar connected — Alyson will auto-join every meeting with a video link",
      );
      window.history.replaceState({}, "", window.location.pathname);
    }
    const err = params.get("calendarError");
    if (err) {
      toast.error(decodeURIComponent(err));
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const meetings = q.data?.meetings ?? [];
  const stats = useMemo(() => {
    const withLink = meetings.filter((m) => Boolean(m.meetingUrl)).length;
    const pendingBot = meetings.filter(
      (m) =>
        Boolean(m.meetingUrl) &&
        m.status !== "cancelled" &&
        !m.botScheduled &&
        !isMeetingOver(m.startTime, m.endTime),
    ).length;
    return { total: meetings.length, withLink, pendingBot };
  }, [meetings]);

  const autoScheduleRef = useRef<{ at: number; pending: number }>({ at: 0, pending: -1 });
  const [autoScheduling, setAutoScheduling] = useState(false);

  // Keep allowlisted meetings in Scheduled without clicking row Schedule buttons.
  useEffect(() => {
    if (q.isLoading || q.isError) return;
    const pending = stats.pendingBot;
    if (pending <= 0) return;
    const now = Date.now();
    const prev = autoScheduleRef.current;
    if (prev.pending === pending && now - prev.at < 90_000) return;
    if (autoScheduling) return;

    autoScheduleRef.current = { at: now, pending };
    setAutoScheduling(true);
    toast.message(`Auto-scheduling ${pending} pending bot${pending === 1 ? "" : "s"}…`);
    void fetch("/api/analytics/unified-meetings/schedule-bots", { method: "POST" })
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as {
          scheduled?: number;
          errors?: string[];
          error?: string;
        };
        if (!res.ok) throw new Error(String(json.error || "Auto-schedule failed"));
        const n = Number(json.scheduled || 0);
        if (n > 0) toast.success(`Auto-scheduled ${n} bot${n === 1 ? "" : "s"}`);
        else if (json.errors?.length) toast.message(`Auto-schedule: ${json.errors[0]}`);
        void q.refetch();
      })
      .catch((e: Error) => toast.error(e.message || "Auto-schedule failed"))
      .finally(() => setAutoScheduling(false));
  }, [autoScheduling, q.isError, q.isLoading, q.refetch, stats.pendingBot]);

  return (
    <div className="ops-dense">
      <PageHeader
        eyebrow="Operations"
        title="Unified Meetings"
        description="Next 24h for allowlisted calendars — every Meet-link meeting in this list is auto-Scheduled (DWD, no Connect). Schedule is a manual retry only."
        dense
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/alyson-notetaker"
              className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
            >
              <CalendarDays className="h-3.5 w-3.5" />
              Alyson Notetaker
            </Link>
            <button
              type="button"
              disabled={autoScheduling}
              onClick={() => {
                if (autoScheduling) return;
                setAutoScheduling(true);
                toast.message("Auto-scheduling allowlisted meetings…");
                void fetch("/api/analytics/unified-meetings/schedule-bots", { method: "POST" })
                  .then(async (res) => {
                    const json = (await res.json().catch(() => ({}))) as {
                      scheduled?: number;
                      errors?: string[];
                      error?: string;
                    };
                    if (!res.ok) throw new Error(String(json.error || "Auto-schedule failed"));
                    const n = Number(json.scheduled || 0);
                    if (n > 0) toast.success(`Auto-scheduled ${n} bot${n === 1 ? "" : "s"}`);
                    else toast.message(json.errors?.[0] || "No new bots needed");
                    autoScheduleRef.current = { at: Date.now(), pending: stats.pendingBot };
                    void q.refetch();
                  })
                  .catch((e: Error) => toast.error(e.message || "Auto-schedule failed"))
                  .finally(() => setAutoScheduling(false));
              }}
              className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
              title="Force allowlisted auto-schedule for all pending meetings"
            >
              <Bot className="h-3.5 w-3.5" />
              {autoScheduling
                ? "Auto-scheduling…"
                : stats.pendingBot
                  ? `Auto-schedule (${stats.pendingBot})`
                  : "All scheduled"}
            </button>
            <button
              type="button"
              onClick={() => refreshM.mutate()}
              className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
        }
      />

      <div className="app-page-gutter py-6 space-y-4">
        <RecallCalendarPanel
          loading={calendarQ.isLoading}
          error={calendarQ.isError ? (calendarQ.error as Error).message : null}
          webhookUrl={calendarQ.data?.webhookUrl}
          oauthRedirectUri={calendarQ.data?.oauthRedirectUri}
          allowlist={calendarQ.data?.allowlist}
          connectDomains={calendarQ.data?.connectDomains}
          connected={calendarQ.data?.connected ?? []}
          disconnected={calendarQ.data?.disconnected ?? []}
          bulkScheduledByCalendar={bulkScheduledByCalendar}
          onSync={(args) => calendarActionM.mutate({ action: "sync", ...args })}
          onDisconnect={(calendarId) => calendarActionM.mutate({ action: "disconnect", calendarId })}
          busy={calendarActionM.isPending}
        />

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Kpi label="Total meetings next 24h" value={String(stats.total)} />
          <Kpi label="Meetings with Meet links" value={String(stats.withLink)} />
          <Kpi label="Pending bots (auto)" value={String(stats.pendingBot)} />
        </div>

        <div className="surface-card p-4 grid grid-cols-1 md:grid-cols-3 gap-2">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search title/email/url" className="h-8 px-2 rounded border border-border bg-background text-sm" />
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Filter by user email" className="h-8 px-2 rounded border border-border bg-background text-sm" />
          <select value={hasMeetLink} onChange={(e) => setHasMeetLink(e.target.value)} className="h-8 px-2 rounded border border-border bg-background text-sm">
            <option value="">Has Meet Link: any</option>
            <option value="true">Has Meet Link</option>
            <option value="false">No meeting link</option>
          </select>
        </div>

        {q.isLoading && <div className="text-sm text-muted-foreground">Loading unified meetings…</div>}
        {q.isError && <div className="surface-card p-4 text-sm text-destructive">{(q.error as Error).message}</div>}

        {!q.isLoading && !q.isError && (
          <div className="surface-card overflow-hidden">
            <div className="max-h-[72vh] overflow-auto">
              <table className="ops-table w-full min-w-[1100px]">
                <thead className="sticky top-0 z-[1] bg-background">
                  <tr className="shadow-[inset_0_-1px_0_var(--border)]">
                    <th align="left">Start Time</th>
                    <th align="left">End Time</th>
                    <th align="left">Title</th>
                    <th align="left">Calendar User</th>
                    <th align="left">Organizer</th>
                    <th align="left">Meeting Platform</th>
                    <th align="left">Meeting URL</th>
                    <th align="left">Bot</th>
                    <th align="left">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {meetings.map((m) => {
                    const rowBusy = actingMeetingId === m.id && meetingActionBusy;
                    const meetingEnded = isMeetingOver(m.startTime, m.endTime);
                    const canSchedule =
                      Boolean(m.meetingUrl) &&
                      m.status !== "cancelled" &&
                      !m.botScheduled &&
                      !meetingEnded;
                    const canUnschedule = m.botScheduled && !meetingEnded;

                    return (
                      <tr key={m.id} className="hover:bg-muted/30">
                        <td>{fmt(m.startTime)}</td>
                        <td>{fmt(m.endTime)}</td>
                        <td className="max-w-[220px] truncate" title={m.title}>{m.title}</td>
                        <td>{m.calendarUserEmail}</td>
                        <td>{m.organizerEmail || "-"}</td>
                        <td>{m.meetingPlatform}</td>
                        <td className="max-w-[280px]">
                          {m.meetingUrl ? (
                            <a
                              className="text-primary underline truncate block font-mono text-[11px]"
                              href={m.meetingUrl}
                              target="_blank"
                              rel="noreferrer"
                              title={m.meetingUrl}
                            >
                              {m.meetingUrl}
                            </a>
                          ) : (
                            <span className="text-muted-foreground">No meeting link</span>
                          )}
                        </td>
                        <td>
                          <BotStatusBadge meeting={m} />
                        </td>
                        <td>
                          <div className="flex items-center gap-1.5">
                            {canSchedule ? (
                              <button
                                type="button"
                                disabled={rowBusy}
                                onClick={() => scheduleMeetingM.mutate(m.id)}
                                className="h-7 px-2 rounded-md border border-border bg-background text-[10.5px] font-medium inline-flex items-center gap-1"
                                title="Schedule Alyson bot (~2 min before start)"
                              >
                                <CalendarPlus className="h-3 w-3" />
                                {rowBusy ? "…" : "Schedule"}
                              </button>
                            ) : null}
                            {canUnschedule ? (
                              <button
                                type="button"
                                disabled={rowBusy}
                                onClick={() => unscheduleMeetingM.mutate(m.id)}
                                className="h-7 px-2 rounded-md border border-border bg-background text-[10.5px] font-medium inline-flex items-center gap-1 text-destructive"
                                title="Cancel scheduled bot and remove from Recall"
                              >
                                <CalendarX className="h-3 w-3" />
                                {rowBusy ? "…" : "Unschedule"}
                              </button>
                            ) : null}
                            {!canSchedule && !canUnschedule ? (
                              <span className="text-[10.5px] text-muted-foreground">
                                {m.skipReason || (meetingEnded ? "Ended" : "—")}
                              </span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BotStatusBadge({ meeting }: { meeting: UnifiedMeeting }) {
  if (meeting.botScheduled) {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] text-emerald-700 dark:text-emerald-300">
        <Bot className="h-3 w-3" />
        Scheduled
      </span>
    );
  }
  if (meeting.botStatus === "pending" && meeting.shouldBotJoin) {
    return <span className="text-[10.5px] text-amber-700 dark:text-amber-300">Pending</span>;
  }
  if (meeting.botStatus === "failed") {
    return <span className="text-[10.5px] text-destructive">Failed</span>;
  }
  if (!meeting.shouldBotJoin) {
    return <span className="text-[10.5px] text-muted-foreground">N/A</span>;
  }
  return <span className="text-[10.5px] text-muted-foreground">Not scheduled</span>;
}

function fmt(v: string): string {
  if (!v) return "-";
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return v;
  return d.toLocaleString();
}

const MEETING_END_GRACE_MS = 20 * 60 * 1000;

/** True when the meeting window has ended (matches server join rules). */
function isMeetingOver(startTime: string, endTime: string): boolean {
  const now = Date.now();
  const startMs = new Date(startTime).getTime();
  const endMs = endTime ? new Date(endTime).getTime() : NaN;
  const effectiveEnd = Number.isFinite(endMs)
    ? endMs + MEETING_END_GRACE_MS
    : Number.isFinite(startMs)
      ? startMs + 3 * 60 * 60 * 1000
      : NaN;
  return Number.isFinite(effectiveEnd) && now > effectiveEnd;
}

function RecallCalendarPanel({
  loading,
  error,
  webhookUrl,
  oauthRedirectUri,
  allowlist,
  connectDomains,
  connected,
  disconnected,
  bulkScheduledByCalendar,
  onSync,
  onDisconnect,
  busy,
}: {
  loading: boolean;
  error: string | null;
  webhookUrl?: string;
  oauthRedirectUri?: string;
  allowlist?: string[];
  connectDomains?: string[] | "*";
  connected: RecallCalendarConnection[];
  disconnected: Array<{ email: string; recallCalendarId: string }>;
  bulkScheduledByCalendar: Record<string, string[]>;
  onSync: (args: { calendarId: string; eventIds?: string[]; scheduleAll?: boolean; maxNewBots?: number }) => void;
  onDisconnect: (calendarId: string) => void;
  busy: boolean;
}) {
  const active = connected.filter((c) => c.status === "connected");
  const whoCanConnect =
    connectDomains === "*"
      ? "anyone"
      : connectDomains?.length
        ? `anyone with a ${connectDomains.map((d) => `@${d}`).join(" / ")} account`
        : (allowlist ?? []).join(", ") || "allowlisted accounts";

  return (
    <div className="surface-card p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Recall Calendar V2</div>
          <h3 className="font-display text-lg mt-0.5">Connect your calendar — Alyson joins automatically</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            <span className="text-foreground font-medium">{whoCanConnect}</span> can connect a Google
            Calendar. After connecting, Alyson Notetaker is attached to every meeting with a video link
            (new, moved and recurring meetings included) and joins ~2 min before start. Declined meetings
            are skipped. Hosts may still need to admit “Alyson Notetaker” from the Meet waiting room.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/api/recall/calendar/connect"
            search={{ returnTo: "/alyson-notetaker/unified-meetings" }}
            reloadDocument
            className="h-8 px-3 rounded-md border border-border bg-foreground text-background text-[12px] font-medium inline-flex items-center gap-1.5"
          >
            <Link2 className="h-3.5 w-3.5" />
            Connect Google Calendar
          </Link>
        </div>
      </div>

      {webhookUrl && (
        <div className="text-[11px] text-muted-foreground break-all space-y-1">
          <div>
            Webhook URL (Recall dashboard): <span className="text-foreground font-mono">{webhookUrl}</span>
          </div>
          {oauthRedirectUri && (
            <div>
              Google OAuth redirect URI (add in Google Cloud Console):{" "}
              <span className="text-foreground font-mono">{oauthRedirectUri}</span>
            </div>
          )}
        </div>
      )}

      {loading && <div className="text-sm text-muted-foreground">Loading calendar connections…</div>}
      {error && <div className="text-sm text-destructive">{error}</div>}

      {!loading && active.length === 0 && (
        <div className="text-sm text-muted-foreground">No calendar connected yet.</div>
      )}

      {disconnected.map((d) => (
        <div
          key={d.recallCalendarId}
          className="rounded-md border border-destructive/40 px-3 py-2 text-sm flex flex-wrap items-center justify-between gap-2"
        >
          <span>
            <span className="font-medium">{d.email}</span>{" "}
            <span className="text-muted-foreground">
              — Google access expired. Alyson is not joining these meetings until you reconnect.
            </span>
          </span>
          <Link
            to="/api/recall/calendar/connect"
            search={{ returnTo: "/alyson-notetaker/unified-meetings" }}
            reloadDocument
            className="h-7 px-2.5 rounded-md border border-border bg-background text-[11px] font-medium inline-flex items-center gap-1"
          >
            <Link2 className="h-3 w-3" />
            Reconnect
          </Link>
        </div>
      ))}

      {active.map((c) => (
        <RecallCalendarConnectionRow
          key={c.recallCalendarId}
          connection={c}
          bulkScheduledIds={bulkScheduledByCalendar[c.recallCalendarId] ?? []}
          busy={busy}
          onSync={onSync}
          onDisconnect={onDisconnect}
        />
      ))}
    </div>
  );
}

function RecallCalendarConnectionRow({
  connection: c,
  bulkScheduledIds,
  busy,
  onSync,
  onDisconnect,
}: {
  connection: RecallCalendarConnection;
  bulkScheduledIds: string[];
  busy: boolean;
  onSync: (args: { calendarId: string; eventIds?: string[]; scheduleAll?: boolean; maxNewBots?: number }) => void;
  onDisconnect: (calendarId: string) => void;
}) {
  const pending = c.pending;
  const allMeetings = pending?.events ?? [];
  const bulkScheduledSet = useMemo(() => new Set(bulkScheduledIds), [bulkScheduledIds]);
  const meetingRow = (eventId: string) => allMeetings.find((m) => m.eventId === eventId);

  const isScheduled = (eventId: string) => {
    if (bulkScheduledSet.has(eventId)) return true;
    return Boolean(meetingRow(eventId)?.scheduledInApp);
  };

  const pendingCount = allMeetings.filter(
    (e) => !isScheduled(e.eventId) && !isMeetingOver(e.startTime, e.endTime),
  ).length;

  const upcomingCount = allMeetings.length;
  const scheduledInAppCount = allMeetings.filter((e) => e.scheduledInApp).length;
  const serverPending = pending?.pendingCount ?? pendingCount;
  const scheduleGap = Math.max(0, upcomingCount - scheduledInAppCount);
  const needsAutoSync = scheduleGap > 0 || serverPending > 0;

  const syncAttemptRef = useRef<{ at: number; gap: number; calendarId: string }>({
    at: 0,
    gap: 0,
    calendarId: "",
  });

  useEffect(() => {
    if (!RECALL_CALENDAR_AUTO_SYNC || busy || !needsAutoSync) return;

    const now = Date.now();
    const prev = syncAttemptRef.current;
    const gap = Math.max(serverPending, scheduleGap);
    const sameRun =
      prev.calendarId === c.recallCalendarId && prev.gap === gap && now - prev.at < AUTO_SYNC_COOLDOWN_MS;
    if (sameRun) return;

    syncAttemptRef.current = { at: now, gap, calendarId: c.recallCalendarId };
    toast.message(`Auto-syncing ${gap} pending meeting${gap === 1 ? "" : "s"}…`);
    onSync({ calendarId: c.recallCalendarId, scheduleAll: true });
  }, [busy, c.recallCalendarId, needsAutoSync, onSync, scheduleGap, serverPending]);

  return (
    <div className="rounded-md border border-border px-3 py-2 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{c.email}</div>
          <div className="text-[11px] text-muted-foreground font-mono">{c.recallCalendarId}</div>
          {pending && (
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {upcomingCount} upcoming · {scheduledInAppCount} scheduled in app · {serverPending} pending
              {needsAutoSync && RECALL_CALENDAR_AUTO_SYNC ? (
                <span className="text-foreground">
                  {busy ? " — syncing…" : " — syncs automatically (calendar webhooks + 5-min heartbeat)"}
                </span>
              ) : null}
            </div>
          )}
          {c.lastSyncSummary && (
            <div className="text-[11px] text-muted-foreground mt-0.5">
              Last sync run: {c.lastSyncSummary.scheduled} reserved · {c.lastSyncSummary.skipped} skipped
              {c.lastSyncSummary.errors ? ` · ${c.lastSyncSummary.errors} errors` : ""}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onSync({ calendarId: c.recallCalendarId, scheduleAll: true })}
            className="h-7 px-2.5 rounded-md border border-border bg-background text-[11px] font-medium inline-flex items-center gap-1"
            title="Reserve bots for all pending upcoming meetings (~2 min before each start)"
          >
            <RefreshCw className="h-3 w-3" />
            Sync now
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDisconnect(c.recallCalendarId)}
            className="h-7 px-2.5 rounded-md border border-border bg-background text-[11px] font-medium inline-flex items-center gap-1 text-destructive"
          >
            <Unplug className="h-3 w-3" />
            Disconnect
          </button>
        </div>
      </div>
      {pending?.transcriptWebhookUrl ? (
        <div className="text-[10px] text-muted-foreground break-all">
          Transcript webhooks → <span className="font-mono text-foreground">{pending.transcriptWebhookUrl}</span>
        </div>
      ) : null}
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

