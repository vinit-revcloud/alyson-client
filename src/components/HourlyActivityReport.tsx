import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, Loader2, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { TableScroll } from "@/components/AppShell";
import { TableSkeleton } from "@/components/Skeleton";
import { downloadCSV } from "@/lib/csv";
import { getHourlyActivityReport } from "@/lib/hourly-activity-functions";

const PRESET_HOURS = [24, 48, 72] as const;
const STORAGE_KEY = "alyson-hourly-report-session";

type StoredState = {
  draftStart: string;
  draftEnd: string;
  search: string;
  applied: { start: string; end: string; userEmail: string } | null;
};

function isoForInput(d: Date) {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function loadStored(): StoredState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredState) : null;
  } catch {
    return null;
  }
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

export type HourlyActivityReportProps = {
  compact?: boolean;
  /** Pre-fill from Employee Scoring / Workspace Activity window */
  syncRange?: { start: string; end: string } | null;
  /** Pre-fill when user clicks a row in a parent table */
  selectedEmail?: string | null;
  /** Optional roster for quick pick (email → display label) */
  employeeOptions?: Array<{ email: string; label: string }>;
};

export function HourlyActivityReport({
  compact,
  syncRange,
  selectedEmail,
  employeeOptions,
}: HourlyActivityReportProps) {
  const now = useMemo(() => new Date(), []);
  const boot = useMemo(() => loadStored(), []);

  const initialStart = syncRange?.start
    ? isoForInput(new Date(syncRange.start))
    : boot?.draftStart ?? isoForInput(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const initialEnd = syncRange?.end ? isoForInput(new Date(syncRange.end)) : boot?.draftEnd ?? isoForInput(now);
  const initialSearch = selectedEmail?.trim() || boot?.search || "";

  const [draftEnd, setDraftEnd] = useState(initialEnd);
  const [draftStart, setDraftStart] = useState(initialStart);
  const [search, setSearch] = useState(initialSearch);
  const [applied, setApplied] = useState<StoredState["applied"]>(() => boot?.applied ?? null);

  useEffect(() => {
    if (syncRange?.start && syncRange?.end) {
      setDraftStart(isoForInput(new Date(syncRange.start)));
      setDraftEnd(isoForInput(new Date(syncRange.end)));
    }
  }, [syncRange?.start, syncRange?.end]);

  useEffect(() => {
    if (selectedEmail?.trim()) setSearch(selectedEmail.trim());
  }, [selectedEmail]);

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
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const filteredRows = useMemo(() => {
    const rows = q.data?.rows ?? [];
    const s = search.trim().toLowerCase();
    if (!s || looksLikeEmail(s)) return rows;
    return rows.filter((r) => {
      const label = `${q.data?.displayName ?? ""} ${q.data?.userEmail ?? ""}`.toLowerCase();
      return label.includes(s);
    });
  }, [q.data, search]);

  const apply = () => {
    const email = search.trim().toLowerCase();
    if (!looksLikeEmail(email)) {
      toast.error("Enter a full employee email in search (e.g. thirumalai@cintara.ai)");
      return;
    }
    if (!draftStart || !draftEnd) return toast.error("Select start and end datetime");
    const s = new Date(draftStart);
    const e = new Date(draftEnd);
    if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) {
      return toast.error("Invalid datetime range");
    }
    if (s.getTime() >= e.getTime()) return toast.error("Start must be before end");
    setApplied({ start: s.toISOString(), end: e.toISOString(), userEmail: email });
  };

  const applyPresetHours = (hours: (typeof PRESET_HOURS)[number]) => {
    const end = new Date();
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
    setDraftStart(isoForInput(start));
    setDraftEnd(isoForInput(end));
    const email = search.trim().toLowerCase();
    if (!looksLikeEmail(email)) {
      toast.error("Enter employee email in search first");
      return;
    }
    setApplied({ start: start.toISOString(), end: end.toISOString(), userEmail: email });
  };

  const exportCsv = () => {
    if (!filteredRows.length) return toast.error("No rows to export");
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
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ draftStart, draftEnd, search, applied } satisfies StoredState),
      );
    } catch {
      // ignore
    }
  }, [draftStart, draftEnd, search, applied]);

  const isBusy = q.isFetching;
  const coldLoad = q.isPending && !q.data;

  return (
    <div className={compact ? "space-y-4" : "space-y-5"}>
      <div className="surface-card p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
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
                className="h-8 px-2 rounded-md border border-border bg-background text-[12px] max-w-full sm:max-w-[220px]"
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
                className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-background text-[13px]"
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
          disabled={isBusy}
          className="h-8 px-4 rounded-md bg-foreground text-background text-xs font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-70"
        >
          {isBusy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </>
          ) : (
            "Load hourly report"
          )}
        </button>
        <div className="md:col-span-3 flex flex-wrap gap-1.5 items-center">
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
            disabled={!filteredRows.length}
            className="h-7 px-3 rounded-full text-[11px] font-medium border border-border inline-flex items-center gap-1 hover:bg-muted disabled:opacity-50"
          >
            <Download className="h-3 w-3" />
            Export CSV
          </button>
        </div>
      </div>

      {applied && q.data ? (
        <div className="surface-card p-3 text-[12px] text-muted-foreground">
          <span className="font-medium text-foreground">{q.data.displayName}</span> ({q.data.userEmail}) ·
          Window (IST): {fmtIso(applied.start)} → {fmtIso(applied.end)} · Rows: {filteredRows.length}
        </div>
      ) : (
        <div className="surface-card p-3 text-[12px] text-muted-foreground">
          Enter an employee email and time range, then load the hourly breakdown (IST buckets, max 7 days per load).
          {syncRange && applied == null ? " Uses the parent page window when you click Load." : ""}
        </div>
      )}

      {syncRange && applied && new Date(applied.end).getTime() - new Date(applied.start).getTime() > 7 * 24 * 60 * 60 * 1000 ? (
        <div className="text-[11px] text-amber-800 dark:text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
          Parent window is longer than 7 days — narrow Start/End here or use a shorter preset before loading hourly
          data.
        </div>
      ) : null}

      {q.data?.warnings?.length ? (
        <div className="surface-card p-3 text-[11px] text-muted-foreground">
          {q.data.warnings.slice(0, 6).map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      ) : null}

      {q.isError ? (
        <div className="surface-card p-4 text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : "Failed to load hourly report"}
        </div>
      ) : null}

      {coldLoad ? <TableSkeleton rows={8} /> : null}

      {!coldLoad && applied && filteredRows.length > 0 ? (
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
      ) : null}

      {!coldLoad && applied && !q.isFetching && filteredRows.length === 0 && !q.isError ? (
        <div className="text-sm text-muted-foreground">No hourly rows in this window.</div>
      ) : null}

      <p className="text-[10px] text-muted-foreground">
        * Words typed/spoken are estimated from email, chat, docs, meetings, and active minutes. Hours credit = 1
        when active ≥ 30 min in that hour (IST).
      </p>
    </div>
  );
}
