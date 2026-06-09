import { useEffect, useMemo, useState } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { Loader2, Trash2 } from "lucide-react";
import { Drawer } from "@/components/Drawer";
import { Field, FormFooter, GhostBtn, PrimaryBtn, TextArea, TextInput } from "@/components/forms/FormField";
import type { BonusCashEvent, EmployeeCompensationLedger, ShareEvent, ShareEventType } from "@/lib/bonus-schema";
import { periodLabelFromIso, sumBonusEvents, sumShareGrants } from "@/lib/bonus-schema";
import { fmtCurrency, fmtDate } from "@/lib/format";

type VoidTarget =
  | { kind: "bonus"; event: BonusCashEvent }
  | { kind: "share"; event: ShareEvent };

type Props = {
  open: boolean;
  ledger: EmployeeCompensationLedger | null;
  canEdit: boolean;
  saving?: boolean;
  onClose: () => void;
  onRecordBonus: (payload: {
    amountUsd: number;
    paidOn: string;
    periodLabel?: string;
    note?: string;
  }) => void;
  onRecordShare: (payload: {
    eventType: ShareEventType;
    shares: number;
    effectiveDate: string;
    strikePriceUsd?: number | null;
    note?: string;
  }) => void;
  onVoidBonus?: (eventId: string) => void;
  onVoidShare?: (eventId: string) => void;
};

export function BonusEmployeeLedgerDrawer({
  open,
  ledger,
  canEdit,
  saving,
  onClose,
  onRecordBonus,
  onRecordShare,
  onVoidBonus,
  onVoidShare,
}: Props) {
  const [tab, setTab] = useState<"history" | "bonus" | "shares">("history");
  const [voidTarget, setVoidTarget] = useState<VoidTarget | null>(null);
  const [voidConfirmTyped, setVoidConfirmTyped] = useState("");
  const [bonusAmount, setBonusAmount] = useState("");
  const [bonusPaidOn, setBonusPaidOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [bonusNote, setBonusNote] = useState("");
  const [shareType, setShareType] = useState<ShareEventType>("grant");
  const [shareCount, setShareCount] = useState("");
  const [shareDate, setShareDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [shareStrike, setShareStrike] = useState("");
  const [shareNote, setShareNote] = useState("");

  useEffect(() => {
    if (!open) {
      setTab("history");
      setBonusAmount("");
      setBonusNote("");
      setShareCount("");
      setShareNote("");
      setShareStrike("");
      setVoidTarget(null);
      setVoidConfirmTyped("");
    }
  }, [open]);

  useEffect(() => {
    if (!voidTarget) setVoidConfirmTyped("");
  }, [voidTarget]);

  const totalBonus = useMemo(() => (ledger ? sumBonusEvents(ledger.bonusEvents) : 0), [ledger]);
  const totalShares = useMemo(() => (ledger ? sumShareGrants(ledger.shareEvents) : 0), [ledger]);

  const sortedBonuses = useMemo(
    () =>
      ledger
        ? [...ledger.bonusEvents].sort((a, b) => b.paidOn.localeCompare(a.paidOn) || b.createdAt.localeCompare(a.createdAt))
        : [],
    [ledger],
  );
  const sortedShares = useMemo(
    () =>
      ledger
        ? [...ledger.shareEvents].sort(
            (a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.createdAt.localeCompare(a.createdAt),
          )
        : [],
    [ledger],
  );

  if (!open || !ledger) return null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={ledger.employeeName}
      eyebrow={ledger.active ? "Compensation ledger" : "Former employee (history retained)"}
      width="xl"
    >
      <div className="flex flex-col flex-1 min-h-0">
        <div className="px-5 py-4 border-b border-border space-y-3">
          <div className="flex flex-wrap gap-2 text-[12px] text-muted-foreground">
            {ledger.jobTitle && <span>{ledger.jobTitle}</span>}
            {ledger.team && <span>· {ledger.team}</span>}
            {ledger.location && <span>· {ledger.location}</span>}
            {ledger.officialEmail && <span>· {ledger.officialEmail}</span>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <StatCard label="Lifetime bonuses" value={fmtCurrency(totalBonus)} />
            <StatCard label="Share grants (net)" value={totalShares.toLocaleString()} />
          </div>
          <div className="flex gap-2">
            <TabBtn active={tab === "history"} onClick={() => setTab("history")}>
              History
            </TabBtn>
            {canEdit && (
              <>
                <TabBtn active={tab === "bonus"} onClick={() => setTab("bonus")}>
                  Record bonus
                </TabBtn>
                <TabBtn active={tab === "shares"} onClick={() => setTab("shares")}>
                  Record shares
                </TabBtn>
              </>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === "history" && (
            <div className="space-y-6">
              <section>
                <h3 className="text-[12px] font-medium mb-2">Cash bonuses</h3>
                {sortedBonuses.length === 0 ? (
                  <EmptyState>No bonus payments recorded yet.</EmptyState>
                ) : (
                  <div className="space-y-2">
                    {sortedBonuses.map((e) => (
                      <div key={e.id} className="rounded-lg border border-border px-3 py-2.5 bg-muted/20">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="font-medium text-[13px]">{fmtCurrency(e.amountUsd)}</div>
                            <div className="text-[12px] text-muted-foreground mt-0.5">
                              Paid {fmtDate(e.paidOn)}
                              {e.periodLabel ? ` · ${e.periodLabel}` : ""}
                            </div>
                            {e.note && <div className="text-[12px] mt-1">{e.note}</div>}
                          </div>
                          <div className="flex flex-col items-end gap-1 shrink-0">
                            <div className="text-[11px] text-muted-foreground text-right">
                              {e.createdBy && <div>{e.createdBy}</div>}
                              <div>{fmtDate(e.createdAt.slice(0, 10))}</div>
                            </div>
                            {canEdit && onVoidBonus && (
                              <button
                                type="button"
                                onClick={() => setVoidTarget({ kind: "bonus", event: e })}
                                disabled={saving}
                                className="h-7 w-7 grid place-items-center rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/10 disabled:opacity-50"
                                title="Remove accidental entry"
                                aria-label="Delete bonus payment"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <h3 className="text-[12px] font-medium mb-2">Shares & equity</h3>
                {sortedShares.length === 0 ? (
                  <EmptyState>No share events recorded yet.</EmptyState>
                ) : (
                  <div className="space-y-2">
                    {sortedShares.map((e) => (
                      <div key={e.id} className="rounded-lg border border-border px-3 py-2.5 bg-muted/20">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="font-medium text-[13px] capitalize">
                              {e.eventType.replace("_", " ")} · {e.shares.toLocaleString()} shares
                            </div>
                            <div className="text-[12px] text-muted-foreground mt-0.5">
                              Effective {fmtDate(e.effectiveDate)}
                              {e.strikePriceUsd != null ? ` · Strike ${fmtCurrency(e.strikePriceUsd)}` : ""}
                            </div>
                            {e.note && <div className="text-[12px] mt-1">{e.note}</div>}
                          </div>
                          <div className="flex flex-col items-end gap-1 shrink-0">
                            <div className="text-[11px] text-muted-foreground text-right">
                              {e.createdBy && <div>{e.createdBy}</div>}
                              <div>{fmtDate(e.createdAt.slice(0, 10))}</div>
                            </div>
                            {canEdit && onVoidShare && (
                              <button
                                type="button"
                                onClick={() => setVoidTarget({ kind: "share", event: e })}
                                disabled={saving}
                                className="h-7 w-7 grid place-items-center rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/10 disabled:opacity-50"
                                title="Remove accidental entry"
                                aria-label="Delete share event"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {tab === "bonus" && canEdit && (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                const amountUsd = Number(bonusAmount);
                if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
                onRecordBonus({
                  amountUsd,
                  paidOn: bonusPaidOn,
                  periodLabel: periodLabelFromIso(bonusPaidOn),
                  note: bonusNote.trim() || undefined,
                });
              }}
            >
              <Field label="Amount (USD)" required>
                <TextInput
                  type="number"
                  min={0}
                  step="0.01"
                  value={bonusAmount}
                  onChange={(e) => setBonusAmount(e.target.value)}
                  placeholder="500"
                  required
                />
              </Field>
              <Field label="Paid on" required>
                <TextInput
                  type="date"
                  value={bonusPaidOn}
                  onChange={(e) => setBonusPaidOn(e.target.value)}
                  required
                />
              </Field>
              <Field label="Note (optional)">
                <TextArea
                  value={bonusNote}
                  onChange={(e) => setBonusNote(e.target.value)}
                  placeholder="Q1 performance bonus, referral bonus, etc."
                  rows={3}
                />
              </Field>
              <FormFooter>
                <GhostBtn type="button" onClick={onClose}>
                  Cancel
                </GhostBtn>
                <PrimaryBtn type="submit" disabled={saving}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Record bonus payment"}
                </PrimaryBtn>
              </FormFooter>
            </form>
          )}

          {tab === "shares" && canEdit && (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                const shares = Number(shareCount);
                if (!Number.isFinite(shares)) return;
                onRecordShare({
                  eventType: shareType,
                  shares,
                  effectiveDate: shareDate,
                  strikePriceUsd: shareStrike.trim() ? Number(shareStrike) : null,
                  note: shareNote.trim() || undefined,
                });
              }}
            >
              <Field label="Event type" required>
                <select
                  value={shareType}
                  onChange={(e) => setShareType(e.target.value as ShareEventType)}
                  className="w-full h-9 px-3 rounded-md border border-border bg-background text-[13px]"
                >
                  <option value="grant">Grant</option>
                  <option value="vest">Vest</option>
                  <option value="adjustment">Adjustment</option>
                  <option value="note">Note (0 shares)</option>
                </select>
              </Field>
              <Field label="Shares" required>
                <TextInput
                  type="number"
                  step="1"
                  value={shareCount}
                  onChange={(e) => setShareCount(e.target.value)}
                  placeholder="1000"
                  required
                />
              </Field>
              <Field label="Effective date" required>
                <TextInput
                  type="date"
                  value={shareDate}
                  onChange={(e) => setShareDate(e.target.value)}
                  required
                />
              </Field>
              <Field label="Strike price (USD, optional)">
                <TextInput
                  type="number"
                  min={0}
                  step="0.01"
                  value={shareStrike}
                  onChange={(e) => setShareStrike(e.target.value)}
                  placeholder="0.50"
                />
              </Field>
              <Field label="Note (optional)">
                <TextArea
                  value={shareNote}
                  onChange={(e) => setShareNote(e.target.value)}
                  placeholder="ISO grant, cliff vest, etc."
                  rows={3}
                />
              </Field>
              <FormFooter>
                <GhostBtn type="button" onClick={onClose}>
                  Cancel
                </GhostBtn>
                <PrimaryBtn type="submit" disabled={saving}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Record share event"}
                </PrimaryBtn>
              </FormFooter>
            </form>
          )}
        </div>
      </div>

      <AlertDialog.Root
        open={!!voidTarget}
        onOpenChange={(open) => {
          if (!open) {
            setVoidTarget(null);
            setVoidConfirmTyped("");
          }
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/40 z-[80]" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[80] w-[92vw] max-w-md surface-card p-4">
            <AlertDialog.Title className="font-medium text-[14px]">
              Delete {voidTarget?.kind === "bonus" ? "bonus payment" : "share event"}?
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <div className="mt-2 space-y-2 text-[12px] text-muted-foreground leading-relaxed">
                {voidTarget?.kind === "bonus" ? (
                  <p>
                    Remove <span className="font-semibold text-foreground">{fmtCurrency(voidTarget.event.amountUsd)}</span>{" "}
                    paid on {fmtDate(voidTarget.event.paidOn)}?
                  </p>
                ) : voidTarget?.kind === "share" ? (
                  <p>
                    Remove{" "}
                    <span className="font-semibold text-foreground capitalize">
                      {voidTarget.event.eventType} · {voidTarget.event.shares.toLocaleString()} shares
                    </span>{" "}
                    effective {fmtDate(voidTarget.event.effectiveDate)}?
                  </p>
                ) : null}
                <p>
                  Use this only if the entry was added by mistake. It will disappear from this ledger, but a snapshot
                  stays in the S3 audit log forever.
                </p>
                <p>
                  Type <span className="font-mono text-[11px] px-1 rounded bg-muted text-foreground">DELETE</span> to
                  confirm.
                </p>
              </div>
            </AlertDialog.Description>
            <div className="mt-3">
              <input
                value={voidConfirmTyped}
                onChange={(e) => setVoidConfirmTyped(e.target.value)}
                placeholder='Type "DELETE"'
                className="w-full h-9 px-3 rounded-md border border-border bg-background text-[13px]"
                autoFocus
              />
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className="h-8 px-3 rounded-md border border-border text-[12px] font-medium text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  disabled={saving || !voidTarget || voidConfirmTyped !== "DELETE"}
                  onClick={() => {
                    if (!voidTarget || voidConfirmTyped !== "DELETE") return;
                    if (voidTarget.kind === "bonus") onVoidBonus?.(voidTarget.event.id);
                    else onVoidShare?.(voidTarget.event.id);
                    setVoidTarget(null);
                    setVoidConfirmTyped("");
                  }}
                  className="h-8 px-3 rounded-md bg-destructive text-destructive-foreground text-[12px] font-medium disabled:opacity-60"
                >
                  Delete entry
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </Drawer>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2.5 bg-muted/20">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-display text-lg mt-0.5">{value}</div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "h-8 px-3 rounded-md border text-xs font-medium transition-colors " +
        (active
          ? "bg-muted text-foreground border-border"
          : "text-muted-foreground border-transparent hover:bg-muted/60")
      }
    >
      {children}
    </button>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[12px] text-muted-foreground">
      {children}
    </div>
  );
}
