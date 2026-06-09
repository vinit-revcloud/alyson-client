import type { BonusCashEvent, EmployeeCompensationLedger } from "@/lib/bonus-schema";

export type BonusPaymentFact = {
  eventId: string;
  employeeId: string;
  employeeName: string;
  team: string;
  location: string;
  jobTitle: string;
  active: boolean;
  amountUsd: number;
  paidOn: string;
  periodLabel?: string;
  note?: string;
  createdAt: string;
};

export type BonusAnalyticsReport = {
  generatedAt: string;
  ledgerUpdatedAt: string | null;
  summary: {
    totalPaid: number;
    paymentCount: number;
    employeeCount: number;
    teamCount: number;
    locationCount: number;
    avgPerPayment: number;
  };
  byTeam: Array<{ team: string; total: number; count: number; employees: number }>;
  byLocation: Array<{ location: string; total: number; count: number; employees: number }>;
  byMonth: Array<{ key: string; label: string; total: number; count: number }>;
  byWeek: Array<{ key: string; label: string; total: number; count: number }>;
  byDay: Array<{ key: string; label: string; total: number; count: number }>;
  topRecipients: Array<{
    employeeId: string;
    name: string;
    team: string;
    location: string;
    total: number;
    count: number;
  }>;
  recentPayments: BonusPaymentFact[];
  allPayments: BonusPaymentFact[];
};

function normLabel(v: string, fallback: string): string {
  const t = v.trim();
  return t || fallback;
}

function weekStartIso(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const dow = d.getUTCDay();
  const daysFromMonday = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysFromMonday);
  return d.toISOString().slice(0, 10);
}

function monthKey(day: string): string {
  return day.slice(0, 7);
}

function monthLabel(key: string): string {
  const d = new Date(`${key}-01T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return key;
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function weekLabel(weekStart: string): string {
  const d = new Date(`${weekStart}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return weekStart;
  return `Wk ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function flattenBonusPayments(ledgers: EmployeeCompensationLedger[]): BonusPaymentFact[] {
  const out: BonusPaymentFact[] = [];
  for (const ledger of ledgers) {
    for (const e of ledger.bonusEvents) {
      out.push({
        eventId: e.id,
        employeeId: ledger.employeeId,
        employeeName: ledger.employeeName,
        team: normLabel(ledger.team, "Unassigned"),
        location: normLabel(ledger.location, "Unknown"),
        jobTitle: ledger.jobTitle,
        active: ledger.active,
        amountUsd: e.amountUsd,
        paidOn: e.paidOn,
        periodLabel: e.periodLabel,
        note: e.note,
        createdAt: e.createdAt,
      });
    }
  }
  return out.sort((a, b) => b.paidOn.localeCompare(a.paidOn) || b.createdAt.localeCompare(a.createdAt));
}

export function buildBonusAnalyticsReport(
  ledgers: EmployeeCompensationLedger[],
  ledgerUpdatedAt: string | null,
): BonusAnalyticsReport {
  const allPayments = flattenBonusPayments(ledgers);
  const totalPaid = allPayments.reduce((s, p) => s + p.amountUsd, 0);
  const paymentCount = allPayments.length;
  const employeeIds = new Set(allPayments.map((p) => p.employeeId));

  const teamMap = new Map<string, { total: number; count: number; employees: Set<string> }>();
  const locationMap = new Map<string, { total: number; count: number; employees: Set<string> }>();
  const monthMap = new Map<string, { total: number; count: number }>();
  const weekMap = new Map<string, { total: number; count: number }>();
  const dayMap = new Map<string, { total: number; count: number }>();
  const recipientMap = new Map<
    string,
    { name: string; team: string; location: string; total: number; count: number }
  >();

  for (const p of allPayments) {
    const team = teamMap.get(p.team) ?? { total: 0, count: 0, employees: new Set<string>() };
    team.total += p.amountUsd;
    team.count += 1;
    team.employees.add(p.employeeId);
    teamMap.set(p.team, team);

    const loc = locationMap.get(p.location) ?? { total: 0, count: 0, employees: new Set<string>() };
    loc.total += p.amountUsd;
    loc.count += 1;
    loc.employees.add(p.employeeId);
    locationMap.set(p.location, loc);

    const mk = monthKey(p.paidOn);
    const mo = monthMap.get(mk) ?? { total: 0, count: 0 };
    mo.total += p.amountUsd;
    mo.count += 1;
    monthMap.set(mk, mo);

    const wk = weekStartIso(p.paidOn);
    const we = weekMap.get(wk) ?? { total: 0, count: 0 };
    we.total += p.amountUsd;
    we.count += 1;
    weekMap.set(wk, we);

    const dy = dayMap.get(p.paidOn) ?? { total: 0, count: 0 };
    dy.total += p.amountUsd;
    dy.count += 1;
    dayMap.set(p.paidOn, dy);

    const rec = recipientMap.get(p.employeeId) ?? {
      name: p.employeeName,
      team: p.team,
      location: p.location,
      total: 0,
      count: 0,
    };
    rec.total += p.amountUsd;
    rec.count += 1;
    recipientMap.set(p.employeeId, rec);
  }

  const byTeam = [...teamMap.entries()]
    .map(([team, v]) => ({ team, total: v.total, count: v.count, employees: v.employees.size }))
    .sort((a, b) => b.total - a.total);

  const byLocation = [...locationMap.entries()]
    .map(([location, v]) => ({ location, total: v.total, count: v.count, employees: v.employees.size }))
    .sort((a, b) => b.total - a.total);

  const byMonth = [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({ key, label: monthLabel(key), total: v.total, count: v.count }));

  const byWeek = [...weekMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({ key, label: weekLabel(key), total: v.total, count: v.count }));

  const byDay = [...dayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => ({ key, label: dayLabel(key), total: v.total, count: v.count }));

  const topRecipients = [...recipientMap.entries()]
    .map(([employeeId, v]) => ({
      employeeId,
      name: v.name,
      team: v.team,
      location: v.location,
      total: v.total,
      count: v.count,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    generatedAt: new Date().toISOString(),
    ledgerUpdatedAt,
    summary: {
      totalPaid,
      paymentCount,
      employeeCount: employeeIds.size,
      teamCount: teamMap.size,
      locationCount: locationMap.size,
      avgPerPayment: paymentCount ? totalPaid / paymentCount : 0,
    },
    byTeam,
    byLocation,
    byMonth,
    byWeek,
    byDay,
    topRecipients,
    recentPayments: allPayments.slice(0, 20),
    allPayments,
  };
}

export function filterBonusAnalytics(
  report: BonusAnalyticsReport,
  filters: { team?: string; location?: string; activeOnly?: boolean },
): BonusAnalyticsReport {
  let payments = report.allPayments;
  if (filters.activeOnly) payments = payments.filter((p) => p.active);
  if (filters.team && filters.team !== "__all__") {
    payments = payments.filter((p) => p.team === filters.team);
  }
  if (filters.location && filters.location !== "__all__") {
    payments = payments.filter((p) => p.location === filters.location);
  }

  const fakeLedgers: EmployeeCompensationLedger[] = [];
  const byEmployee = new Map<string, EmployeeCompensationLedger>();
  for (const p of payments) {
    let ledger = byEmployee.get(p.employeeId);
    if (!ledger) {
      ledger = {
        employeeId: p.employeeId,
        employeeName: p.employeeName,
        officialEmail: "",
        jobTitle: p.jobTitle,
        team: p.team,
        location: p.location,
        active: p.active,
        bonusEvents: [],
        shareEvents: [],
        updatedAt: p.createdAt,
      };
      byEmployee.set(p.employeeId, ledger);
      fakeLedgers.push(ledger);
    }
    ledger.bonusEvents.push({
      id: p.eventId,
      amountUsd: p.amountUsd,
      paidOn: p.paidOn,
      periodLabel: p.periodLabel,
      note: p.note,
      createdAt: p.createdAt,
    });
  }

  return buildBonusAnalyticsReport(fakeLedgers, report.ledgerUpdatedAt);
}
