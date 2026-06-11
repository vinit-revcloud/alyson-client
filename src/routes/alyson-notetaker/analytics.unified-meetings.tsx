import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarClock, CalendarDays, ChevronDown, Link2, RefreshCw, Unplug } from "lucide-react";
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
        total: number;
        allowlist?: string[];
      };
    },
    staleTime: 30_000,
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("calendarConnected") === "1") {
      toast.success(`Google Calendar connected — ${params.get("scheduled") || 0} bots scheduled`);
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
    return { total: meetings.length, withLink };
  }, [meetings]);

  return (
    <div className="ops-dense">
      <PageHeader
        eyebrow="Operations"
        title="Unified Meetings"
        description="View workspace meetings below. Use Smart schedule (pick meetings) or Sync now (all pending) on your connected calendar."
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
              onClick={() => refreshM.mutate()}
              className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
        }
      />

      <div className="px-5 md:px-8 py-6 space-y-4">
        <RecallCalendarPanel
          loading={calendarQ.isLoading}
          error={calendarQ.isError ? (calendarQ.error as Error).message : null}
          webhookUrl={calendarQ.data?.webhookUrl}
          oauthRedirectUri={calendarQ.data?.oauthRedirectUri}
          allowlist={calendarQ.data?.allowlist}
          connected={calendarQ.data?.connected ?? []}
          bulkScheduledByCalendar={bulkScheduledByCalendar}
          onSync={(args) => calendarActionM.mutate({ action: "sync", ...args })}
          onScheduleSelected={async (calendarId, eventIds) => {
            const json = await calendarActionM.mutateAsync({
              action: "sync",
              calendarId,
              eventIds,
            });
            const sync = json.sync as { scheduled?: number; scheduledEventIds?: string[] } | undefined;
            return {
              scheduledCount: sync?.scheduled ?? 0,
              scheduledEventIds: sync?.scheduledEventIds ?? [],
            };
          }}
          onDisconnect={(calendarId) => calendarActionM.mutate({ action: "disconnect", calendarId })}
          busy={calendarActionM.isPending}
        />

        <div className="grid grid-cols-2 gap-3">
          <Kpi label="Total meetings next 24h" value={String(stats.total)} />
          <Kpi label="Meetings with Meet links" value={String(stats.withLink)} />
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
              <table className="ops-table w-full min-w-[900px]">
                <thead className="sticky top-0 z-[1] bg-background">
                  <tr className="shadow-[inset_0_-1px_0_var(--border)]">
                    <th align="left">Start Time</th>
                    <th align="left">End Time</th>
                    <th align="left">Title</th>
                    <th align="left">Calendar User</th>
                    <th align="left">Organizer</th>
                    <th align="left">Meeting Platform</th>
                    <th align="left">Meeting URL</th>
                  </tr>
                </thead>
                <tbody>
                  {meetings.map((m) => (
                      <tr key={m.id} className="hover:bg-muted/30">
                        <td>{fmt(m.startTime)}</td>
                        <td>{fmt(m.endTime)}</td>
                        <td className="max-w-[220px] truncate" title={m.title}>{m.title}</td>
                        <td>{m.calendarUserEmail}</td>
                        <td>{m.organizerEmail || "-"}</td>
                        <td>{m.meetingPlatform}</td>
                        <td>
                          {m.meetingUrl ? (
                            <a className="text-primary underline" href={m.meetingUrl} target="_blank" rel="noreferrer">Open Meet</a>
                          ) : (
                            <span className="text-muted-foreground">No meeting link</span>
                          )}
                        </td>
                      </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
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
  connected,
  bulkScheduledByCalendar,
  onSync,
  onScheduleSelected,
  onDisconnect,
  busy,
}: {
  loading: boolean;
  error: string | null;
  webhookUrl?: string;
  oauthRedirectUri?: string;
  allowlist?: string[];
  connected: RecallCalendarConnection[];
  bulkScheduledByCalendar: Record<string, string[]>;
  onSync: (args: { calendarId: string; eventIds?: string[]; scheduleAll?: boolean; maxNewBots?: number }) => void;
  onScheduleSelected: (
    calendarId: string,
    eventIds: string[],
  ) => Promise<{ scheduledCount: number; scheduledEventIds: string[] }>;
  onDisconnect: (calendarId: string) => void;
  busy: boolean;
}) {
  const active = connected.filter((c) => c.status === "connected");
  const allowedEmails =
    allowlist?.length ? allowlist : ["alysonclient@cintara.ai", "mohita@cintara.ai", "thirumalai@cintara.ai"];

  return (
    <div className="surface-card p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Recall Calendar V2</div>
          <h3 className="font-display text-lg mt-0.5">Auto-join via calendar webhooks</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Connect Google Calendar once for{" "}
            <span className="text-foreground font-medium">{allowedEmails.join(", ")}</span>. Use{" "}
            <span className="text-foreground font-medium">Smart schedule</span> picks specific meetings;{" "}
            <span className="text-foreground font-medium">Sync now</span> reserves bots for all pending upcoming
            meetings. Each bot joins ~2 min before start.
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

      {active.map((c) => (
        <RecallCalendarConnectionRow
          key={c.recallCalendarId}
          connection={c}
          bulkScheduledIds={bulkScheduledByCalendar[c.recallCalendarId] ?? []}
          busy={busy}
          onSync={onSync}
          onScheduleSelected={onScheduleSelected}
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
  onScheduleSelected,
  onDisconnect,
}: {
  connection: RecallCalendarConnection;
  bulkScheduledIds: string[];
  busy: boolean;
  onSync: (args: { calendarId: string; eventIds?: string[]; scheduleAll?: boolean; maxNewBots?: number }) => void;
  onScheduleSelected: (
    calendarId: string,
    eventIds: string[],
  ) => Promise<{ scheduledCount: number; scheduledEventIds: string[] }>;
  onDisconnect: (calendarId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [userScheduledIds, setUserScheduledIds] = useState<Set<string>>(() => new Set());
  const [scheduling, setScheduling] = useState(false);
  const pending = c.pending;
  const allMeetings = pending?.events ?? [];
  const bulkScheduledSet = useMemo(() => new Set(bulkScheduledIds), [bulkScheduledIds]);
  const meetingRow = (eventId: string) => allMeetings.find((m) => m.eventId === eventId);

  /** Persisted in S3 (recall calendar event id) or just scheduled this session. */
  const isScheduled = (eventId: string) => {
    if (userScheduledIds.has(eventId) || bulkScheduledSet.has(eventId)) return true;
    return Boolean(meetingRow(eventId)?.scheduledInApp);
  };

  const pendingCount = allMeetings.filter(
    (e) => !isScheduled(e.eventId) && !isMeetingOver(e.startTime, e.endTime),
  ).length;

  const closeMenu = () => {
    setMenuOpen(false);
    setSelectedIds(new Set());
  };

  const toggleSelect = (eventId: string) => {
    const row = meetingRow(eventId);
    if (isScheduled(eventId)) return;
    if (row && isMeetingOver(row.startTime, row.endTime)) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  const scheduleSelected = async () => {
    const ids = [...selectedIds];
    if (!ids.length || scheduling) return;
    setScheduling(true);
    try {
      const { scheduledEventIds } = await onScheduleSelected(c.recallCalendarId, ids);
      if (scheduledEventIds.length) {
        setUserScheduledIds((prev) => {
          const next = new Set(prev);
          for (const id of scheduledEventIds) next.add(id);
          return next;
        });
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const id of scheduledEventIds) next.delete(id);
          return next;
        });
      }
    } finally {
      setScheduling(false);
    }
  };

  return (
    <div className="rounded-md border border-border px-3 py-2 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{c.email}</div>
          <div className="text-[11px] text-muted-foreground font-mono">{c.recallCalendarId}</div>
          {pending && (
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {allMeetings.length} upcoming · {pendingCount} pending in Smart schedule
            </div>
          )}
          {c.lastSyncSummary && (
            <div className="text-[11px] text-muted-foreground mt-0.5">
              Last sync: {c.lastSyncSummary.scheduled} scheduled · {c.lastSyncSummary.skipped} skipped
              {c.lastSyncSummary.errors ? ` · ${c.lastSyncSummary.errors} errors` : ""}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              type="button"
              disabled={busy}
              onClick={() => setMenuOpen((v) => !v)}
              className="h-7 px-2.5 rounded-md border border-primary/40 bg-primary/10 text-[11px] font-medium inline-flex items-center gap-1 disabled:opacity-50"
              title="Check meetings, then Schedule selected"
            >
              <CalendarClock className="h-3 w-3" />
              Smart schedule
              {pendingCount > 0 ? (
                <span className="min-w-[1.25rem] h-4 px-1 rounded bg-amber-500/20 text-amber-800 dark:text-amber-200 text-[10px] inline-flex items-center justify-center">
                  {pendingCount}
                </span>
              ) : null}
              <ChevronDown className="h-3 w-3" />
            </button>
            {menuOpen && (
              <>
                <button
                  type="button"
                  className="fixed inset-0 z-10 cursor-default"
                  aria-label="Close smart schedule menu"
                  onClick={closeMenu}
                />
                <div className="absolute right-0 top-full mt-1 z-20 w-[min(100vw-2rem,380px)] rounded-md border border-border bg-background shadow-lg text-[11px] flex flex-col max-h-[min(70vh,420px)]">
                  <div className="px-3 py-2 border-b border-border shrink-0">
                    <div className="font-medium text-[12px]">Smart schedule</div>
                    <p className="text-muted-foreground leading-relaxed mt-1">
                      Check pending meetings, then Schedule selected. Scheduled status is saved in S3 with join time
                      (~2 min before start).
                    </p>
                  </div>

                  <div className="overflow-y-auto flex-1 py-1">
                    {allMeetings.length === 0 ? (
                      <div className="px-3 py-4 text-muted-foreground">
                        No upcoming meetings. Click Sync now to refresh the list from Google Calendar.
                      </div>
                    ) : (
                      allMeetings.map((e) => {
                        const scheduled = isScheduled(e.eventId);
                        const isSelected = selectedIds.has(e.eventId);
                        const meetingOver = isMeetingOver(e.startTime, e.endTime);
                        const rowDisabled = scheduled || meetingOver || busy || scheduling;
                        return (
                          <label
                            key={e.eventId}
                            className={`flex items-start gap-2 px-3 py-2 hover:bg-muted/40 ${rowDisabled && !isSelected ? "opacity-60" : "cursor-pointer"}`}
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5 shrink-0"
                              checked={isSelected}
                              disabled={rowDisabled}
                              onChange={() => toggleSelect(e.eventId)}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-medium truncate">{e.title}</span>
                                {scheduled ? (
                                  <span className="shrink-0 px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-[10px]">
                                    Scheduled
                                  </span>
                                ) : meetingOver ? (
                                  <span className="shrink-0 px-1.5 py-0.5 rounded bg-red-500/10 text-red-700 dark:text-red-300 text-[10px]">
                                    Meeting over
                                  </span>
                                ) : (
                                  <span className="shrink-0 px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[10px]">
                                    Pending
                                  </span>
                                )}
                              </div>
                              <div className="text-muted-foreground mt-0.5">Starts {fmt(e.startTime)}</div>
                              {scheduled && e.botJoinAt ? (
                                <div className="text-[10px] text-emerald-700/80 dark:text-emerald-300/80 mt-0.5">
                                  Bot joins {fmt(e.botJoinAt)}
                                </div>
                              ) : null}
                              {meetingOver && !scheduled ? (
                                <div className="text-[10px] text-red-600/80 dark:text-red-400/80 mt-0.5">
                                  Past meeting time — cannot schedule
                                </div>
                              ) : null}
                            </div>
                          </label>
                        );
                      })
                    )}
                  </div>

                  <div className="px-3 py-2 border-t border-border shrink-0">
                    <button
                      type="button"
                      disabled={selectedIds.size === 0 || busy || scheduling}
                      className="w-full h-7 rounded-md bg-foreground text-background text-[11px] font-medium disabled:opacity-40"
                      onClick={() => void scheduleSelected()}
                    >
                      {scheduling
                        ? "Scheduling…"
                        : `Schedule selected (${selectedIds.size} meeting${selectedIds.size === 1 ? "" : "s"})`}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
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

