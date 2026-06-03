import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download, Loader2, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { EmployeeEmailPicker, resolveEmployeeFromQuery } from "@/components/EmployeeEmailPicker";
import { EmptyState, TableScroll } from "@/components/AppShell";
import { downloadCSV } from "@/lib/csv";
import { getEmployeePickerDirectory } from "@/lib/employee-picker-functions";
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
  selectedEmail: selectedEmailFromParent,
  employeeOptions,
}: HourlyActivityReportProps) {
  const now = useMemo(() => new Date(), []);
  const boot = useMemo(() => loadHourlyActivitySession(), []);

  const [draftEnd, setDraftEnd] = useState(() => boot?.draftEnd ?? isoForInput(now));
  const [draftStart, setDraftStart] = useState(
    () => boot?.draftStart ?? isoForInput(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
  );
  const bootApplied = boot?.applied ?? null;
  const bootHasSnapshot = Boolean(bootApplied && readHourlyActivitySnapshot(bootApplied));

  const [search, setSearch] = useState(() => boot?.search ?? "");
  const [selectedEmail, setSelectedEmail] = useState<string | null>(() =>
    bootHasSnapshot ? bootApplied!.userEmail : null,
  );
  const [applied, setApplied] = useState<HourlyActivityStoredState["applied"]>(() =>
    bootHasSnapshot ? bootApplied : null,
  );

  const directoryQ = useQuery({
    queryKey: ["employee-picker-directory"],
    queryFn: () => getEmployeePickerDirectory(),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });

  const roster = useMemo(() => directoryQ.data?.employees ?? [], [directoryQ.data?.employees]);

  useEffect(() => {
    if (syncRange?.start && syncRange?.end) {
      setDraftStart(isoForInput(new Date(syncRange.start)));
      setDraftEnd(isoForInput(new Date(syncRange.end)));
    }
  }, [syncRange?.start, syncRange?.end]);

  useEffect(() => {
    if (!selectedEmailFromParent?.trim()) return;
    const email = selectedEmailFromParent.trim().toLowerCase();
    setSelectedEmail(email);
    const match = roster.find((e) => e.email === email);
    if (match) setSearch(match.name);
  }, [selectedEmailFromParent, roster]);

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

  const resolvedEmployee = useMemo(
    () =>
      selectedEmail
        ? roster.find((e) => e.email === selectedEmail) ?? { email: selectedEmail, name: selectedEmail }
        : resolveEmployeeFromQuery(search, roster, employeeOptions),
    [selectedEmail, search, roster, employeeOptions],
  );

  const draftRange = useMemo(() => {
    const email = resolvedEmployee?.email;
    if (!email || !draftStart || !draftEnd) return null;
    try {
      return draftToApplied(draftStart, draftEnd, email);
    } catch {
      return null;
    }
  }, [resolvedEmployee?.email, draftStart, draftEnd]);

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
    const resolved = resolvedEmployee ?? resolveEmployeeFromQuery(search, roster, employeeOptions);
    if (!resolved?.email) {
      toast.error("Pick an employee from the suggestions (type a name, then click a match)");
      return;
    }
    setSelectedEmail(resolved.email);
    setSearch(resolved.name);
    const email = resolved.email;
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
    const resolved = resolvedEmployee ?? resolveEmployeeFromQuery(search, roster, employeeOptions);
    if (!resolved?.email) {
      toast.error("Pick an employee from the suggestions first");
      return;
    }
    const email = resolved.email;
    setSelectedEmail(email);
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
    if (!compact || !selectedEmailFromParent?.trim() || !syncRange?.start || !syncRange?.end) return;
    const email = selectedEmailFromParent.trim().toLowerCase();
    const span = new Date(syncRange.end).getTime() - new Date(syncRange.start).getTime();
    if (span > MAX_RANGE_MS) return;
    const next = { start: syncRange.start, end: syncRange.end, userEmail: email };
    if (rangesMatch(next, applied)) return;
    setSelectedEmail(email);
    setApplied(next);
  }, [compact, selectedEmailFromParent, syncRange?.start, syncRange?.end, applied]);

  const statusBanner = (() => {
    if (coldLoad) {
      return {
        tone: "loading" as const,
        text: "Building hourly breakdown — usually 15–45 seconds. Previous data stays visible when you change employee or window.",
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
        <div className="space-y-1 md:col-span-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Find employee (by name)
          </span>
          <EmployeeEmailPicker
            query={search}
            onQueryChange={(v) => {
              setSearch(v);
              setSelectedEmail(null);
            }}
            selectedEmail={selectedEmail}
            onSelect={(emp) => {
              setSelectedEmail(emp.email);
              setSearch(emp.name);
            }}
            disabled={isBusy}
            extraOptions={employeeOptions}
            placeholder="Type first or last name…"
          />
        </div>
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
          Type a name, pick from suggestions, choose a time range (≤ 7 days), then load the hourly breakdown.
        </div>
      ) : null}

      {q.data?.warnings?.length && !showingStaleWindow ? (
        <div className="surface-card p-3 text-[11px] text-muted-foreground space-y-1">
          {q.data.warnings.slice(0, 6).map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      ) : null}

      {coldLoad ? (
        <div className="surface-card p-8 flex flex-col items-center justify-center gap-3 min-h-[180px]">
          <Loader2 className="h-9 w-9 animate-spin text-muted-foreground" />
          <p className="text-sm text-foreground font-medium">Loading hourly report</p>
          <p className="text-[12px] text-muted-foreground text-center max-w-md">
            Fetching Time Doctor hours and Workspace activity for{" "}
            <span className="font-medium">{resolvedEmployee?.name ?? "employee"}</span>…
          </p>
        </div>
      ) : null}

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
