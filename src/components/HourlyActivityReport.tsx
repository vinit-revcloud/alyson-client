import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, Loader2, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, TableScroll } from "@/components/AppShell";
import { TableSkeleton } from "@/components/Skeleton";
import { downloadCSV } from "@/lib/csv";
import { getHourlyActivityReport } from "@/lib/hourly-activity-functions";
import {
  hourlySnapshotKey,
  loadHourlyActivitySession,
  readHourlyActivitySnapshot,
  saveHourlyActivitySession,
  type HourlyActivityStoredState,
} from "@/lib/hourly-activity-session";

const PRESET_HOURS = [24, 48, 72] as const;
const MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

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
    hour12: false,
  }).format(d);
}

function looksLikeEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function draftToApplied(draftStart: string, draftEnd: string, email: string) {
  const s = new Date(draftStart);
  const e = new Date(draftEnd);
  return { start: s.toISOString(), end: e.toISOString(), userEmail: email.trim().toLowerCase() };
}

function rangesMatch(
  a: { start: string; end: string; userEmail: string } | null,
  b: { start: string; end: string; userEmail: string } | null,
) {
  if (!a || !b) return false;
  return a.start === b.start && a.end === b.end && a.userEmail === b.userEmail;
}

export type HourlyActivityReportProps = {
  compact?: boolean;
  syncRange?: { start: string; end: string } | null;
  selectedEmail?: string | null;
  employeeOptions?: Array<{ email: string; label: string }>;
};

export function HourlyActivityReport({
  compact,
  syncRange,
  selectedEmail,
  employeeOptions,
}: HourlyActivityReportProps) {
  const now = useMemo(() => new Date(), []);
  const boot = useMemo(() => loadHourlyActivitySession(), []);

  const [draftEnd, setDraftEnd] = useState(() => boot?.draftEnd ?? isoForInput(now));
  const [draftStart, setDraftStart] = useState(
    () => boot?.draftStart ?? isoForInput(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
  );
  const [search, setSearch] = useState(() => boot?.search ?? "");
  const [applied, setApplied] = useState<HourlyActivityStoredState["applied"]>(() => boot?.applied ?? null);

  useEffect(() => {
    if (syncRange?.start && syncRange?.end) {
      setDraftStart(isoForInput(new Date(syncRange.start)));
      setDraftEnd(isoForInput(new Date(syncRange.end)));
    }
  }, [syncRange?.start, syncRange?.end]);

  useEffect(() => {
    if (selectedEmail?.trim()) setSearch(selectedEmail.trim());
  }, [selectedEmail]);

  const persisted = useMemo(() => {
    const snapshot = readHourlyActivitySnapshot(applied);
    if (!snapshot || !applied) return null;
    const stored = loadHourlyActivitySession();
    return { snapshot, at: stored?.snapshotAt ?? Date.now() };
  }, [applied]);

  const q = useQuery({
    queryKey: ["hourly-activity", applied?.start, applied?.end, applied?.userEmail],
    queryFn: () =>
      getHourlyActivityReport({
        data: {
          start: applied!.start,
          end: applied!.end,
          userEmail: applied!.userEmail,
        },
      }),
    enabled: applied !== null && looksLikeEmail(applied.userEmail),
    initialData: persisted?.snapshot,
    initialDataUpdatedAt: persisted?.at,
    placeholderData: keepPreviousData,
    staleTime: 120_000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const draftRange = useMemo(() => {
    const email = search.trim().toLowerCase();
    if (!looksLikeEmail(email) || !draftStart || !draftEnd) return null;
    try {
      return draftToApplied(draftStart, draftEnd, email);
    } catch {
      return null;
    }
  }, [search, draftStart, draftEnd]);

  const draftMatchesApplied = rangesMatch(draftRange, applied);
  const isBusy = q.isFetching;
  const showingStaleWindow = q.isPlaceholderData && isBusy;
  const coldLoad = q.isPending && !q.data;
  const rangeTooLong =
    draftRange != null && new Date(draftRange.end).getTime() - new Date(draftRange.start).getTime() > MAX_RANGE_MS;

  const filteredRows = useMemo(() => {
    const rows = q.data?.rows ?? [];
    const s = search.trim().toLowerCase();
    if (!s || looksLikeEmail(s)) return rows;
    return rows.filter((r) => {
      const label = `${q.data?.displayName ?? ""} ${q.data?.userEmail ?? ""}`.toLowerCase();
      return label.includes(s);
    });
  }, [q.data, search]);

  const lastToastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!q.isSuccess || q.isPlaceholderData || !q.data || !applied) return;
    const key = hourlySnapshotKey(applied);
    if (lastToastKey.current === key) return;
    if (lastToastKey.current !== null) {
      toast.success("Hourly report updated");
    }
    lastToastKey.current = key;
  }, [q.isSuccess, q.isPlaceholderData, q.data, applied]);

  const apply = () => {
    const email = search.trim().toLowerCase();
    if (!looksLikeEmail(email)) {
      toast.error("Enter a full employee email (e.g. name@company.com)");
      return;
    }
    if (!draftStart || !draftEnd) return toast.error("Select start and end datetime");
    const s = new Date(draftStart);
    const e = new Date(draftEnd);
    if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) {
      return toast.error("Invalid datetime range");
    }
    if (s.getTime() >= e.getTime()) return toast.error("Start must be before end");
    if (e.getTime() - s.getTime() > MAX_RANGE_MS) {
      toast.error("Hourly report supports up to 7 days — use a shorter range or a preset");
      return;
    }
    const next = draftToApplied(draftStart, draftEnd, email);
    if (rangesMatch(next, applied)) {
      void q.refetch();
      return;
    }
    setApplied(next);
  };

  const applyPresetHours = (hours: (typeof PRESET_HOURS)[number]) => {
    const email = search.trim().toLowerCase();
    if (!looksLikeEmail(email)) {
      toast.error("Enter employee email in search first");
      return;
    }
    const end = new Date();
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
    setDraftStart(isoForInput(start));
    setDraftEnd(isoForInput(end));
    setApplied({ start: start.toISOString(), end: end.toISOString(), userEmail: email });
  };

  const exportCsv = () => {
    if (!filteredRows.length || showingStaleWindow) {
      toast.error("Wait for the hourly report to finish loading");
      return;
    }
    const email = q.data?.userEmail ?? "user";
    downloadCSV(
      `hourly-activity-${email.split("@")[0]}.csv`,
      filteredRows.map((r) => ({
        day: r.day,
        hour: r.hour,
        time_doctor_minutes: r.timeDoctorMinutes,
        active_minutes: r.activeMinutes,
        inactive_minutes: r.inactiveMinutes,
        meetings_attended: r.meetingsAttended,
        chat_messages: r.chatMessages,
        emails: r.emails,
        docs_created: r.docsCreated,
        words_typed_or_spoken: r.wordsTypedOrSpoken,
        working: r.working,
        hours_credit: r.hoursCredit,
      })),
      [
        "day",
        "hour",
        "time_doctor_minutes",
        "active_minutes",
        "inactive_minutes",
        "meetings_attended",
        "chat_messages",
        "emails",
        "docs_created",
        "words_typed_or_spoken",
        "working",
        "hours_credit",
      ],
    );
    toast.success("Hourly report exported");
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!q.isSuccess || q.isPlaceholderData || !q.data || !applied) {
      saveHourlyActivitySession({
        version: 2,
        draftStart,
        draftEnd,
        search,
        applied,
      });
      return;
    }
    saveHourlyActivitySession({
      version: 2,
      draftStart,
      draftEnd,
      search,
      applied,
      snapshot: q.data,
      snapshotKey: hourlySnapshotKey(applied),
      snapshotAt: Date.now(),
    });
  }, [draftStart, draftEnd, search, applied, q.data, q.isSuccess, q.isPlaceholderData]);

  useEffect(() => {
    if (!compact || !selectedEmail?.trim() || !syncRange?.start || !syncRange?.end) return;
    const email = selectedEmail.trim().toLowerCase();
    if (!looksLikeEmail(email)) return;
    const span = new Date(syncRange.end).getTime() - new Date(syncRange.start).getTime();
    if (span > MAX_RANGE_MS) return;
    const next = { start: syncRange.start, end: syncRange.end, userEmail: email };
    if (rangesMatch(next, applied)) return;
    setApplied(next);
  }, [compact, selectedEmail, syncRange?.start, syncRange?.end, applied]);

  const statusBanner = (() => {
    if (coldLoad) {
      return {
        tone: "loading" as const,
        text: "Building hourly breakdown from Time Doctor and Google Workspace — this can take a minute.",
      };
    }
    if (showingStaleWindow) {
      return {
        tone: "loading" as const,
        text: "Updating hourly data for the new employee or window — previous rows stay visible until ready.",
      };
    }
    if (isBusy) {
      return { tone: "loading" as const, text: "Refreshing hourly report…" };
    }
    if (q.isError) {
      return {
        tone: "error" as const,
        text: q.error instanceof Error ? q.error.message : "Failed to load hourly report",
      };
    }
    return null;
  })();

  return (
    <div className={compact ? "space-y-4" : "space-y-5"}>
      <div
        className={`surface-card p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end transition-opacity ${isBusy ? "opacity-90" : ""}`}
      >
        <label className="space-y-1 md:col-span-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Search employee (email)
          </span>
          <div className="flex flex-col sm:flex-row gap-2">
            {employeeOptions && employeeOptions.length > 0 ? (
              <select
                value={looksLikeEmail(search) ? search.trim().toLowerCase() : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) setSearch(v);
                }}
                disabled={isBusy}
                className="h-8 px-2 rounded-md border border-border bg-background text-[12px] max-w-full sm:max-w-[220px] disabled:opacity-60"
              >
                <option value="">Pick from list…</option>
                {employeeOptions.map((o) => (
                  <option key={o.email} value={o.email}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : null}
            <div className="relative flex-1">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="thirumalai@cintara.ai"
                disabled={isBusy}
                className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-background text-[13px] disabled:opacity-60"
              />
            </div>
          </div>
        </label>
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
          disabled={isBusy || rangeTooLong}
          className="h-8 px-4 rounded-md bg-foreground text-background text-xs font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-70 min-w-[10.5rem]"
        >
          {isBusy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Computing…
            </>
          ) : draftMatchesApplied ? (
            "Reload report"
          ) : (
            "Load hourly report"
          )}
        </button>
        <div className="md:col-span-4 flex flex-wrap gap-1.5 items-center">
          {PRESET_HOURS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => applyPresetHours(h)}
              disabled={isBusy}
              className="h-7 px-3 rounded-full text-[11px] font-medium border border-border bg-paper text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              Last {h}h
            </button>
          ))}
          <button
            type="button"
            onClick={() => q.refetch()}
            disabled={!applied || isBusy}
            className="h-7 px-3 rounded-full text-[11px] font-medium border border-border inline-flex items-center gap-1 hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${isBusy ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!filteredRows.length || showingStaleWindow}
            className="h-7 px-3 rounded-full text-[11px] font-medium border border-border inline-flex items-center gap-1 hover:bg-muted disabled:opacity-50"
          >
            <Download className="h-3 w-3" />
            Export CSV
          </button>
        </div>
        <div className="md:col-span-4 text-[11px] text-muted-foreground">
          {compact
            ? "Click a row above to auto-load, or pick an employee and apply. Table stays visible while new data loads."
            : "IST hour buckets · max 7 days per load."}
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

      {rangeTooLong ? (
        <div className="text-[11px] text-amber-800 dark:text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
          Selected range is longer than 7 days — use Last 24h / 48h / 72h or narrow Start/End before loading.
        </div>
      ) : null}

      {applied && q.data && !coldLoad ? (
        <div className="surface-card p-3 text-[12px] text-muted-foreground">
          {showingStaleWindow ? (
            <span className="text-foreground font-medium">Pending: </span>
          ) : null}
          <span className="font-medium text-foreground">{q.data.displayName}</span> ({q.data.userEmail}) · Window
          (IST): {fmtIso(applied.start)} → {fmtIso(applied.end)} · Rows: {filteredRows.length}
          {persisted && !isBusy && !showingStaleWindow ? " · Restored from session" : ""}
        </div>
      ) : !coldLoad ? (
        <div className="surface-card p-3 text-[12px] text-muted-foreground">
          Enter an employee email and time range (≤ 7 days), then load the hourly breakdown.
        </div>
      ) : null}

      {q.data?.warnings?.length && !showingStaleWindow ? (
        <div className="surface-card p-3 text-[11px] text-muted-foreground space-y-1">
          {q.data.warnings.slice(0, 6).map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      ) : null}

      {coldLoad ? <TableSkeleton rows={8} /> : null}

      {!coldLoad && applied && !q.isError && filteredRows.length === 0 && !isBusy ? (
        <EmptyState
          icon={Search}
          title="No hourly rows"
          description="No activity in this window for this employee. Try a wider range (up to 7 days) or another person."
        />
      ) : null}

      {!coldLoad && !!filteredRows.length ? (
        <div className="relative min-h-[10rem]">
          {showingStaleWindow ? (
            <div
              className="absolute inset-0 z-10 rounded-lg bg-background/55 backdrop-blur-[1px] pointer-events-none flex items-start justify-center pt-8"
              aria-hidden
            >
              <span className="text-[12px] text-muted-foreground bg-paper border border-border px-3 py-1.5 rounded-full shadow-sm">
                Updating hourly rows…
              </span>
            </div>
          ) : null}
          <div className={showingStaleWindow ? "opacity-60 pointer-events-none select-none transition-opacity" : ""}>
            <TableScroll>
              <table className="ops-table w-full min-w-[1100px]">
                <thead>
                  <tr>
                    <th align="left">Day</th>
                    <th align="right">Hour (IST)</th>
                    <th align="right">Time Doctor (min)</th>
                    <th align="right">Active (min)</th>
                    <th align="right">Inactive (min)</th>
                    <th align="right">Meetings</th>
                    <th align="right">Chat</th>
                    <th align="right">Emails</th>
                    <th align="right">Docs</th>
                    <th align="right">Words*</th>
                    <th align="center">Working</th>
                    <th align="right">Hours credit</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((r) => (
                    <tr
                      key={`${r.day}-${r.hour}`}
                      className={r.working === "Yes" ? "" : "opacity-75"}
                    >
                      <td className="font-mono text-[12px]">{r.day}</td>
                      <td align="right" className="font-mono">
                        {r.hour}
                      </td>
                      <td align="right" className="font-mono">
                        {r.timeDoctorMinutes}
                      </td>
                      <td align="right" className="font-mono">
                        {r.activeMinutes}
                      </td>
                      <td align="right" className="font-mono">
                        {r.inactiveMinutes}
                      </td>
                      <td align="right" className="font-mono">
                        {r.meetingsAttended}
                      </td>
                      <td align="right" className="font-mono">
                        {r.chatMessages}
                      </td>
                      <td align="right" className="font-mono">
                        {r.emails}
                      </td>
                      <td align="right" className="font-mono">
                        {r.docsCreated}
                      </td>
                      <td align="right" className="font-mono text-muted-foreground">
                        {r.wordsTypedOrSpoken || "—"}
                      </td>
                      <td align="center">
                        <span
                          className={
                            "text-[11px] font-medium px-2 py-0.5 rounded " +
                            (r.working === "Yes"
                              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                              : "bg-muted text-muted-foreground")
                          }
                        >
                          {r.working}
                        </span>
                      </td>
                      <td align="right" className="font-mono font-medium">
                        {r.hoursCredit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </div>
        </div>
      ) : null}

      <p className="text-[10px] text-muted-foreground">
        * Words typed/spoken are estimated from email, chat, docs, meetings, and active minutes. Hours credit = 1
        when active ≥ 30 min in that hour (IST).
      </p>
    </div>
  );
}
