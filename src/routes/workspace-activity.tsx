import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Activity, ArrowDownAZ, ArrowUpAZ, Download, FileText, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, PageHeader, TableScroll } from "@/components/AppShell";
import { downloadCSV } from "@/lib/csv";
import { getWorkspaceActivity } from "@/lib/workspace-activity-functions";
import { downloadWorkspaceActivityPdf } from "@/lib/workspace-activity-pdf";
import { medalRowClass, rankCellContent, workspaceActivityRank } from "@/lib/rank-medals";
import { HourlyActivityReport } from "@/components/HourlyActivityReport";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";

const PRESET_DAYS = [1, 7, 30, 45, 90] as const;
const STORAGE_KEY = "alyson-workspace-activity-session";

type StoredState = {
  version: 1;
  draftStart: string;
  draftEnd: string;
  applied: { start: string; end: string } | null;
  search: string;
  sortBy?: "emails" | "meetings" | "docs" | "chat";
  sortDir?: "asc" | "desc";
};

function loadStoredState(): StoredState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredState;
    if (parsed?.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/workspace-activity")({
  head: () => ({ meta: [{ title: "Workspace Activity — Alyson HR" }] }),
  component: WorkspaceActivityPage,
});

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
    second: "2-digit",
    hour12: false,
  }).format(d);
}

function WorkspaceActivityPage() {
  const now = useMemo(() => new Date(), []);
  const boot = useMemo(() => loadStoredState(), []);
  const fallbackStart = useMemo(() => new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString(), [now]);
  const fallbackEnd = useMemo(() => now.toISOString(), [now]);

  const [draftEnd, setDraftEnd] = useState(() => boot?.draftEnd ?? isoForInput(now));
  const [draftStart, setDraftStart] = useState(() => boot?.draftStart ?? isoForInput(new Date(now.getTime() - 23 * 60 * 60 * 1000)));
  const [applied, setApplied] = useState<{ start: string; end: string } | null>(() => boot?.applied ?? { start: fallbackStart, end: fallbackEnd });
  const [search, setSearch] = useState(() => boot?.search ?? "");
  const [hourlyEmployeeEmail, setHourlyEmployeeEmail] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"emails" | "meetings" | "docs" | "chat">(() => boot?.sortBy ?? "emails");
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => boot?.sortDir ?? "desc");

  const q = useQuery({
    queryKey: ["workspace-activity", applied?.start ?? "idle", applied?.end ?? "idle"],
    queryFn: () =>
      getWorkspaceActivity({
        data: applied
          ? {
              start: applied.start,
              end: applied.end,
            }
          : undefined,
      }),
    enabled: applied !== null,
    placeholderData: keepPreviousData,
    staleTime: 120_000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const rows = q.data?.rows ?? [];
  const filteredRows = useMemo(() => {
    const s = search.trim().toLowerCase();
    const base = !s ? rows : rows.filter((r) => r.userEmail.toLowerCase().includes(s));
    const metric = (r: (typeof base)[number]) => {
      if (sortBy === "meetings") return r.meetingsCreated;
      if (sortBy === "docs") return r.docsCreated;
      if (sortBy === "chat") return r.chatMessagesSent;
      return r.emailsSent;
    };
    return [...base].sort((a, b) => {
      const diff = metric(a) - metric(b);
      if (diff !== 0) return sortDir === "asc" ? diff : -diff;
      return a.userEmail.localeCompare(b.userEmail);
    });
  }, [rows, search, sortBy, sortDir]);

  const rankByEmail = useMemo(() => workspaceActivityRank(rows), [rows]);

  const hourlyEmployeeOptions = useMemo(
    () =>
      rows.slice(0, 80).map((r) => ({
        email: r.userEmail,
        label: r.userEmail,
      })),
    [rows],
  );

  const totalsComparison = useMemo(() => {
    return [
      {
        metric: "Meetings",
        value: filteredRows.reduce((n, r) => n + r.meetingsCreated, 0),
      },
      {
        metric: "Docs",
        value: filteredRows.reduce((n, r) => n + r.docsCreated, 0),
      },
      {
        metric: "Chat",
        value: filteredRows.reduce((n, r) => n + r.chatMessagesSent, 0),
      },
      {
        metric: "Emails",
        value: filteredRows.reduce((n, r) => n + r.emailsSent, 0),
      },
    ];
  }, [filteredRows]);

  const topUsersComparison = useMemo(() => {
    return [...filteredRows]
      .sort((a, b) => {
        const ta = a.meetingsCreated + a.docsCreated + a.chatMessagesSent;
        const tb = b.meetingsCreated + b.docsCreated + b.chatMessagesSent;
        return tb - ta || b.emailsSent - a.emailsSent;
      })
      .slice(0, 12)
      .map((r) => ({
        user: r.userEmail,
        meetings: r.meetingsCreated,
        docs: r.docsCreated,
        chat: r.chatMessagesSent,
        emails: r.emailsSent,
      }));
  }, [filteredRows]);

  const apply = () => {
    if (!draftStart || !draftEnd) return toast.error("Select start and end datetime");
    const s = new Date(draftStart);
    const e = new Date(draftEnd);
    if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) return toast.error("Invalid datetime range");
    if (s.getTime() >= e.getTime()) return toast.error("Start must be before end");
    setApplied({ start: s.toISOString(), end: e.toISOString() });
  };

  const applyPreset = (days: (typeof PRESET_DAYS)[number]) => {
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    setDraftStart(isoForInput(start));
    setDraftEnd(isoForInput(end));
    setApplied({ start: start.toISOString(), end: end.toISOString() });
  };

  const exportCsv = () => {
    if (!filteredRows.length) return toast.error("No rows to export");
    const suffix = q.data?.range?.start?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
    downloadCSV(
      `workspace-activity-${suffix}.csv`,
      filteredRows.map((r) => ({
        user_email: r.userEmail,
        emails_sent: r.emailsSent,
        calendar_meetings_in_window: r.meetingsCreated,
        google_docs_created: r.docsCreated,
        chat_messages_sent: r.chatMessagesSent,
      })),
      [
        "user_email",
        "emails_sent",
        "calendar_meetings_in_window",
        "google_docs_created",
        "chat_messages_sent",
      ],
    );
    toast.success("Workspace activity exported");
  };

  const exportPdf = () => {
    if (!q.data || !filteredRows.length) {
      toast.error("No rows to export");
      return;
    }
    downloadWorkspaceActivityPdf({
      rows: filteredRows,
      range: q.data.range,
      generatedAt: q.data.generatedAt,
      filteredBy: search,
    });
    toast.success("Workspace activity PDF exported");
  };

  const applySort = (field: "emails" | "meetings" | "docs" | "chat") => {
    if (sortBy === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(field);
    setSortDir("desc");
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload: StoredState = {
      version: 1,
      draftStart,
      draftEnd,
      applied,
      search,
      sortBy,
      sortDir,
    };
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore quota/private mode
    }
  }, [draftStart, draftEnd, applied, search, sortBy, sortDir]);

  return (
    <div className="ops-dense">
      <PageHeader
        eyebrow="Operations"
        title="Workspace Activity"
        description="Google Workspace activity metrics (emails, meetings, docs, chat) for a custom datetime window."
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => q.refetch()}
              disabled={!applied || q.isFetching}
              className="h-8 px-3 rounded-md border border-border text-xs inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
            <button
              onClick={exportCsv}
              disabled={!filteredRows.length}
              className="h-8 px-3 rounded-md border border-border text-xs inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
            <button
              onClick={exportPdf}
              disabled={!filteredRows.length}
              className="h-8 px-3 rounded-md border border-border text-xs inline-flex items-center gap-1.5 hover:bg-muted disabled:opacity-50"
            >
              <FileText className="h-3.5 w-3.5" />
              Export PDF
            </button>
          </div>
        }
      />

      <div className="px-5 md:px-8 py-6 space-y-5">
        <div className="surface-card p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
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
            className="h-8 px-4 rounded-md bg-foreground text-background text-xs font-medium"
          >
            Apply window
          </button>
          <div className="text-[11px] text-muted-foreground">
            Default window is last 23 hours. Times shown below are IST.
          </div>
          <div className="md:col-span-4 flex flex-wrap gap-1.5">
            {PRESET_DAYS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => applyPreset(d)}
                className="h-7 px-3 rounded-full text-[11px] font-medium border border-border bg-paper text-muted-foreground hover:text-foreground"
              >
                {d === 1 ? "Last 1 day" : `Last ${d} days`}
              </button>
            ))}
          </div>
        </div>

        {q.data && (
          <div className="surface-card p-3 text-[12px] text-muted-foreground">
            Window (IST): {fmtIso(q.data.range.start)} → {fmtIso(q.data.range.end)} · Users processed: {q.data.usersProcessed}
            {search.trim() ? ` · Showing: ${filteredRows.length}` : ""}
          </div>
        )}

        <div className="relative max-w-sm">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search user email..."
            className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-background text-[13px]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground mr-1">Sort by</span>
          {[
            { key: "emails", label: "Emails" },
            { key: "meetings", label: "Meetings" },
            { key: "docs", label: "Docs" },
            { key: "chat", label: "Chat" },
          ].map((s) => {
            const active = sortBy === s.key;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => applySort(s.key as "emails" | "meetings" | "docs" | "chat")}
                className={
                  "h-7 px-2.5 rounded-full text-[11px] font-medium border inline-flex items-center gap-1 " +
                  (active
                    ? "bg-foreground text-background border-foreground"
                    : "bg-paper border-border text-muted-foreground hover:text-foreground")
                }
                title={active ? `Sorted ${sortDir}` : "Click to sort"}
              >
                {s.label}
                {active ? (
                  sortDir === "asc" ? <ArrowUpAZ className="h-3.5 w-3.5" /> : <ArrowDownAZ className="h-3.5 w-3.5" />
                ) : null}
              </button>
            );
          })}
        </div>

        {q.data?.warnings?.length ? (
          <div className="surface-card p-4">
            <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium mb-2">Warnings</div>
            <ul className="text-xs text-muted-foreground space-y-1">
              {q.data.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {q.isLoading && !q.data ? (
          <div className="text-sm text-muted-foreground">Loading workspace activity...</div>
        ) : null}

        {q.isFetching && q.data ? (
          <div className="text-[11px] text-muted-foreground">Refreshing activity in background...</div>
        ) : null}

        {!q.isLoading && !q.isFetching && q.isError ? (
          <div className="surface-card p-4 text-sm text-destructive">
            {q.error instanceof Error ? q.error.message : "Failed to load workspace activity"}
          </div>
        ) : null}

        {!q.isLoading && !q.isFetching && q.data && filteredRows.length === 0 ? (
          <EmptyState icon={Activity} title="No activity rows" description="No users or no activity events in this window." />
        ) : null}

        {!!filteredRows.length && (
          <>
            <TableScroll>
              <table className="ops-table w-full">
                <thead>
                  <tr>
                    <th align="center">Medal</th>
                    <th align="left">User email</th>
                    <th align="right">Emails sent</th>
                    <th align="right">Meetings in window</th>
                    <th align="right">Docs created</th>
                    <th align="right">Chat messages</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((r) => {
                    const rank = rankByEmail.get(r.userEmail) ?? 0;
                    return (
                    <tr
                      key={r.userEmail}
                      className={
                        medalRowClass(rank) +
                        (hourlyEmployeeEmail === r.userEmail ? " ring-1 ring-inset ring-foreground/25" : "") +
                        " cursor-pointer hover:opacity-95"
                      }
                      onClick={() => setHourlyEmployeeEmail(r.userEmail)}
                      title="Click to load hourly breakdown below"
                    >
                      <td align="center">{rank > 0 ? rankCellContent(rank) : "—"}</td>
                      <td>{r.userEmail}</td>
                      <td align="right" className="font-mono">
                        {r.emailsSent}
                      </td>
                      <td align="right" className="font-mono">
                        {r.meetingsCreated}
                      </td>
                      <td align="right" className="font-mono">
                        {r.docsCreated}
                      </td>
                      <td align="right" className="font-mono">
                        {r.chatMessagesSent}
                      </td>
                    </tr>
                  );})}
                </tbody>
              </table>
            </TableScroll>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <div className="surface-card p-4 md:p-5">
                <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">
                  Totals comparison
                </div>
                <h3 className="font-display text-lg mt-0.5 mb-3">Meetings vs Docs vs Chat vs Emails</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={totalsComparison} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="metric" stroke="var(--muted-foreground)" fontSize={11} />
                    <YAxis stroke="var(--muted-foreground)" fontSize={11} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: "var(--paper)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }} />
                    <Bar dataKey="value" name="Count" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="surface-card p-4 md:p-5">
                <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">
                  Top users
                </div>
                <h3 className="font-display text-lg mt-0.5 mb-3">Meetings / Docs / Chat comparison</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={topUsersComparison} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="user"
                      stroke="var(--muted-foreground)"
                      fontSize={10}
                      interval={0}
                      angle={-25}
                      textAnchor="end"
                      height={70}
                    />
                    <YAxis stroke="var(--muted-foreground)" fontSize={11} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: "var(--paper)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="meetings" name="Meetings" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="docs" name="Docs" fill="var(--chart-4)" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="chat" name="Chat" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="pt-4 border-t border-border">
              <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium mb-3">
                Hourly breakdown
              </div>
              <p className="text-[12px] text-muted-foreground mb-4 max-w-2xl">
                Hour-by-hour activity for one employee (emails, chat, docs, meetings, Time Doctor). Top 3 rows above
                use gold / silver / bronze highlights by total activity in the window.
              </p>
              <HourlyActivityReport
                compact
                syncRange={applied}
                selectedEmail={hourlyEmployeeEmail}
                employeeOptions={hourlyEmployeeOptions}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
