import {
  endOfMonth,
  format,
  parseISO,
  startOfMonth,
  subDays,
  subMonths,
  subYears,
} from "date-fns";

export const MAX_TIME_DASHBOARD_RANGE_DAYS = 366;

export type TimeDashboardPresetId =
  | "last_14_days"
  | "this_month"
  | "last_month"
  | "last_3_months"
  | "last_6_months"
  | "past_year";

export const TIME_DASHBOARD_PRESETS: Array<{ id: TimeDashboardPresetId; label: string }> = [
  { id: "last_14_days", label: "Last 14 days" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "last_3_months", label: "Last 3 months" },
  { id: "last_6_months", label: "Last 6 months" },
  { id: "past_year", label: "Past 12 months" },
];

export function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

export function todayIso(): string {
  return format(new Date(), "yyyy-MM-dd");
}

export function enumerateDays(start: string, end: string): string[] {
  const out: string[] = [];
  const s = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  for (let d = s; d <= e; d = new Date(d.getTime() + 86400000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Clamp wide ranges so Time Doctor aggregation stays responsive. */
export function clampRange(start: string, end: string): { start: string; end: string; clipped: boolean } {
  const days = enumerateDays(start, end);
  if (days.length <= MAX_TIME_DASHBOARD_RANGE_DAYS) {
    return { start, end, clipped: false };
  }
  return {
    start: days[days.length - MAX_TIME_DASHBOARD_RANGE_DAYS]!,
    end,
    clipped: true,
  };
}

export function resolvePresetRange(
  preset: TimeDashboardPresetId,
  ref: Date = new Date(),
): { start: string; end: string } {
  const end = format(ref, "yyyy-MM-dd");
  switch (preset) {
    case "last_14_days":
      return { start: format(subDays(ref, 13), "yyyy-MM-dd"), end };
    case "this_month":
      return { start: format(startOfMonth(ref), "yyyy-MM-dd"), end };
    case "last_month": {
      const prev = subMonths(ref, 1);
      return {
        start: format(startOfMonth(prev), "yyyy-MM-dd"),
        end: format(endOfMonth(prev), "yyyy-MM-dd"),
      };
    }
    case "last_3_months":
      return { start: format(subMonths(ref, 3), "yyyy-MM-dd"), end };
    case "last_6_months":
      return { start: format(subMonths(ref, 6), "yyyy-MM-dd"), end };
    case "past_year":
      return { start: format(subYears(ref, 1), "yyyy-MM-dd"), end };
    default:
      return { start: format(subDays(ref, 13), "yyyy-MM-dd"), end };
  }
}

export function defaultListRange(ref: Date = new Date()): { start: string; end: string } {
  return resolvePresetRange("this_month", ref);
}

export function defaultDetailRange(ref: Date = new Date()): { start: string; end: string } {
  return resolvePresetRange("this_month", ref);
}

export function formatRangeLabel(start: string, end: string): string {
  if (start === end) {
    return new Date(start + "T12:00:00").toLocaleDateString("en", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  const s = new Date(start + "T12:00:00");
  const e = new Date(end + "T12:00:00");
  const sameYear = s.getFullYear() === e.getFullYear();
  const a = s.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  const b = e.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
  return `${a} – ${b}`;
}

export function formatMonthLabel(monthKey: string): string {
  const d = parseISO(`${monthKey}-01`);
  return d.toLocaleDateString("en", { month: "long", year: "numeric" });
}
