import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, Loader2, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { BonusEmployeeLedgerDrawer } from "@/components/BonusEmployeeLedgerDrawer";
import { FetchingBar } from "@/components/Skeleton";
import { useAuth } from "@/lib/auth";
import {
  getBonusLedger,
  recordBonusPayment,
  recordShareEvent,
  syncBonusWithOnboarding,
  voidBonusPayment,
  voidShareEvent,
} from "@/lib/bonus-functions";
import type { EmployeeCompensationLedger } from "@/lib/bonus-schema";
import { sumBonusEvents, sumShareGrants } from "@/lib/bonus-schema";
import { fmtCurrency } from "@/lib/format";

export const Route = createFileRoute("/bonus/")({
  component: BonusEmployeesPage,
});

const QUERY_KEY = ["bonus-ledger"];

function BonusEmployeesPage() {
  const auth = useAuth();
  const canEdit = auth.hasAnyRole(["super_admin", "ceo"]);
  const actor = auth.user?.email ?? null;
  const qc = useQueryClient();

  const [searchQ, setSearchQ] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [selected, setSelected] = useState<EmployeeCompensationLedger | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const q = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => getBonusLedger(),
  });

  const syncM = useMutation({
    mutationFn: () => syncBonusWithOnboarding({ data: { actor } }),
    onSuccess: () => {
      toast.success("Synced employee roster from onboarding");
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["bonus-analytics"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Sync failed"),
  });

  const bonusM = useMutation({
    mutationFn: (payload: {
      employeeId: string;
      amountUsd: number;
      paidOn: string;
      periodLabel?: string;
      note?: string;
    }) => recordBonusPayment({ data: { ...payload, actor } }),
    onSuccess: (r) => {
      toast.success(`Recorded ${fmtCurrency(r.event.amountUsd)} bonus`);
      setSelected(r.ledger);
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["bonus-analytics"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to record bonus"),
  });

  const shareM = useMutation({
    mutationFn: (payload: {
      employeeId: string;
      eventType: "grant" | "vest" | "adjustment" | "note";
      shares: number;
      effectiveDate: string;
      strikePriceUsd?: number | null;
      note?: string;
    }) => recordShareEvent({ data: { ...payload, actor } }),
    onSuccess: (r) => {
      toast.success("Share event recorded");
      setSelected(r.ledger);
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["bonus-analytics"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to record share event"),
  });

  const voidBonusM = useMutation({
    mutationFn: (payload: { employeeId: string; eventId: string }) =>
      voidBonusPayment({ data: { ...payload, actor } }),
    onSuccess: (r) => {
      toast.success(`Removed ${fmtCurrency(r.removed.amountUsd)} bonus`);
      setSelected(r.ledger);
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["bonus-audit-log"] });
      void qc.invalidateQueries({ queryKey: ["bonus-analytics"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to delete bonus"),
  });

  const voidShareM = useMutation({
    mutationFn: (payload: { employeeId: string; eventId: string }) =>
      voidShareEvent({ data: { ...payload, actor } }),
    onSuccess: (r) => {
      toast.success("Share event removed");
      setSelected(r.ledger);
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["bonus-audit-log"] });
      void qc.invalidateQueries({ queryKey: ["bonus-analytics"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to delete share event"),
  });

  const ledgers = q.data?.ledgers ?? [];

  const filtered = useMemo(() => {
    const qNorm = searchQ.trim().toLowerCase();
    return ledgers.filter((l) => {
      if (activeOnly && !l.active) return false;
      if (!qNorm) return true;
      return (
        l.employeeName.toLowerCase().includes(qNorm) ||
        l.officialEmail.toLowerCase().includes(qNorm) ||
        l.team.toLowerCase().includes(qNorm) ||
        l.location.toLowerCase().includes(qNorm) ||
        l.employeeId.toLowerCase().includes(qNorm)
      );
    });
  }, [ledgers, searchQ, activeOnly]);

  const totals = useMemo(() => {
    let bonus = 0;
    let shares = 0;
    for (const l of filtered) {
      bonus += sumBonusEvents(l.bonusEvents);
      shares += sumShareGrants(l.shareEvents);
    }
    return { bonus, shares, count: filtered.length };
  }, [filtered]);

  const openLedger = (ledger: EmployeeCompensationLedger) => {
    setSelected(ledger);
    setDrawerOpen(true);
  };

  const saving = bonusM.isPending || shareM.isPending || voidBonusM.isPending || voidShareM.isPending;

  return (
    <div className="px-5 md:px-8 py-6 space-y-5">
      <FetchingBar active={q.isFetching} />

      <div className="surface-card p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <div className="font-medium text-[13px]">Employee compensation ledger</div>
          <div className="text-[12px] text-muted-foreground mt-1 max-w-2xl">
            Synced with{" "}
            <Link to="/employee-onboarding" className="text-foreground underline underline-offset-2">
              Employee Onboarding
            </Link>
            . Cash bonuses and share events are append-only — full history is always visible and persisted to S3 forever.
          </div>
          {q.data?.bucket && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono">
              <Cloud className="h-3.5 w-3.5 shrink-0" />
              s3://{q.data.bucket}/{q.data.key}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => syncM.mutate()}
            disabled={syncM.isPending || !canEdit}
            className="h-8 px-3 rounded-md border border-border text-xs font-medium hover:bg-muted disabled:opacity-50 flex items-center gap-1.5"
          >
            {syncM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Sync onboarding
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <MiniStat label="Employees shown" value={String(totals.count)} />
        <MiniStat label="Lifetime bonuses (filtered)" value={fmtCurrency(totals.bonus)} />
        <MiniStat label="Share grants (filtered)" value={totals.shares.toLocaleString()} />
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search name, email, team, location…"
            className="w-full h-9 pl-8 pr-3 rounded-md border border-border bg-background text-[13px]"
          />
        </div>
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
            className="rounded border-border"
          />
          Active employees only
        </label>
        <div className="text-[12px] text-muted-foreground sm:ml-auto">
          Showing {filtered.length} of {ledgers.length}
        </div>
      </div>

      <div className="surface-ops overflow-x-auto">
        <div className="min-w-[960px]">
          <table className="ops-table w-full">
            <thead>
              <tr>
                <th align="left">Employee</th>
                <th align="left">Team</th>
                <th align="left">Location</th>
                <th align="right">Bonuses paid</th>
                <th align="right"># Payments</th>
                <th align="right">Share grants</th>
                <th align="left">Last bonus</th>
                <th align="left">Status</th>
                <th align="right" />
              </tr>
            </thead>
            <tbody>
              {q.isLoading ? (
                <tr>
                  <td colSpan={9} className="text-center py-10 text-muted-foreground text-[13px]">
                    Loading ledger from S3…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-center py-10 text-muted-foreground text-[13px]">
                    No employees match your filters.
                  </td>
                </tr>
              ) : (
                filtered.map((l) => {
                  const bonusTotal = sumBonusEvents(l.bonusEvents);
                  const lastBonus = [...l.bonusEvents].sort((a, b) => b.paidOn.localeCompare(a.paidOn))[0];
                  return (
                    <tr key={l.employeeId} className="hover:bg-muted/30">
                      <td>
                        <div className="font-medium">{l.employeeName}</div>
                        <div className="text-[11px] text-muted-foreground">{l.officialEmail || l.employeeId}</div>
                      </td>
                      <td className="text-muted-foreground">{l.team || "—"}</td>
                      <td className="text-muted-foreground">{l.location || "—"}</td>
                      <td align="right" className="font-mono">
                        {bonusTotal > 0 ? fmtCurrency(bonusTotal) : "—"}
                      </td>
                      <td align="right" className="text-muted-foreground">
                        {l.bonusEvents.length || "—"}
                      </td>
                      <td align="right" className="font-mono">
                        {sumShareGrants(l.shareEvents) > 0 ? sumShareGrants(l.shareEvents).toLocaleString() : "—"}
                      </td>
                      <td className="text-muted-foreground text-[12px]">
                        {lastBonus ? `${fmtCurrency(lastBonus.amountUsd)} · ${lastBonus.paidOn}` : "—"}
                      </td>
                      <td>
                        <span className={"pill " + (l.active ? "pill-success" : "pill-neutral")}>
                          {l.active ? "Active" : "Former"}
                        </span>
                      </td>
                      <td align="right">
                        <button
                          type="button"
                          onClick={() => openLedger(l)}
                          className="h-7 px-2.5 rounded-md border border-border text-[11.5px] hover:bg-muted"
                        >
                          View ledger
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <BonusEmployeeLedgerDrawer
        open={drawerOpen}
        ledger={selected}
        canEdit={canEdit}
        saving={saving}
        onClose={() => {
          setDrawerOpen(false);
          setSelected(null);
        }}
        onRecordBonus={(payload) => {
          if (!selected) return;
          bonusM.mutate({ employeeId: selected.employeeId, ...payload });
        }}
        onRecordShare={(payload) => {
          if (!selected) return;
          shareM.mutate({ employeeId: selected.employeeId, ...payload });
        }}
        onVoidBonus={(eventId) => {
          if (!selected) return;
          voidBonusM.mutate({ employeeId: selected.employeeId, eventId });
        }}
        onVoidShare={(eventId) => {
          if (!selected) return;
          voidShareM.mutate({ employeeId: selected.employeeId, eventId });
        }}
      />
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface-card p-4">
      <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground font-medium">{label}</div>
      <div className="font-display text-xl mt-1">{value}</div>
    </div>
  );
}
