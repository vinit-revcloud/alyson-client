/** Append-only cash bonus payment recorded against an onboarding employee. */
export type BonusCashEvent = {
  id: string;
  amountUsd: number;
  /** ISO date YYYY-MM-DD when bonus was paid. */
  paidOn: string;
  /** Human label, e.g. "Jan 2026" or "Q1 2026". */
  periodLabel?: string;
  note?: string;
  createdAt: string;
  createdBy?: string | null;
};

export type ShareEventType = "grant" | "vest" | "adjustment" | "note";

/** Append-only equity / shares event for an employee. */
export type ShareEvent = {
  id: string;
  eventType: ShareEventType;
  shares: number;
  /** ISO date YYYY-MM-DD */
  effectiveDate: string;
  strikePriceUsd?: number | null;
  note?: string;
  createdAt: string;
  createdBy?: string | null;
};

export type EmployeeCompensationLedger = {
  employeeId: string;
  employeeName: string;
  officialEmail: string;
  jobTitle: string;
  team: string;
  location: string;
  /** False when employee was removed from onboarding roster (ledger history retained). */
  active: boolean;
  bonusEvents: BonusCashEvent[];
  shareEvents: ShareEvent[];
  updatedAt: string;
};

export type BonusOperation =
  | "bootstrap"
  | "sync"
  | "append_bonus"
  | "append_share"
  | "void_bonus"
  | "void_share";

export type BonusLogEntry = {
  ts: string;
  op: BonusOperation;
  actor: string | null;
  employeeId: string | null;
  employeeName?: string | null;
  details?: string;
  event?: BonusCashEvent | ShareEvent;
  employeeCount?: number;
};

export type BonusDataFile = {
  version: 1;
  updatedAt: string;
  syncedFromOnboardingAt: string | null;
  employees: Record<string, EmployeeCompensationLedger>;
};

export function newBonusEventId(): string {
  return `bonus_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function newShareEventId(): string {
  return `share_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function sumBonusEvents(events: BonusCashEvent[]): number {
  return events.reduce((sum, e) => sum + (Number.isFinite(e.amountUsd) ? e.amountUsd : 0), 0);
}

export function sumShareGrants(events: ShareEvent[]): number {
  return events
    .filter((e) => e.eventType === "grant" || e.eventType === "adjustment")
    .reduce((sum, e) => sum + (Number.isFinite(e.shares) ? e.shares : 0), 0);
}

export function periodLabelFromIso(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}
