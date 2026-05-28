import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarDays, RefreshCw, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { toast } from "sonner";

type BotStatus = "not_required" | "pending" | "scheduled" | "failed";
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
  botStatus: BotStatus;
  skipReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export const Route = createFileRoute("/alyson-notetaker/analytics/unified-meetings")({
  head: () => ({ meta: [{ title: "Unified Meetings — Alyson Notetaker" }] }),
  component: UnifiedMeetingsPage,
});

export function UnifiedMeetingsPage() {
  const [search, setSearch] = useState("");
  const [email, setEmail] = useState("");
  const [botStatus, setBotStatus] = useState("");
  const [hasMeetLink, setHasMeetLink] = useState("");
  const [shouldBotJoin, setShouldBotJoin] = useState("");

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (search.trim()) p.set("search", search.trim());
    if (email.trim()) p.set("email", email.trim());
    if (botStatus) p.set("botStatus", botStatus);
    if (hasMeetLink) p.set("hasMeetLink", hasMeetLink);
    if (shouldBotJoin) p.set("shouldBotJoin", shouldBotJoin);
    return p.toString();
  }, [search, email, botStatus, hasMeetLink, shouldBotJoin]);

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

  const scheduleAllM = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/analytics/unified-meetings/schedule-bots", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(String(json?.error || "Schedule failed"));
      return json as { checked: number; scheduled: number; skipped: number; errors: string[] };
    },
    onSuccess: (r) => {
      void q.refetch();
      if ((r.errors?.length ?? 0) > 0) {
        toast.warning(`${r.errors!.length} meeting(s) failed to schedule`, {
          description: `${r.scheduled} scheduled · ${r.skipped} skipped`,
        });
      }
    },
  });

  function scheduleEligibleBots() {
    toast.promise(scheduleAllM.mutateAsync(), {
      loading: "Scheduling eligible bots…",
      success: (r) => ({
        message: "Eligible bots scheduled",
        description: `${r.scheduled} scheduled · ${r.skipped} skipped · ${r.checked} checked`,
      }),
      error: (e) => (e instanceof Error ? e.message : "Failed to schedule bots"),
    });
  }

  const scheduleOneM = useMutation({
    mutationFn: async (meetingId: string) => {
      const res = await fetch(`/api/analytics/unified-meetings/${encodeURIComponent(meetingId)}/schedule`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(String(json?.message || json?.error || "Manual schedule failed"));
      return json as { ok: boolean; message: string };
    },
    onSuccess: (r) => {
      toast.success(r.message);
      void q.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const meetings = q.data?.meetings ?? [];
  const stats = useMemo(() => {
    const withLink = meetings.filter((m) => Boolean(m.meetingUrl)).length;
    const scheduled = meetings.filter((m) => m.botStatus === "scheduled").length;
    const skipped = meetings.filter((m) => m.botStatus === "not_required").length;
    const failed = meetings.filter((m) => m.botStatus === "failed").length;
    return { total: meetings.length, withLink, scheduled, skipped, failed };
  }, [meetings]);

  return (
    <div className="ops-dense">
      <PageHeader
        eyebrow="Operations"
        title="Unified Meetings"
        description="Upcoming company meetings in the next 24 hours"
        dense
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/alyson-notetaker"
              className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
            >
              <CalendarDays className="h-3.5 w-3.5" />
              Notetaker
            </Link>
            <button
              type="button"
              onClick={() => refreshM.mutate()}
              className="h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium inline-flex items-center gap-1.5"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
            <button
              type="button"
              disabled={scheduleAllM.isPending}
              onClick={scheduleEligibleBots}
              className="h-7 px-2.5 rounded-md bg-foreground text-background text-[11.5px] font-medium inline-flex items-center gap-1.5 disabled:opacity-60"
            >
              {scheduleAllM.isPending ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {scheduleAllM.isPending ? "Scheduling…" : "Schedule eligible bots"}
            </button>
          </div>
        }
      />

      <div className="px-5 md:px-8 py-6 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Kpi label="Total meetings next 24h" value={String(stats.total)} />
          <Kpi label="Meetings with Meet links" value={String(stats.withLink)} />
          <Kpi label="Alyson scheduled" value={String(stats.scheduled)} />
          <Kpi label="Skipped" value={String(stats.skipped)} />
          <Kpi label="Failed" value={String(stats.failed)} />
        </div>

        <div className="surface-card p-4 grid grid-cols-1 md:grid-cols-5 gap-2">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search title/email/url" className="h-8 px-2 rounded border border-border bg-background text-sm" />
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Filter by user email" className="h-8 px-2 rounded border border-border bg-background text-sm" />
          <select value={botStatus} onChange={(e) => setBotStatus(e.target.value)} className="h-8 px-2 rounded border border-border bg-background text-sm">
            <option value="">All bot statuses</option>
            <option value="scheduled">scheduled</option>
            <option value="pending">pending</option>
            <option value="failed">failed</option>
            <option value="not_required">not_required</option>
          </select>
          <select value={hasMeetLink} onChange={(e) => setHasMeetLink(e.target.value)} className="h-8 px-2 rounded border border-border bg-background text-sm">
            <option value="">Has Meet Link: any</option>
            <option value="true">Has Meet Link</option>
            <option value="false">No meeting link</option>
          </select>
          <select value={shouldBotJoin} onChange={(e) => setShouldBotJoin(e.target.value)} className="h-8 px-2 rounded border border-border bg-background text-sm">
            <option value="">Bot required: any</option>
            <option value="true">Bot Required</option>
            <option value="false">Bot Not Required</option>
          </select>
        </div>

        {q.isLoading && <div className="text-sm text-muted-foreground">Loading unified meetings…</div>}
        {q.isError && <div className="surface-card p-4 text-sm text-destructive">{(q.error as Error).message}</div>}

        {!q.isLoading && !q.isError && (
          <div className="surface-card overflow-hidden">
            <div className="max-h-[72vh] overflow-auto">
              <table className="ops-table w-full min-w-[1300px]">
                <thead className="sticky top-0 z-[1] bg-background">
                  <tr className="shadow-[inset_0_-1px_0_var(--border)]">
                    <th align="left">Start Time</th>
                    <th align="left">End Time</th>
                    <th align="left">Title</th>
                    <th align="left">Calendar User</th>
                    <th align="left">Organizer</th>
                    <th align="left">Meeting Platform</th>
                    <th align="left">Meeting URL</th>
                    <th align="left">Bot Required</th>
                    <th align="left">Bot Status</th>
                    <th align="left">Bot ID</th>
                    <th align="left">Bot Join Time</th>
                    <th align="left">Skip Reason</th>
                    <th align="left">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {meetings.map((m) => {
                    const startMs = new Date(m.startTime).getTime();
                    const canSchedule = Boolean(m.meetingUrl) && Number.isFinite(startMs) && startMs > Date.now();
                    return (
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
                        <td>{m.shouldBotJoin ? "Yes" : "No"}</td>
                        <td><BotBadge status={m.botStatus} /></td>
                        <td className="max-w-[220px]">
                          {m.recallBotId ? (
                            <button
                              type="button"
                              onClick={async () => {
                                await navigator.clipboard.writeText(String(m.recallBotId));
                                toast.success("Bot ID copied");
                              }}
                              className="font-mono text-[11px] underline text-primary truncate max-w-[200px] inline-block"
                              title={`Copy bot id: ${m.recallBotId}`}
                            >
                              {m.recallBotId}
                            </button>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </td>
                        <td>{m.botJoinAt ? fmt(m.botJoinAt) : "-"}</td>
                        <td className="max-w-[260px] truncate" title={m.skipReason || ""}>{m.skipReason || "-"}</td>
                        <td>
                          <button
                            type="button"
                            disabled={!canSchedule || scheduleOneM.isPending}
                            onClick={() => scheduleOneM.mutate(m.id)}
                            className="h-7 px-2 rounded-md border border-border text-[11px] hover:bg-muted disabled:opacity-50"
                          >
                            Schedule Alyson
                          </button>
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

function fmt(v: string): string {
  if (!v) return "-";
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return v;
  return d.toLocaleString();
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-display text-xl mt-1">{value}</div>
    </div>
  );
}

function BotBadge({ status }: { status: BotStatus }) {
  const cls =
    status === "scheduled"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : status === "pending"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : status === "failed"
          ? "bg-red-500/15 text-red-700 dark:text-red-300"
          : "bg-muted text-muted-foreground";
  return <span className={`px-2 py-0.5 rounded text-[11px] ${cls}`}>{status}</span>;
}
