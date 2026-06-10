import { emailLookupKeys } from "@/lib/cintara-email";

export const WEEKLY_HOURS_TARGET = 35;

export function formatActiveLabel(active: boolean): "Yes" | "No" {
  return active ? "Yes" : "No";
}

export type WeeklyPacingStatus = "target_met" | "on_track" | "behind" | "at_risk" | "critical";

export type WeeklyPacingRow = {
  id: string;
  email: string;
  name: string;
  title: string;
  location: string | null;
  team: string | null;
  managerName: string | null;
  managerEmail: string | null;
  hoursWorked: number;
  /** Average daily hours across Mon–Thu sample days (elapsed only). */
  avgDailyPace: number;
  hoursRemaining: number;
  /** Hours above the weekly target (0 when under target). */
  hoursOver: number;
  /**
   * Mon–Thu sample total + daily average. Mon–Thu equals hours worked + avg; on Friday compares Mon–Thu projection vs actual week hours.
   */
  projectedPace: number;
  /** @deprecated alias for projectedPace */
  hoursExpected: number;
  /** projectedPace minus weekly target (for status / sorting). */
  paceDelta: number;
  remainingWorkDays: number;
  requiredHoursPerDay: number;
  weekProgressPct: number;
  metTarget: boolean;
  /** Present on the Cintara Google Workspace domain roster. */
  active: boolean;
  status: WeeklyPacingStatus;
};

export type WeeklyPacingSortField =
  | "name"
  | "location"
  | "team"
  | "managerName"
  | "hoursWorked"
  | "avgDailyPace"
  | "hoursRemaining"
  | "hoursOver"
  | "projectedPace"
  | "hoursExpected"
  | "paceDelta"
  | "remainingWorkDays"
  | "requiredHoursPerDay"
  | "active"
  | "status";

export type WeeklyPacingReport = {
  company: { id: string; name: string };
  targetHours: number;
  timeZone: string;
  timeZoneLabel: string;
  today: string;
  week: { start: string; end: string };
  /** Mon–Thu days included in the pace average (elapsed only). */
  pacingSampleDays: string[];
  elapsedWorkDays: number;
  totalWorkDays: number;
  remainingWorkDays: number;
  generatedAt: string;
  rows: WeeklyPacingRow[];
  warnings: string[];
};

export type WeeklyHoursTrendPoint = {
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
  employeeCount: number;
  avgHoursWorked: number;
  totalHoursWorked: number;
  isCurrentWeek: boolean;
};

export type WeeklyHoursTrendReport = {
  company: { id: string; name: string };
  targetHours: number;
  timeZoneLabel: string;
  weekCount: number;
  filters: { location: string; team: string; active: string };
  points: WeeklyHoursTrendPoint[];
  /** Average of all weeks before the latest point. */
  priorAverageHours: number;
  latestWeek: WeeklyHoursTrendPoint | null;
  liftHours: number;
  liftPct: number;
  generatedAt: string;
  warnings: string[];
};

function parseIso(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

export function addDaysIso(iso: string, days: number): string {
  const d = parseIso(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isWeekdayIso(iso: string): boolean {
  const dow = parseIso(iso).getUTCDay();
  return dow >= 1 && dow <= 5;
}

export function enumerateDaysIso(start: string, end: string): string[] {
  if (start > end) return [];
  const out: string[] = [];
  for (let day = start; day <= end; day = addDaysIso(day, 1)) {
    out.push(day);
  }
  return out;
}

export function countWeekdaysInclusive(start: string, end: string): number {
  return enumerateDaysIso(start, end).filter(isWeekdayIso).length;
}

export function weekEndIso(weekStart: string): string {
  return addDaysIso(weekStart, 6);
}

/** Monday of the ISO week containing `day`. */
export function weekStartIso(day: string): string {
  const d = parseIso(day);
  const dow = d.getUTCDay();
  const daysFromMonday = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysFromMonday);
  return d.toISOString().slice(0, 10);
}

export function pacingTodayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export type WeeklyPacingWeekPresetId =
  | "this_week"
  | "last_week"
  | "two_weeks_ago"
  | "three_weeks_ago"
  | "four_weeks_ago";

export const WEEKLY_PACING_WEEK_PRESETS: Array<{ id: WeeklyPacingWeekPresetId; label: string }> = [
  { id: "this_week", label: "This week" },
  { id: "last_week", label: "Last week" },
  { id: "two_weeks_ago", label: "2 weeks ago" },
  { id: "three_weeks_ago", label: "3 weeks ago" },
  { id: "four_weeks_ago", label: "4 weeks ago" },
];

/** Pick a representative day for a week preset (Friday for past weeks, today for current). */
export function resolvePacingWeekPreset(
  preset: WeeklyPacingWeekPresetId,
  ref = pacingTodayIso(),
): string {
  const monday = weekStartIso(ref);
  switch (preset) {
    case "this_week":
      return ref;
    case "last_week":
      return addDaysIso(monday, -3);
    case "two_weeks_ago":
      return addDaysIso(monday, -10);
    case "three_weeks_ago":
      return addDaysIso(monday, -17);
    case "four_weeks_ago":
      return addDaysIso(monday, -24);
    default:
      return ref;
  }
}

/**
 * Rollup anchor for Time Doctor: past weeks use Friday (full-week snapshot);
 * current week uses the selected day capped at today.
 */
export function resolvePacingRollupDay(selectedDay: string, today = pacingTodayIso()): string {
  if (selectedDay > today) return today;
  const weekStart = weekStartIso(selectedDay);
  const friday = fridayOfWeek(weekStart);
  const currentWeekStart = weekStartIso(today);
  if (weekStart < currentWeekStart) return friday;
  return selectedDay;
}

export type WeeklyPacingFacetFilters = {
  location?: string;
  team?: string;
  active?: string;
};

export function pacingFilterExportSlug(filters: WeeklyPacingFacetFilters): string {
  const parts: string[] = [];
  if (filters.location && filters.location !== "__all__") {
    parts.push(filters.location === "__empty__" ? "no-location" : filters.location.toLowerCase());
  }
  if (filters.team && filters.team !== "__all__") {
    parts.push(filters.team === "__empty__" ? "no-team" : filters.team.toLowerCase());
  }
  if (filters.active && filters.active !== "__all__") {
    parts.push(filters.active === "yes" ? "active" : "inactive");
  }
  return parts.join("-");
}

export function pacingFilterSummaryLabel(filters: WeeklyPacingFacetFilters): string | null {
  const parts: string[] = [];
  if (filters.location && filters.location !== "__all__") {
    parts.push(`Location: ${filters.location === "__empty__" ? "Not set" : filters.location}`);
  }
  if (filters.team && filters.team !== "__all__") {
    parts.push(`Team: ${filters.team === "__empty__" ? "Not set" : filters.team}`);
  }
  if (filters.active && filters.active !== "__all__") {
    parts.push(filters.active === "yes" ? "Active only" : "Inactive only");
  }
  return parts.length ? parts.join(" · ") : null;
}

export function filterPacingRows(rows: WeeklyPacingRow[], query: string): WeeklyPacingRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => {
    const hay = [
      r.name,
      r.email,
      r.title,
      r.location ?? "",
      r.team ?? "",
      r.managerName ?? "",
      r.managerEmail ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

/** Thursday of the ISO week when weekStart is Monday. */
export function thursdayOfWeek(weekStart: string): string {
  return addDaysIso(weekStart, 3);
}

export function fridayOfWeek(weekStart: string): string {
  return addDaysIso(weekStart, 4);
}

/** Weekdays from tomorrow through Friday (inclusive). On Thursday → 1 (Friday only). */
export function remainingWeekdaysUntilFriday(today: string, weekStart: string): number {
  const friday = fridayOfWeek(weekStart);
  if (today >= friday) return 0;
  const tomorrow = addDaysIso(today, 1);
  if (tomorrow > friday) return 0;
  return countWeekdaysInclusive(tomorrow, friday);
}

/** Elapsed Mon–Thu weekdays used for the pace average. */
export function pacingSampleDays(weekStart: string, today: string): string[] {
  const thu = thursdayOfWeek(weekStart);
  const sampleEnd = today <= thu ? today : thu;
  if (sampleEnd < weekStart) return [];
  return enumerateDaysIso(weekStart, sampleEnd).filter(isWeekdayIso);
}

export type WeekPacingContext = {
  weekStart: string;
  today: string;
  targetHours?: number;
};

export type WeekPacingMetrics = {
  targetHours: number;
  weekEnd: string;
  pacingSampleDays: string[];
  elapsedWorkDays: number;
  totalWorkDays: number;
  remainingWorkDays: number;
  weekProgressPct: number;
};

export function computeWeekPacingMetrics(ctx: WeekPacingContext): WeekPacingMetrics {
  const targetHours = ctx.targetHours ?? WEEKLY_HOURS_TARGET;
  const weekEnd = weekEndIso(ctx.weekStart);
  const sampleDays = pacingSampleDays(ctx.weekStart, ctx.today);
  const elapsedWorkDays = countWeekdaysInclusive(ctx.weekStart, ctx.today);
  const totalWorkDays = countWeekdaysInclusive(ctx.weekStart, weekEnd);
  const tomorrow = addDaysIso(ctx.today, 1);
  const remainingWorkDays = countWeekdaysInclusive(tomorrow, weekEnd);
  const weekProgressPct =
    totalWorkDays > 0 ? Math.round((elapsedWorkDays / totalWorkDays) * 1000) / 10 : 0;

  return {
    targetHours,
    weekEnd,
    pacingSampleDays: sampleDays,
    elapsedWorkDays,
    totalWorkDays,
    remainingWorkDays,
    weekProgressPct,
  };
}

/** Friday or later in the work week (pace uses Mon–Thu sample, not today's hours). */
export function isFridayOrLater(today: string, weekStart: string): boolean {
  return today >= fridayOfWeek(weekStart);
}

export function computePaceFromDailyHours(args: {
  dailyHours: number[];
  targetHours: number;
}): {
  avgDailyPace: number;
  projectedPace: number;
  paceDelta: number;
} {
  const { dailyHours, targetHours } = args;
  const sampleCount = dailyHours.length;
  const hoursThroughSample = dailyHours.reduce((s, h) => s + h, 0);
  const avgDailyPace =
    sampleCount > 0
      ? Math.round((hoursThroughSample / sampleCount) * 100) / 100
      : 0;

  const projectedPace = Math.round((hoursThroughSample + avgDailyPace) * 100) / 100;
  const paceDelta = Math.round((projectedPace - targetHours) * 100) / 100;

  return { avgDailyPace, projectedPace, paceDelta };
}

export function resolvePacingStatus(args: {
  hoursWorked: number;
  projectedPace: number;
  hoursRemaining: number;
  remainingWorkDays: number;
  targetHours: number;
}): WeeklyPacingStatus {
  const { hoursWorked, projectedPace, hoursRemaining, remainingWorkDays, targetHours } = args;
  if (hoursWorked >= targetHours) return "target_met";
  if (projectedPace >= targetHours) return "on_track";
  if (remainingWorkDays <= 0 && hoursRemaining > 0) return "critical";
  if (projectedPace < targetHours * 0.65 || (remainingWorkDays <= 1 && hoursRemaining > 8)) {
    return "critical";
  }
  if (projectedPace < targetHours * 0.85) return "at_risk";
  if (projectedPace < targetHours - 0.5) return "behind";
  return "on_track";
}

export function buildPacingRow(args: {
  id: string;
  email: string;
  name: string;
  title: string;
  weeklySeconds: number;
  dailyHours: number[];
  metrics: WeekPacingMetrics;
  today: string;
  weekStart: string;
}): WeeklyPacingRow | null {
  if (!args.email.trim()) return null;

  const hoursWorked = Math.round((args.weeklySeconds / 3600) * 100) / 100;
  const { targetHours, remainingWorkDays } = args.metrics;
  const metTarget = hoursWorked >= targetHours;

  const { avgDailyPace, projectedPace, paceDelta } = computePaceFromDailyHours({
    dailyHours: args.dailyHours,
    targetHours,
  });

  const hoursRemaining = metTarget
    ? 0
    : Math.round((targetHours - hoursWorked) * 100) / 100;
  const hoursOver = metTarget
    ? Math.round((hoursWorked - targetHours) * 100) / 100
    : 0;
  const requiredHoursPerDay = metTarget
    ? 0
    : remainingWorkDays > 0
      ? Math.round((hoursRemaining / remainingWorkDays) * 100) / 100
      : hoursRemaining;

  return {
    id: args.id,
    email: args.email,
    name: args.name,
    title: args.title,
    location: null,
    team: null,
    managerName: null,
    managerEmail: null,
    hoursWorked,
    avgDailyPace,
    hoursRemaining,
    hoursOver,
    projectedPace,
    hoursExpected: projectedPace,
    paceDelta,
    remainingWorkDays,
    requiredHoursPerDay,
    weekProgressPct: args.metrics.weekProgressPct,
    metTarget,
    active: false,
    status: resolvePacingStatus({
      hoursWorked,
      projectedPace,
      hoursRemaining,
      remainingWorkDays,
      targetHours,
    }),
  };
}

export const PACING_STATUS_LABEL: Record<WeeklyPacingStatus, string> = {
  target_met: "Target met",
  on_track: "On track",
  behind: "Behind",
  at_risk: "At risk",
  critical: "Critical",
};

function normEmailKey(email: string): string {
  return String(email || "").trim().toLowerCase();
}

function normPersonName(name: string): string {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type PacingStatusLookup = {
  byEmail: Map<string, string>;
  byLocalPart: Map<string, string>;
  byName: Map<string, string>;
};

/** Index weekly pacing rows for roster / export lookups (same labels as the pacing table). */
export function buildPacingStatusLookup(rows: WeeklyPacingRow[]): PacingStatusLookup {
  const byEmail = new Map<string, string>();
  const byLocalPart = new Map<string, string>();
  const byName = new Map<string, string>();

  for (const row of rows) {
    const label = PACING_STATUS_LABEL[row.status];
    for (const key of emailLookupKeys(row.email)) {
      if (key.includes("@")) byEmail.set(key, label);
      else byLocalPart.set(key, label);
    }
    const nn = normPersonName(row.name);
    if (nn) byName.set(nn, label);
  }

  return { byEmail, byLocalPart, byName };
}

/** Resolve pacing status label for a roster row; returns `NA` when absent from the pacing report. */
export function lookupPacingStatus(
  lookup: PacingStatusLookup,
  args: { email?: string; name?: string },
): string {
  const email = normEmailKey(args.email ?? "");
  if (email && email !== "no email found") {
    for (const key of emailLookupKeys(email)) {
      const direct = key.includes("@") ? lookup.byEmail.get(key) : lookup.byLocalPart.get(key);
      if (direct) return direct;
    }
  }

  const nn = normPersonName(args.name ?? "");
  if (nn) {
    const byName = lookup.byName.get(nn);
    if (byName) return byName;
  }

  return "NA";
}

const STATUS_SORT_ORDER: Record<WeeklyPacingStatus, number> = {
  critical: 0,
  at_risk: 1,
  behind: 2,
  on_track: 3,
  target_met: 4,
};

export function sortPacingRows(
  rows: WeeklyPacingRow[],
  sortBy: WeeklyPacingSortField,
  sortDir: "asc" | "desc",
): WeeklyPacingRow[] {
  const dir = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case "name":
        cmp = a.name.localeCompare(b.name) || a.email.localeCompare(b.email);
        break;
      case "managerName":
        cmp =
          (a.managerName || "").localeCompare(b.managerName || "") ||
          a.name.localeCompare(b.name);
        break;
      case "location":
        cmp =
          (a.location || "").localeCompare(b.location || "") || a.name.localeCompare(b.name);
        break;
      case "team":
        cmp = (a.team || "").localeCompare(b.team || "") || a.name.localeCompare(b.name);
        break;
      case "status":
        cmp = STATUS_SORT_ORDER[a.status] - STATUS_SORT_ORDER[b.status];
        break;
      case "active":
        cmp = Number(a.active) - Number(b.active);
        break;
      case "hoursExpected":
        cmp = a.projectedPace - b.projectedPace;
        break;
      default:
        cmp = a[sortBy] - b[sortBy];
    }
    return cmp * dir;
  });
}
