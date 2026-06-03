import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { format, parseISO, startOfWeek, subDays } from "date-fns";
import { clampRange, defaultDetailRange, defaultListRange } from "@/lib/time-dashboard-range";

/**
 * Server-only Time Doctor integration.
 *
 * Mirrors `workforce_analytics` behavior: fetch users + worklogs + poor-time + absent/late
 * and returns an aggregated dashboard payload.
 *
 * SECURITY: tokens must be provided via server env vars, never VITE_ client envs.
 */

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const DashboardInput = z.object({
  start: DateSchema.optional(),
  end: DateSchema.optional(),
});

type DashboardRange = { start: string; end: string };

type DashboardEmployee = {
  id: string;
  name: string;
  email: string;
  title: string;
  dailySeconds: number;
  productiveSeconds: number;
  poorSeconds: number;
  attendanceToday: "present" | "late" | "absent";
  productivityScore: number; // 0..1
  trend7d: Array<{ day: string; productiveSeconds: number; poorSeconds: number }>;
};

export type TimeDoctorDashboard = {
  company: { id: string; name: string };
  range: DashboardRange;
  warnings: string[];
  kpis: {
    activeEmployees: number;
    avgProductivityScore: number;
    totalSeconds: number;
    absentLateToday: { absent: number; late: number };
    overallScore: number;
  };
  employees: DashboardEmployee[];
};

const EmployeesTableInput = z.object({
  day: DateSchema.optional(), // YYYY-MM-DD (end anchor for daily / week / calendar month)
  start: DateSchema.optional(),
  end: DateSchema.optional(),
});

export type TimeDoctorEmployeeRow = {
  id: string;
  name: string;
  email: string;
  title: string;
  dailySeconds: number;
  weeklySeconds: number;
  monthlySeconds: number;
  /** Productive work seconds between range start and end (selected period). */
  rangeSeconds: number;
};

const UserDetailInput = z.object({
  userId: z.string().min(1),
  start: DateSchema.optional(),
  end: DateSchema.optional(),
  tab: z.enum(["overview", "attendance", "apps", "work"]).optional(),
});

export type TimeDoctorUserDetail = {
  company: { id: string; name: string };
  range: { start: string; end: string };
  user: { id: string; name: string; email: string; title: string };
  warnings: string[];
  rollups?: {
    daily: Array<{ day: string; productiveSeconds: number; poorSeconds: number }>;
    weekly: Array<{ week: string; productiveSeconds: number; poorSeconds: number }>;
    monthly: Array<{ month: string; productiveSeconds: number; poorSeconds: number }>;
  };
  overview?: {
    productiveSeconds: number;
    poorSeconds: number;
    productivityScore: number; // 0..1
    dailyTrend: Array<{ day: string; productiveSeconds: number; poorSeconds: number }>;
  };
  attendance?: {
    absentDays: number;
    lateDays: number;
    records: Array<{ date: string; status: "present" | "late" | "absent" }>;
  };
  apps?: {
    distribution: Array<{ category: "productive" | "neutral" | "distracting"; seconds: number }>;
    top: Array<{ name: string; category: "productive" | "neutral" | "distracting"; seconds: number }>;
  };
  work?: {
    timeByProject: Array<{ name: string; seconds: number }>;
    topTasks: Array<{ name: string; seconds: number }>;
  };
};

export const fetchTimeDoctorUserDetail = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => UserDetailInput.parse(data))
  .handler(async ({ data }) => {
    const range = getRange({ start: data.start, end: data.end });
    const tab = data.tab ?? "overview";
    const company = await getCompany();

    const users = await listUsers(company.id, ).catch(() => []);
    const user = users.find((u) => u.id === data.userId) ?? { id: data.userId, name: `Employee ${data.userId}`, email: "", title: "" };

    const warnings: string[] = [];
    if (range.clipped) {
      warnings.push("Date range was capped to 366 days for performance.");
    }

    if (tab === "apps") {
      const appUsage = await listCompanyAppUsage(company.id, range, data.userId, ).catch((e) => {
        warnings.push(`apps: ${String(e)}`);
        return [];
      });
      type AppCategory = NonNullable<TimeDoctorUserDetail["apps"]>["distribution"][number]["category"];
      const categoryTotals = new Map<AppCategory, number>();
      const toolTotals = new Map<string, { name: string; category: "productive" | "neutral" | "distracting"; seconds: number }>();
      for (const a of appUsage) {
        categoryTotals.set(a.category, (categoryTotals.get(a.category) ?? 0) + a.timeSpend);
        const key = `${a.category}:${a.name}`;
        const cur = toolTotals.get(key) ?? { name: a.name, category: a.category, seconds: 0 };
        cur.seconds += a.timeSpend;
        toolTotals.set(key, cur);
      }
      return {
        company,
        range,
        user: { id: user.id, name: user.name, email: user.email, title: user.title ?? "" },
        warnings,
        apps: {
          distribution: (["productive", "neutral", "distracting"] as const)
            .map((c) => ({ category: c, seconds: categoryTotals.get(c) ?? 0 }))
            .filter((x) => x.seconds > 0),
          top: Array.from(toolTotals.values()).sort((a, b) => b.seconds - a.seconds).slice(0, 12),
        },
      };
    }

    if (tab === "work") {
      const worklogs = await listCompanyWorklogs(company.id, range, data.userId, ).catch((e) => {
        warnings.push(`worklogs: ${String(e)}`);
        return [];
      });
      const byProject = new Map<string, number>();
      const byTask = new Map<string, number>();
      for (const w of worklogs) {
        if (w.projectName) byProject.set(w.projectName, (byProject.get(w.projectName) ?? 0) + w.totalSeconds);
        if (w.taskName) byTask.set(w.taskName, (byTask.get(w.taskName) ?? 0) + w.totalSeconds);
      }
      return {
        company,
        range,
        user: { id: user.id, name: user.name, email: user.email, title: user.title ?? "" },
        warnings,
        work: {
          timeByProject: Array.from(byProject.entries()).map(([name, seconds]) => ({ name, seconds })).sort((a, b) => b.seconds - a.seconds),
          topTasks: Array.from(byTask.entries()).map(([name, seconds]) => ({ name, seconds })).sort((a, b) => b.seconds - a.seconds).slice(0, 12),
        },
      };
    }

    if (tab === "attendance") {
      const attendance = await listAbsentLate(range, data.userId).catch((e) => {
        warnings.push(`absent-late: ${String(e)}`);
        return [];
      });
      const absentDays = attendance.filter((a) => a.status === "absent").length;
      const lateDays = attendance.filter((a) => a.status === "late").length;
      return {
        company,
        range,
        user: { id: user.id, name: user.name, email: user.email, title: user.title ?? "" },
        warnings,
        attendance: {
          absentDays,
          lateDays,
          records: attendance.map((a) => ({ date: a.date, status: a.status })),
        },
      };
    }

    // overview
    // Important: `/companies/{id}/worklogs` does not reliably honor `user_id` filtering for this token,
    // so pulling raw worklogs can require paging thousands of rows.
    // For a "cards + rollups" profile view (like your screenshots), we compute daily totals via per-day consolidated calls.
    const rollup = await buildUserRollups(company.id, range, data.userId, { warnings }).catch((e) => {
      warnings.push(`rollups: ${String(e)}`);
      return { daily: [], weekly: [], monthly: [], totals: { productiveSeconds: 0, poorSeconds: 0 } };
    });

    const productiveSeconds = rollup.totals.productiveSeconds;
    const poorSeconds = rollup.totals.poorSeconds;
    const prodScore = productivityScore(productiveSeconds, poorSeconds);

    return {
      company,
      range,
      user: { id: user.id, name: user.name, email: user.email, title: user.title ?? "" },
      warnings,
      rollups: { daily: rollup.daily, weekly: rollup.weekly, monthly: rollup.monthly },
      overview: {
        productiveSeconds,
        poorSeconds,
        productivityScore: prodScore,
        dailyTrend: rollup.daily,
      },
    };
  });

async function buildUserRollups(
  companyId: string,
  range: { start: string; end: string },
  userId: string,
  opts: { auth?: "auto_refresh" | "access_only"; warnings: string[] },
) {
  const days = enumerateDays(range.start, range.end);

  // Keep the UI responsive: run requests with a small concurrency cap.
  const concurrency = 6;
  const dailyRows: Array<{ day: string; productiveSeconds: number; poorSeconds: number }> = [];
  for (let i = 0; i < days.length; i += concurrency) {
    const chunk = days.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (day) => {
        const productiveSeconds = await fetchCompanyWorkSecondsForUserOnDay(companyId, day, userId, opts.auth).catch((e) => {
          opts.warnings.push(`worklogs(${day}): ${String(e)}`);
          return 0;
        });
        const poorSeconds = await fetchCompanyPoorSecondsForUserOnDay(companyId, day, userId, opts.auth).catch((e) => {
          opts.warnings.push(`poor-time(${day}): ${String(e)}`);
          return 0;
        });
        return { day, productiveSeconds, poorSeconds };
      }),
    );
    dailyRows.push(...results);
  }
  dailyRows.sort((a, b) => a.day.localeCompare(b.day));

  const totals = {
    productiveSeconds: dailyRows.reduce((s, r) => s + r.productiveSeconds, 0),
    poorSeconds: dailyRows.reduce((s, r) => s + r.poorSeconds, 0),
  };

  const weeklyMap = new Map<string, { week: string; productiveSeconds: number; poorSeconds: number }>();
  const monthlyMap = new Map<string, { month: string; productiveSeconds: number; poorSeconds: number }>();
  for (const r of dailyRows) {
    const d = new Date(r.day + "T00:00:00Z");
    const weekKey = isoWeekKey(d);
    const monthKey = r.day.slice(0, 7);
    const w = weeklyMap.get(weekKey) ?? { week: weekKey, productiveSeconds: 0, poorSeconds: 0 };
    w.productiveSeconds += r.productiveSeconds;
    w.poorSeconds += r.poorSeconds;
    weeklyMap.set(weekKey, w);
    const m = monthlyMap.get(monthKey) ?? { month: monthKey, productiveSeconds: 0, poorSeconds: 0 };
    m.productiveSeconds += r.productiveSeconds;
    m.poorSeconds += r.poorSeconds;
    monthlyMap.set(monthKey, m);
  }

  return {
    daily: dailyRows,
    weekly: Array.from(weeklyMap.values()).sort((a, b) => a.week.localeCompare(b.week)),
    monthly: Array.from(monthlyMap.values()).sort((a, b) => a.month.localeCompare(b.month)),
    totals,
  };
}

let cachedCompanyTimeZone: string | null = null;
let cachedCompanyTimeZoneLabel: string | null = null;

/** Time Doctor `company_time_zone` labels → IANA (handles US DST correctly). */
const TD_ZONE_LABEL_TO_IANA: Record<string, string> = {
  "(GMT-06:00) Central Time (US & Canada)": "America/Chicago",
  "(GMT-05:00) Eastern Time (US & Canada)": "America/New_York",
  "(GMT-08:00) Pacific Time (US & Canada)": "America/Los_Angeles",
  "(GMT-07:00) Mountain Time (US & Canada)": "America/Denver",
  "(GMT+05:30) India Standard Time": "Asia/Kolkata",
  "(GMT+00:00) UTC": "UTC",
};

function ianaFromTimeDoctorLabel(label: string): string | null {
  const trimmed = label.trim();
  if (TD_ZONE_LABEL_TO_IANA[trimmed]) return TD_ZONE_LABEL_TO_IANA[trimmed];
  if (/central time/i.test(trimmed)) return "America/Chicago";
  if (/eastern time/i.test(trimmed)) return "America/New_York";
  if (/pacific time/i.test(trimmed)) return "America/Los_Angeles";
  if (/mountain time/i.test(trimmed)) return "America/Denver";
  if (/india standard/i.test(trimmed)) return "Asia/Kolkata";
  return null;
}

function ingestCompanyTimeZone(acc: Record<string, unknown>) {
  const label = String(acc.company_time_zone ?? acc.companyTimeZone ?? "").trim();
  if (label) cachedCompanyTimeZoneLabel = label;
  const iana = label ? ianaFromTimeDoctorLabel(label) : null;
  if (iana) cachedCompanyTimeZone = iana;
}

function timeDoctorTimezone(): string {
  const envTz = process.env.TIME_DOCTOR_TIMEZONE?.trim();
  if (envTz) return envTz;
  if (cachedCompanyTimeZone) return cachedCompanyTimeZone;
  return "America/Chicago";
}

/** Calendar "today" in the company Time Doctor timezone (matches TD dashboards). */
export function timeDoctorTodayIso(ref: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeDoctorTimezone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ref);
}

export function getTimeDoctorTimezoneLabel(): string {
  return cachedCompanyTimeZoneLabel || timeDoctorTimezone();
}

function mergeSecondMaps(...maps: Array<Map<string, number>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of maps) {
    for (const [userId, seconds] of m.entries()) {
      out.set(userId, (out.get(userId) ?? 0) + (seconds ?? 0));
    }
  }
  return out;
}

function parseWorklogUserId(item: Record<string, unknown>): string | null {
  const raw = item.user_id ?? item.userId ?? item.user;
  if (raw == null || raw === "") return null;
  return String(raw);
}

function parseWorklogItemSeconds(item: Record<string, unknown>): number {
  const raw =
    item.length ??
    item.total_seconds ??
    item.totalSeconds ??
    item.seconds ??
    item.time ??
    item.duration ??
    0;
  if (typeof raw === "string") {
    if (/^\d+$/.test(raw.trim())) return Number.parseInt(raw, 10) || 0;
    const parts = raw.split(":").map((p) => Number.parseInt(p, 10));
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
    }
    return Number.parseFloat(raw) || 0;
  }
  return Number(raw) || 0;
}

function sumPoorTimeWebsiteSeconds(row: Record<string, unknown>): number {
  const pt = row.poor_time_website ?? row.poor_time ?? row.poorTime ?? null;
  if (!pt || typeof pt !== "object") return 0;
  let seconds = 0;
  for (const v of Object.values(pt as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const spend = (v as { timeSpend?: number; time_spend?: number }).timeSpend ??
      (v as { time_spend?: number }).time_spend ??
      0;
    seconds += Number.isFinite(Number(spend)) ? Number(spend) : 0;
  }
  return seconds;
}

async function listDailyPoorSecondsByUser(
  companyId: string,
  day: string,
  opts?: { auth?: "auto_refresh" | "access_only" },
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let offset = 0;
  const limit = 200;

  for (let i = 0; i < 2000; i++) {
    const payload = await upstreamFetch<unknown>(`/companies/${companyId}/poortime`, {
      params: {
        start_date: day,
        end_date: day,
        user_offset: offset,
        user_limit: limit,
        _format: "json",
      },
      auth: opts?.auth,
    });

    const rows = Array.isArray(payload) ? payload : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const uid = parseWorklogUserId(row as Record<string, unknown>);
      if (!uid) continue;
      const seconds = sumPoorTimeWebsiteSeconds(row as Record<string, unknown>);
      if (seconds > 0) out.set(uid, (out.get(uid) ?? 0) + seconds);
    }

    if (rows.length < limit) break;
    offset += limit;
  }

  return out;
}

async function sumPoorSecondsForDayRange(
  companyId: string,
  rangeStart: string,
  rangeEnd: string,
  opts?: { auth?: "auto_refresh" | "access_only" },
): Promise<Map<string, number>> {
  const days = enumerateDays(rangeStart, rangeEnd);
  const out = new Map<string, number>();
  const concurrency = 6;
  for (let i = 0; i < days.length; i += concurrency) {
    const chunk = days.slice(i, i + concurrency);
    const maps = await Promise.all(chunk.map((d) => listDailyPoorSecondsByUser(companyId, d, opts)));
    for (const m of maps) {
      for (const [userId, seconds] of m.entries()) {
        out.set(userId, (out.get(userId) ?? 0) + seconds);
      }
    }
  }
  return out;
}

async function listDailyTrackedSecondsByUser(
  companyId: string,
  day: string,
  opts?: { auth?: "auto_refresh" | "access_only" },
): Promise<Map<string, number>> {
  const [work, poor] = await Promise.all([
    listDailyWorkSecondsByUser(companyId, day, opts),
    listDailyPoorSecondsByUser(companyId, day, opts).catch(() => new Map<string, number>()),
  ]);
  return mergeSecondMaps(work, poor);
}

async function listWeekToDateTrackedSecondsByUser(
  companyId: string,
  day: string,
  opts?: { auth?: "auto_refresh" | "access_only" },
): Promise<Map<string, number>> {
  const weekStart = weekStartIso(day);
  const [work, poor] = await Promise.all([
    sumWorkSecondsForDayRange(companyId, weekStart, day, opts),
    sumPoorSecondsForDayRange(companyId, weekStart, day, opts).catch(() => new Map<string, number>()),
  ]);
  return mergeSecondMaps(work, poor);
}

async function listMonthToDateTrackedSecondsByUser(
  companyId: string,
  day: string,
  opts?: { auth?: "auto_refresh" | "access_only" },
): Promise<Map<string, number>> {
  const monthStart = `${day.slice(0, 8)}01`;
  const [work, poor] = await Promise.all([
    sumWorkSecondsForDayRange(companyId, monthStart, day, opts),
    sumPoorSecondsForDayRange(companyId, monthStart, day, opts).catch(() => new Map<string, number>()),
  ]);
  return mergeSecondMaps(work, poor);
}

async function listTrackedSecondsByUserForRange(
  companyId: string,
  rangeStart: string,
  rangeEnd: string,
  opts?: { auth?: "auto_refresh" | "access_only" },
): Promise<Map<string, number>> {
  const [work, poor] = await Promise.all([
    listWorkSecondsByUserForRange(companyId, rangeStart, rangeEnd, opts),
    sumPoorSecondsForDayRange(companyId, rangeStart, rangeEnd, opts).catch(() => new Map<string, number>()),
  ]);
  return mergeSecondMaps(work, poor);
}

function enumerateDays(start: string, end: string): string[] {
  const out: string[] = [];
  const s = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  for (let d = s; d <= e; d = new Date(d.getTime() + 86400000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function isoWeekKey(d: Date): string {
  // ISO week without extra deps: use UTC and shift to Thursday.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

async function fetchCompanyWorkSecondsForUserOnDay(
  companyId: string,
  day: string,
  userId: string,
  auth?: "auto_refresh" | "access_only",
): Promise<number> {
  type WorklogItem = { user_id?: string | number; length?: string | number };
  type WorklogsResponse = { worklogs?: { items?: WorklogItem[] } };

  const payload = await upstreamFetch<WorklogsResponse>(`/companies/${companyId}/worklogs`, {
    params: {
      start_date: day,
      end_date: day,
      offset: 0,
      limit: 500,
      consolidated: 1,
      breaks_only: 0,
      _format: "json",
    },
    auth,
  });

  const items = payload.worklogs?.items ?? [];
  let seconds = 0;
  for (const it of items) {
    if (it.user_id == null) continue;
    if (String(it.user_id) !== String(userId)) continue;
    const raw = it.length ?? 0;
    seconds += typeof raw === "string" ? Number.parseInt(raw, 10) || 0 : Number(raw) || 0;
  }
  return seconds;
}

async function fetchCompanyPoorSecondsForUserOnDay(
  companyId: string,
  day: string,
  userId: string,
  auth?: "auto_refresh" | "access_only",
): Promise<number> {
  const payload = await upstreamFetch<unknown>(`/companies/${companyId}/poortime`, {
    params: {
      start_date: day,
      end_date: day,
      user_id: userId,
      user_offset: 0,
      user_limit: 200,
      _format: "json",
    },
    auth,
  });

  // Observed payload shape (Time Doctor): array of user rows with `poor_time_website` map.
  if (Array.isArray(payload) && payload.length) {
    const row =
      payload.find((r: any) => r && (String(r.user_id ?? "") === String(userId))) ??
      payload[0];
    const pt = row?.poor_time_website ?? row?.poor_time ?? null;
    if (pt && typeof pt === "object") {
      let seconds = 0;
      for (const v of Object.values(pt as Record<string, any>)) {
        const s = typeof v?.timeSpend === "number" ? v.timeSpend : 0;
        seconds += Number.isFinite(s) ? s : 0;
      }
      return seconds;
    }
  }
  // Fallback: unknown shape, treat as zero.
  return 0;
}

export const fetchTimeDoctorEmployeesTable = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => EmployeesTableInput.parse(data))
  .handler(async ({ data }) => {
    const defaults = defaultListRange();
    const end = data.end ?? defaults.end;
    const start = data.start ?? defaults.start;
    /** Daily / weekly / monthly always anchor to company TZ "today", not the period end date. */
    const rollupDay = data.day ?? timeDoctorTodayIso();
    const period = clampRange(start, end);
    const company = await getCompany();

    const [usersR, dailyR, weeklyR, monthlyR, periodR] = await Promise.allSettled([
      listUsers(company.id, ),
      listDailyTrackedSecondsByUser(company.id, rollupDay, ),
      listWeekToDateTrackedSecondsByUser(company.id, rollupDay, ),
      listMonthToDateTrackedSecondsByUser(company.id, rollupDay, ),
      listTrackedSecondsByUserForRange(company.id, period.start, period.end, ),
    ]);

    const users = usersR.status === "fulfilled" ? usersR.value : [];
    const daily = dailyR.status === "fulfilled" ? dailyR.value : new Map<string, number>();
    const weekly = weeklyR.status === "fulfilled" ? weeklyR.value : new Map<string, number>();
    const monthly = monthlyR.status === "fulfilled" ? monthlyR.value : new Map<string, number>();
    const periodMap = periodR.status === "fulfilled" ? periodR.value : new Map<string, number>();

    const rows: TimeDoctorEmployeeRow[] = users
      .map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        title: u.title ?? "",
        dailySeconds: daily.get(u.id) ?? 0,
        weeklySeconds: weekly.get(u.id) ?? 0,
        monthlySeconds: monthly.get(u.id) ?? 0,
        rangeSeconds: periodMap.get(u.id) ?? 0,
      }))
      .sort((a, b) => (b.rangeSeconds ?? 0) - (a.rangeSeconds ?? 0));

    return {
      company,
      day: rollupDay,
      timeZone: company.timeZone ?? timeDoctorTimezone(),
      timeZoneLabel: company.timeZoneLabel ?? getTimeDoctorTimezoneLabel(),
      range: { start: period.start, end: period.end },
      warnings: [
        ...(period.clipped ? [`Range capped to last 366 days (requested ${start} → ${end}).`] : []),
        ...(usersR.status === "rejected" ? [`users: ${String(usersR.reason)}`] : []),
        ...(dailyR.status === "rejected" ? [`daily-worklogs: ${String(dailyR.reason)}`] : []),
        ...(weeklyR.status === "rejected" ? [`weekly-worklogs: ${String(weeklyR.reason)}`] : []),
        ...(monthlyR.status === "rejected" ? [`monthly-worklogs: ${String(monthlyR.reason)}`] : []),
        ...(periodR.status === "rejected" ? [`period-worklogs: ${String(periodR.reason)}`] : []),
      ].slice(0, 6),
      employees: rows,
    };
  });

export const fetchTimeDoctorDashboard = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => DashboardInput.parse(data))
  .handler(async ({ data }) => {
    const range = getRange(data);
    return await buildDashboard(range);
  });

function getRange(input: { start?: string; end?: string }): DashboardRange & { clipped?: boolean } {
  const defaults = defaultDetailRange();
  const end = input.end ?? defaults.end;
  const start = input.start ?? defaults.start;
  const period = clampRange(start, end);
  return { start: period.start, end: period.end, clipped: period.clipped };
}

function productivityScore(productiveSeconds: number, poorSeconds: number): number {
  const denom = productiveSeconds + poorSeconds;
  if (denom <= 0) return 0;
  return productiveSeconds / denom;
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

async function buildDashboard(range: DashboardRange): Promise<TimeDoctorDashboard> {
  const company = await getCompany();

  const [usersR, seededR, worklogsR, poorTimeR, attendanceR, dailySecondsByUserR] =
    await Promise.allSettled([
      listUsers(company.id),
      seedUsersFromWorklogs(company.id),
      listWorklogs(range),
      listPoorTime(range),
      listAbsentLate(range),
      listDailyTrackedSecondsByUser(company.id, timeDoctorTodayIso()),
    ]);

  const mergedUsers = new Map<string, { id: string; name: string; email: string; title: string }>();
  if (usersR.status === "fulfilled") {
    for (const u of usersR.value) {
      mergedUsers.set(u.id, { id: u.id, name: u.name, email: u.email ?? "", title: u.title ?? "" });
    }
  }
  if (seededR.status === "fulfilled") {
    for (const u of seededR.value) {
      if (mergedUsers.has(u.id)) continue;
      mergedUsers.set(u.id, { id: u.id, name: u.name, email: u.email ?? "", title: u.title ?? "" });
    }
  }
  const users = Array.from(mergedUsers.values()).sort((a, b) => a.name.localeCompare(b.name));

  const worklogs = worklogsR.status === "fulfilled" ? worklogsR.value : [];
  const poorTime = poorTimeR.status === "fulfilled" ? poorTimeR.value : [];
  const attendance = attendanceR.status === "fulfilled" ? attendanceR.value : [];
  const dailySecondsByUser =
    dailySecondsByUserR.status === "fulfilled" ? dailySecondsByUserR.value : new Map<string, number>();

  const wlByUser = groupBy(worklogs);
  const ptByUser = groupBy(poorTime);
  const attByUser = groupBy(attendance);

  const today = range.end;
  const sevenDaysStart = format(subDays(new Date(range.end), 6), "yyyy-MM-dd");
  const trendRange = { start: sevenDaysStart, end: range.end };

  const employees: DashboardEmployee[] = users.map((u) => {
    const wls = wlByUser.get(u.id) ?? [];
    const pts = ptByUser.get(u.id) ?? [];
    const atts = attByUser.get(u.id) ?? [];
    const attToday = atts.find((a) => a.date === today)?.status ?? "present";

    const productiveSeconds = wls.reduce((a, b) => a + (b.totalSeconds || 0), 0);
    const poorSeconds = pts.reduce((a, b) => a + (b.totalSeconds || 0), 0);

    const trendMap = new Map<string, { day: string; productiveSeconds: number; poorSeconds: number }>();
    for (const w of wls) {
      const d = w.startedAt.slice(0, 10);
      if (d < trendRange.start || d > trendRange.end) continue;
      const cur = trendMap.get(d) ?? { day: d, productiveSeconds: 0, poorSeconds: 0 };
      cur.productiveSeconds += w.totalSeconds || 0;
      trendMap.set(d, cur);
    }
    for (const p of pts) {
      const d = p.startedAt.slice(0, 10);
      if (d < trendRange.start || d > trendRange.end) continue;
      const cur = trendMap.get(d) ?? { day: d, productiveSeconds: 0, poorSeconds: 0 };
      cur.poorSeconds += p.totalSeconds || 0;
      trendMap.set(d, cur);
    }
    const trend7d = Array.from(trendMap.values()).sort((a, b) => a.day.localeCompare(b.day));

    const score = productivityScore(productiveSeconds, poorSeconds);

    return {
      id: u.id,
      name: u.name,
      email: u.email,
      title: u.title ?? "",
      dailySeconds: dailySecondsByUser.get(u.id) ?? 0,
      productiveSeconds,
      poorSeconds,
      attendanceToday: attToday,
      productivityScore: score,
      trend7d,
    };
  });

  const activeEmployees = employees.filter((e) => e.productiveSeconds + e.poorSeconds > 0).length;
  const avgProductivityScore =
    employees.length === 0 ? 0 : employees.reduce((a, e) => a + e.productivityScore, 0) / employees.length;
  const totalSeconds = employees.reduce((a, e) => a + e.productiveSeconds + e.poorSeconds, 0);
  const absentToday = employees.filter((e) => e.attendanceToday === "absent").length;
  const lateToday = employees.filter((e) => e.attendanceToday === "late").length;

  const overallScore = clamp01(avgProductivityScore);

  return {
    company,
    range,
    warnings: [
      ...(worklogsR.status === "rejected" ? [`worklogs: ${String(worklogsR.reason)}`] : []),
      ...(poorTimeR.status === "rejected" ? [`poor-time: ${String(poorTimeR.reason)}`] : []),
      ...(attendanceR.status === "rejected" ? [`absent-late: ${String(attendanceR.reason)}`] : []),
      ...(usersR.status === "rejected" ? [`users: ${String(usersR.reason)}`] : []),
    ].slice(0, 5),
    kpis: {
      activeEmployees,
      avgProductivityScore,
      totalSeconds,
      absentLateToday: { absent: absentToday, late: lateToday },
      overallScore,
    },
    employees,
  };
}

type User = { id: string; companyId: string; name: string; email: string; title?: string };
type Worklog = {
  id: string;
  userId: string;
  startedAt: string;
  endedAt: string;
  totalSeconds: number;
};
type PoorTime = {
  id: string;
  userId: string;
  startedAt: string;
  endedAt: string;
  totalSeconds: number;
};
type AbsentLate = { id: string; userId: string; date: string; status: "present" | "absent" | "late" };

function groupBy<T extends { userId: string }>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const arr = m.get(it.userId) ?? [];
    arr.push(it);
    m.set(it.userId, arr);
  }
  return m;
}

function timeDoctorEnv() {
  // Keep it very close to workforce_analytics naming.
  const API_BASE_URL = (process.env.API_BASE_URL ?? "").trim();
  const API_ACCESS_TOKEN = (process.env.API_ACCESS_TOKEN ?? "").trim();
  const API_REFRESH_TOKEN = (process.env.API_REFRESH_TOKEN ?? "").trim();
  const OAUTH_CLIENT_ID = (process.env.OAUTH_CLIENT_ID ?? "").trim();
  const OAUTH_CLIENT_SECRET = (process.env.OAUTH_CLIENT_SECRET ?? "").trim();
  const OAUTH_REDIRECT_URL = (process.env.OAUTH_REDIRECT_URL ?? "").trim();

  if (!API_BASE_URL) {
    throw new Error("Missing env API_BASE_URL (e.g. https://webapi.timedoctor.com/v1.1).");
  }
  // Access token is required unless we can refresh seamlessly.
  const canRefresh = !!API_REFRESH_TOKEN && !!OAUTH_CLIENT_ID && !!OAUTH_CLIENT_SECRET;
  if (!API_ACCESS_TOKEN && !canRefresh) {
    throw new Error(
      "Missing env API_ACCESS_TOKEN. Provide an access token or configure refresh (API_REFRESH_TOKEN, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET).",
    );
  }
  return {
    API_BASE_URL,
    API_ACCESS_TOKEN,
    API_REFRESH_TOKEN,
    OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET,
    OAUTH_REDIRECT_URL,
  };
}

type TokenState = { accessToken: string; refreshToken: string; expiresAtMs: number | null };
const tokenState: TokenState = { accessToken: "", refreshToken: "", expiresAtMs: null };
let refreshInFlight: Promise<string> | null = null;
let lastSuccessfulRefreshMs = 0;

/** Re-use refreshed access token within a warm server process (~45 min). */
const REFRESH_INTERVAL_MS = 45 * 60 * 1000;

export function canConfigureTimeDoctorRefresh() {
  try {
    const env = timeDoctorEnv();
    return !!(env.API_REFRESH_TOKEN && env.OAUTH_CLIENT_ID && env.OAUTH_CLIENT_SECRET);
  } catch {
    return false;
  }
}

function parseAccessTokenExpiresAtMs(): number | null {
  const raw = process.env.API_ACCESS_TOKEN_EXPIRES_AT?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 1e12 ? n : n * 1000;
  }
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

function initTokensOnce() {
  const env = timeDoctorEnv();
  // Always reflect latest env values (dev-friendly).
  tokenState.accessToken = env.API_ACCESS_TOKEN;
  tokenState.refreshToken = env.API_REFRESH_TOKEN || "";
  const envExpiry = parseAccessTokenExpiresAtMs();
  if (envExpiry != null) tokenState.expiresAtMs = envExpiry;
}

function shouldProactivelyRefresh(skewMs = 60_000): boolean {
  if (!tokenState.expiresAtMs) return false;
  return Date.now() + skewMs >= tokenState.expiresAtMs;
}

function shouldRefreshByAge(): boolean {
  if (!lastSuccessfulRefreshMs) return true;
  return Date.now() - lastSuccessfulRefreshMs >= REFRESH_INTERVAL_MS;
}

function tokenEndpointFromBaseUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  return `${u.origin}/oauth/v2/token`;
}

async function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    initTokensOnce();
    const env = timeDoctorEnv();
    const refreshToken = tokenState.refreshToken || env.API_REFRESH_TOKEN;
    if (!refreshToken) throw new Error("Missing API_REFRESH_TOKEN; cannot refresh.");
    if (!env.OAUTH_CLIENT_ID || !env.OAUTH_CLIENT_SECRET) {
      throw new Error("Missing OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET; cannot refresh.");
    }

    const tokenUrl = tokenEndpointFromBaseUrl(env.API_BASE_URL);
    // Time Doctor docs show refresh without redirect_uri:
    // `.../oauth/v2/token?client_id=...&client_secret=...&grant_type=refresh_token&refresh_token=...`
    // In practice some providers parse query, some parse body; we send BOTH, then fall back to GET.
    const params = new URLSearchParams();
    params.set("client_id", env.OAUTH_CLIENT_ID);
    params.set("client_secret", env.OAUTH_CLIENT_SECRET);
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", refreshToken);

    const postWithBodyAndQuery = async () => {
      const u = new URL(tokenUrl);
      for (const [k, v] of params.entries()) u.searchParams.set(k, v);
      const res = await fetch(u.toString(), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "alyson-hr/1.0",
        },
        body: params,
        cache: "no-store",
      });
      const text = await res.text().catch(() => "");
      return { res, text };
    };

    const getWithQuery = async () => {
      const u = new URL(tokenUrl);
      for (const [k, v] of params.entries()) u.searchParams.set(k, v);
      const res = await fetch(u.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "alyson-hr/1.0",
        },
        cache: "no-store",
      });
      const text = await res.text().catch(() => "");
      return { res, text };
    };

    let { res, text } = await postWithBodyAndQuery();
    if (!res.ok) ({ res, text } = await getWithQuery());

    if (!res.ok) {
      throw new Error(`OAuth refresh failed ${res.status} ${res.statusText}: ${text}`.slice(0, 2000));
    }

    const json = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
    const newAccessToken = (json.access_token ?? "").trim();
    if (!newAccessToken) throw new Error("OAuth refresh response missing access_token.");

    tokenState.accessToken = newAccessToken;
    if ((json.refresh_token ?? "").trim()) tokenState.refreshToken = (json.refresh_token ?? "").trim();
    if (typeof json.expires_in === "number" && Number.isFinite(json.expires_in)) {
      tokenState.expiresAtMs = Date.now() + Math.max(0, json.expires_in - 30) * 1000;
    } else {
      tokenState.expiresAtMs = Date.now() + 55 * 60 * 1000;
    }
    lastSuccessfulRefreshMs = Date.now();

    return tokenState.accessToken;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

async function upstreamFetch<T>(
  path: string,
  init?: RequestInit & { params?: Record<string, string | number | undefined>; auth?: "auto_refresh" | "access_only" },
): Promise<T> {
  initTokensOnce();
  const env = timeDoctorEnv();

  const url = new URL(path.replace(/^\//, ""), env.API_BASE_URL.replace(/\/+$/, "") + "/");
  if (init?.params) {
    for (const [k, v] of Object.entries(init.params)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const isTimeDoctorWebApi = url.host === "webapi.timedoctor.com";

  const doFetch = async (token: string) => {
    const attemptUrl = new URL(url);
    if (token && !attemptUrl.searchParams.has("access_token")) {
      attemptUrl.searchParams.set("access_token", token);
    }

    return fetch(attemptUrl, {
      ...init,
      method: init?.method ?? "GET",
      headers: {
        ...(init?.headers ?? {}),
        ...(!isTimeDoctorWebApi && token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: "application/json",
        "User-Agent": "alyson-hr/1.0",
      },
      cache: "no-store",
    });
  };

  const canRefresh =
    init?.auth !== "access_only" &&
    !!env.API_REFRESH_TOKEN &&
    !!env.OAUTH_CLIENT_ID &&
    !!env.OAUTH_CLIENT_SECRET;

  let token = tokenState.accessToken || env.API_ACCESS_TOKEN;

  if (canRefresh && (shouldRefreshByAge() || shouldProactivelyRefresh() || !token)) {
    try {
      token = await refreshAccessToken();
    } catch (refreshErr) {
      if (!token) {
        throw refreshErr instanceof Error ? refreshErr : new Error(String(refreshErr));
      }
    }
  }

  let res = await doFetch(token);
  let text = await res.text().catch(() => "");

  if (!res.ok && (res.status === 401 || res.status === 403)) {
    if (canRefresh) {
      try {
        const newToken = await refreshAccessToken();
        res = await doFetch(newToken);
        text = await res.text().catch(() => "");
      } catch (refreshErr) {
        throw refreshErr instanceof Error ? refreshErr : new Error(String(refreshErr));
      }
    }
  }

  if (!res.ok) throw new Error(`Upstream error ${res.status} ${res.statusText}: ${text}`.slice(0, 2000));
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Upstream returned non-JSON response: ${JSON.stringify(text.slice(0, 200))}`);
  }
}

async function fetchAllPages<T>(
  path: string,
  params: Record<string, string | number | undefined> & { offset?: number; limit?: number },
): Promise<T[]> {
  const limit = params.limit ?? 200;
  let offset = params.offset ?? 0;
  const out: T[] = [];

  for (let i = 0; i < 2000; i++) {
    const page = await upstreamFetch<unknown>(path, { params: { ...params, offset, limit } });
    const items = coerceArray<T>(page);
    out.push(...items);
    if (items.length < limit) break;
    offset += limit;
  }
  return out;
}

function coerceArray<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const any = payload as Record<string, unknown>;
    if (Array.isArray(any.items)) return any.items as T[];
    if (Array.isArray(any.data)) return any.data as T[];
    if (Array.isArray(any.results)) return any.results as T[];
    if (Array.isArray(any.users)) return any.users as T[];
    if (Array.isArray(any.projects)) return any.projects as T[];
    if (Array.isArray(any.tasks)) return any.tasks as T[];
    for (const v of Object.values(any)) {
      if (!v || typeof v !== "object") continue;
      const inner = v as Record<string, unknown>;
      if (Array.isArray(inner.items)) return inner.items as T[];
      if (Array.isArray(inner.data)) return inner.data as T[];
      if (Array.isArray(inner.results)) return inner.results as T[];
    }
  }
  return [];
}

async function getCompany(opts?: { auth?: "auto_refresh" | "access_only" }): Promise<{
  id: string;
  name: string;
  timeZone?: string;
  timeZoneLabel?: string;
}> {
  const payload = await upstreamFetch<unknown>("/companies", { auth: opts?.auth });
  if (payload && typeof payload === "object") {
    const any = payload as Record<string, unknown>;
    const accounts = any.accounts;
    if (Array.isArray(accounts) && accounts.length > 0) {
      const acc = accounts[0] as Record<string, unknown>;
      ingestCompanyTimeZone(acc);
      const id = acc.company_id ?? acc.companyId ?? acc.id;
      const name = acc.company_name ?? acc.companyName ?? acc.name;
      if (id != null && name != null) {
        return {
          id: String(id),
          name: String(name),
          timeZone: timeDoctorTimezone(),
          timeZoneLabel: getTimeDoctorTimezoneLabel(),
        };
      }
    }
  }
  return { id: "unknown", name: "Company", timeZone: timeDoctorTimezone(), timeZoneLabel: getTimeDoctorTimezoneLabel() };
}

async function listUsers(companyId?: string, opts?: { auth?: "auto_refresh" | "access_only" }): Promise<User[]> {
  if (!companyId) return [];
  return await listCompanyUsersFromApi(companyId, opts);
}

async function listCompanyUsersFromApi(companyId: string, opts?: { auth?: "auto_refresh" | "access_only" }): Promise<User[]> {
  const limit = 200;
  let offset = 0;
  const out: User[] = [];
  const seen = new Set<string>();
  let totalCount: number | undefined;

  for (let i = 0; i < 2000; i++) {
    const payload = await upstreamFetch<Record<string, unknown>>(`/companies/${companyId}/users`, {
      params: { _format: "json", offset, limit },
      auth: opts?.auth,
    });
    if (typeof payload.count === "number") totalCount = payload.count;
    const rawUsers = Array.isArray(payload.users) ? payload.users : [];

    for (const raw of rawUsers) {
      const u = normalizeUser(raw, companyId);
      if (!u) continue;
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      out.push(u);
    }

    if (rawUsers.length === 0) break;
    offset += rawUsers.length;
    if (typeof totalCount === "number" && offset >= totalCount) break;
    if (rawUsers.length < limit) break;
  }

  return out;
}

function normalizeUser(payload: unknown, defaultCompanyId?: string): User | null {
  if (!payload || typeof payload !== "object") return null;
  const any = payload as Record<string, unknown>;
  const id = any.id ?? any.user_id ?? any.userId;
  const companyIdRaw = any.company_id ?? any.companyId ?? any.company ?? defaultCompanyId;
  const fromFull = (any.full_name ?? any.fullName ?? any.name ?? any.display_name ?? any.displayName) as
    | string
    | undefined;
  const first = typeof any.first_name === "string" ? any.first_name.trim() : "";
  const last = typeof any.last_name === "string" ? any.last_name.trim() : "";
  const fromParts = [first, last].filter(Boolean).join(" ").trim();
  let name = ((fromFull && String(fromFull).trim()) || fromParts).trim();
  const emailRaw = any.email;
  const email = typeof emailRaw === "string" ? emailRaw.trim() : emailRaw != null ? String(emailRaw) : "";
  const title = (any.title ?? any.job_title ?? any.jobTitle) as string | undefined;
  if (id == null || companyIdRaw == null) return null;
  if (!name) {
    const local = email.includes("@") ? email.split("@")[0] : "";
    name = local || `User ${String(id)}`;
  }
  return { id: String(id), companyId: String(companyIdRaw), name: name.trim(), email, title };
}

async function listCompanyAppUsage(
  companyId: string,
  range: { start: string; end: string },
  userId: string,
  opts?: { auth?: "auto_refresh" | "access_only" },
): Promise<Array<{ name: string; category: "productive" | "neutral" | "distracting"; timeSpend: number }>> {
  type WebAndAppItem = { name?: string; timeSpend?: number; timeType?: "apps" | "websites" | string };
  type WebAndAppUser = { user_id?: number | string; websites_and_apps?: WebAndAppItem[] };

  const limit = 200;
  let offset = 0;
  const totals = new Map<string, { name: string; category: "productive" | "neutral" | "distracting"; timeSpend: number }>();

  for (let i = 0; i < 2000; i++) {
    const payload = await upstreamFetch<unknown>(`/companies/${companyId}/webandapp`, {
      params: {
        _format: "json",
        start_date: range.start,
        end_date: range.end,
        offset,
        limit,
        user_id: userId,
      },
      auth: opts?.auth,
    });

    const arr = Array.isArray(payload) ? (payload as WebAndAppUser[]) : [];
    const userRow = arr.find((u) => u.user_id != null && String(u.user_id) === String(userId)) ?? arr[0];
    const items = userRow?.websites_and_apps ?? [];

    for (const it of items) {
      const name = (it?.name ?? "").trim();
      if (!name) continue;
      const seconds = typeof it.timeSpend === "number" && Number.isFinite(it.timeSpend) ? it.timeSpend : 0;
      const category: "productive" | "neutral" | "distracting" =
        String(it.timeType ?? "").toLowerCase() === "websites" ? "productive" : "neutral";
      const key = `${category}:${name}`;
      const cur = totals.get(key) ?? { name, category, timeSpend: 0 };
      cur.timeSpend += seconds;
      totals.set(key, cur);
    }

    if (items.length < limit) break;
    offset += limit;
  }

  return Array.from(totals.values());
}

async function listCompanyWorklogs(
  companyId: string,
  range: { start: string; end: string },
  userId: string,
  opts?: { auth?: "auto_refresh" | "access_only" },
): Promise<Array<{ totalSeconds: number; projectName?: string; taskName?: string; startedAt?: string }>> {
  type WorklogItem = {
    length?: string | number;
    user_id?: string | number;
    project_name?: string;
    task_name?: string;
    start_time?: string;
    started_at?: string;
  };
  type WorklogsResponse = { worklogs?: { items?: WorklogItem[] } };

  const limit = 200;
  let offset = 0;
  const out: Array<{ totalSeconds: number; projectName?: string; taskName?: string; startedAt?: string }> = [];

  for (let i = 0; i < 2000; i++) {
    const payload = await upstreamFetch<WorklogsResponse>(`/companies/${companyId}/worklogs`, {
      params: {
        start_date: range.start,
        end_date: range.end,
        offset,
        limit,
        user_id: userId,
        consolidated: 0,
        breaks_only: 0,
        _format: "json",
      },
      auth: opts?.auth,
    });

    const items = payload.worklogs?.items ?? [];
    for (const it of items) {
      if (it.user_id != null && String(it.user_id) !== String(userId)) continue;
      const secondsRaw = it.length ?? 0;
      const totalSeconds =
        typeof secondsRaw === "string" ? Number.parseInt(secondsRaw, 10) || 0 : Number(secondsRaw) || 0;
      out.push({
        totalSeconds,
        projectName: it.project_name,
        taskName: it.task_name,
        startedAt: it.start_time ?? it.started_at,
      });
    }

    if (items.length < limit) break;
    offset += limit;
  }

  return out;
}

async function listCompanyPoorTime(
  companyId: string,
  range: { start: string; end: string },
  userId: string,
  opts?: { auth?: "auto_refresh" | "access_only" },
): Promise<Array<{ totalSeconds: number; startedAt?: string }>> {
  type PoorTimeItem = { user_id?: string | number; length?: string | number; start_time?: string; started_at?: string };
  type PoorTimeResponse = { poortime?: { items?: PoorTimeItem[] }; poor_time?: { items?: PoorTimeItem[] } };

  const limit = 200;
  let offset = 0;
  const out: Array<{ totalSeconds: number; startedAt?: string }> = [];

  for (let i = 0; i < 2000; i++) {
    const payload = await upstreamFetch<PoorTimeResponse>(`/companies/${companyId}/poortime`, {
      params: {
        start_date: range.start,
        end_date: range.end,
        user_offset: offset,
        user_limit: limit,
        user_id: userId,
        _format: "json",
      },
      auth: opts?.auth,
    });

    const items = payload.poortime?.items ?? payload.poor_time?.items ?? [];
    for (const it of items) {
      if (it.user_id != null && String(it.user_id) !== String(userId)) continue;
      const secondsRaw = it.length ?? 0;
      const totalSeconds =
        typeof secondsRaw === "string" ? Number.parseInt(secondsRaw, 10) || 0 : Number(secondsRaw) || 0;
      out.push({ totalSeconds, startedAt: it.start_time ?? it.started_at });
    }

    if (items.length < limit) break;
    offset += limit;
  }

  return out;
}

async function listWorklogs(range: DashboardRange, userId?: string): Promise<Worklog[]> {
  const raw = await fetchAllPages<any>("/worklogs", {
    limit: 500,
    offset: 0,
    userId,
    start: range.start,
    end: range.end,
  });
  return raw
    .map((x) => normalizeWorklog(x))
    .filter((x): x is Worklog => x !== null);
}

function normalizeWorklog(payload: any): Worklog | null {
  if (!payload || typeof payload !== "object") return null;
  const id = payload.id ?? payload.worklog_id ?? payload.worklogId;
  const userId = payload.userId ?? payload.user_id;
  const startedAt = payload.startedAt ?? payload.started_at ?? payload.start_time ?? payload.start;
  const endedAt = payload.endedAt ?? payload.ended_at ?? payload.end_time ?? payload.end;
  const totalSecondsRaw = payload.totalSeconds ?? payload.total_seconds ?? payload.length ?? payload.seconds ?? 0;
  if (id == null || userId == null || !startedAt || !endedAt) return null;
  const totalSeconds =
    typeof totalSecondsRaw === "string" ? Number.parseInt(totalSecondsRaw, 10) || 0 : Number(totalSecondsRaw) || 0;
  return { id: String(id), userId: String(userId), startedAt: String(startedAt), endedAt: String(endedAt), totalSeconds };
}

async function listPoorTime(range: DashboardRange, userId?: string): Promise<PoorTime[]> {
  const raw = await fetchAllPages<any>("/poor-time", {
    limit: 500,
    offset: 0,
    userId,
    start: range.start,
    end: range.end,
  });
  return raw
    .map((x) => normalizePoorTime(x))
    .filter((x): x is PoorTime => x !== null);
}

function normalizePoorTime(payload: any): PoorTime | null {
  if (!payload || typeof payload !== "object") return null;
  const id = payload.id ?? payload.poor_time_id ?? payload.poorTimeId;
  const userId = payload.userId ?? payload.user_id;
  const startedAt = payload.startedAt ?? payload.started_at ?? payload.start_time ?? payload.start;
  const endedAt = payload.endedAt ?? payload.ended_at ?? payload.end_time ?? payload.end;
  const totalSecondsRaw = payload.totalSeconds ?? payload.total_seconds ?? payload.length ?? payload.seconds ?? 0;
  if (id == null || userId == null || !startedAt || !endedAt) return null;
  const totalSeconds =
    typeof totalSecondsRaw === "string" ? Number.parseInt(totalSecondsRaw, 10) || 0 : Number(totalSecondsRaw) || 0;
  return { id: String(id), userId: String(userId), startedAt: String(startedAt), endedAt: String(endedAt), totalSeconds };
}

async function listAbsentLate(range: DashboardRange, userId?: string): Promise<AbsentLate[]> {
  const raw = await fetchAllPages<any>("/absent-late", {
    limit: 800,
    offset: 0,
    userId,
    start: range.start,
    end: range.end,
  });
  return raw
    .map((x, idx) => normalizeAbsentLate(x, idx))
    .filter((x): x is AbsentLate => x !== null);
}

function normalizeAbsentLate(payload: any, idx: number): AbsentLate | null {
  if (!payload || typeof payload !== "object") return null;
  const userId = payload.userId ?? payload.user_id;
  const date = payload.date ?? payload.day ?? payload.work_date;
  const statusRaw = String(payload.status ?? payload.state ?? "present").toLowerCase();
  const status: AbsentLate["status"] =
    statusRaw === "absent" ? "absent" : statusRaw === "late" ? "late" : "present";
  if (userId == null || !date) return null;
  const id = payload.id ?? `${String(userId)}:${String(date)}:${idx}`;
  return { id: String(id), userId: String(userId), date: String(date).slice(0, 10), status };
}

async function listDailyWorkSecondsByUser(
  companyId: string,
  day: string,
  opts?: { auth?: "auto_refresh" | "access_only" },
): Promise<Map<string, number>> {
  type WorklogItem = { user_id?: string | number; length?: string | number };
  type WorklogsResponse = { worklogs?: { items?: WorklogItem[] } };

  const limit = 200;
  let offset = 0;
  const out = new Map<string, number>();

  for (let i = 0; i < 2000; i++) {
    const payload = await upstreamFetch<WorklogsResponse>(`/companies/${companyId}/worklogs`, {
      params: {
        start_date: day,
        end_date: day,
        offset,
        limit,
        consolidated: 1,
        breaks_only: 0,
        _format: "json",
      },
      auth: opts?.auth,
    });

    const items = payload.worklogs?.items ?? [];
    for (const it of items) {
      const id = parseWorklogUserId(it as Record<string, unknown>);
      if (!id) continue;
      const seconds = parseWorklogItemSeconds(it as Record<string, unknown>);
      out.set(id, (out.get(id) ?? 0) + seconds);
    }

    if (items.length < limit) break;
    offset += limit;
  }

  return out;
}

function weekStartIso(day: string): string {
  const monday = startOfWeek(parseISO(day), { weekStartsOn: 1 });
  return format(monday, "yyyy-MM-dd");
}

async function sumWorkSecondsForDayRange(
  companyId: string,
  rangeStart: string,
  rangeEnd: string,
  opts?: { auth?: "auto_refresh" | "access_only" },
): Promise<Map<string, number>> {
  const days = enumerateDays(rangeStart, rangeEnd);
  const out = new Map<string, number>();

  const concurrency = 6;
  for (let i = 0; i < days.length; i += concurrency) {
    const chunk = days.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map(async (d) => listDailyWorkSecondsByUser(companyId, d, opts)));
    for (const m of results) {
      for (const [userId, seconds] of m.entries()) {
        out.set(userId, (out.get(userId) ?? 0) + (seconds ?? 0));
      }
    }
  }

  return out;
}

async function listWeekToDateWorkSecondsByUser(
  companyId: string,
  day: string,
  opts?: { auth?: "auto_refresh" | "access_only" },
): Promise<Map<string, number>> {
  return sumWorkSecondsForDayRange(companyId, weekStartIso(day), day, opts);
}

async function listMonthToDateWorkSecondsByUser(
  companyId: string,
  day: string,
  opts?: { auth?: "auto_refresh" | "access_only" },
): Promise<Map<string, number>> {
  const monthStart = `${day.slice(0, 8)}01`;
  return sumWorkSecondsForDayRange(companyId, monthStart, day, opts);
}

/** Sum work seconds per user across a date range (paginated company worklogs). */
async function listWorkSecondsByUserForRange(
  companyId: string,
  rangeStart: string,
  rangeEnd: string,
  opts?: { auth?: "auto_refresh" | "access_only" },
): Promise<Map<string, number>> {
  type WorklogItem = { user_id?: string | number; length?: string | number };
  type WorklogsResponse = { worklogs?: { items?: WorklogItem[] } };

  const limit = 200;
  let offset = 0;
  const out = new Map<string, number>();

  for (let i = 0; i < 2000; i++) {
    const payload = await upstreamFetch<WorklogsResponse>(`/companies/${companyId}/worklogs`, {
      params: {
        start_date: rangeStart,
        end_date: rangeEnd,
        offset,
        limit,
        consolidated: 1,
        breaks_only: 0,
        _format: "json",
      },
      auth: opts?.auth,
    });

    const items = payload.worklogs?.items ?? [];
    for (const it of items) {
      const id = parseWorklogUserId(it as Record<string, unknown>);
      if (!id) continue;
      const seconds = parseWorklogItemSeconds(it as Record<string, unknown>);
      out.set(id, (out.get(id) ?? 0) + seconds);
    }

    if (items.length < limit) break;
    offset += limit;
  }

  return out;
}

async function seedUsersFromWorklogs(companyId: string): Promise<Array<{ id: string; name: string; email?: string; title?: string }>> {
  const end = format(new Date(), "yyyy-MM-dd");
  const start = format(subDays(new Date(end), 13), "yyyy-MM-dd");

  type WorklogItem = { user_id?: string | number; user_name?: string };
  type WorklogsResponse = { worklogs?: { items?: WorklogItem[] } };

  const byId = new Map<string, { id: string; name: string }>();
  const limit = 200;
  let offset = 0;

  for (let i = 0; i < 2000; i++) {
    const payload = await upstreamFetch<WorklogsResponse>(`/companies/${companyId}/worklogs`, {
      params: {
        start_date: start,
        end_date: end,
        offset,
        limit,
        consolidated: 1,
        breaks_only: 0,
        _format: "json",
      },
    });
    const items = payload.worklogs?.items ?? [];
    for (const it of items) {
      const id = it.user_id != null ? String(it.user_id) : "";
      const name = (it.user_name ?? "").trim();
      if (!id || !name) continue;
      if (!byId.has(id)) byId.set(id, { id, name });
    }
    if (items.length < limit) break;
    offset += limit;
  }

  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

const TD_LIGHT_CACHE_MS = 5 * 60_000;
let tdUsersLightCache: {
  at: number;
  users: Array<{ id: string; name: string; email: string }>;
} | null = null;
let tdCompanyCache: { at: number; id: string; name: string } | null = null;

async function getCompanyIdCached(): Promise<string> {
  if (tdCompanyCache && Date.now() - tdCompanyCache.at < TD_LIGHT_CACHE_MS) {
    return tdCompanyCache.id;
  }
  const company = await getCompany();
  tdCompanyCache = { at: Date.now(), id: company.id, name: company.name };
  return company.id;
}

/** Lightweight user list for pickers / hourly reports (no worklog aggregation). */
export async function listTimeDoctorUsersLight(): Promise<
  Array<{ id: string; name: string; email: string }>
> {
  if (tdUsersLightCache && Date.now() - tdUsersLightCache.at < TD_LIGHT_CACHE_MS) {
    return tdUsersLightCache.users;
  }
  const companyId = await getCompanyIdCached();
  const users = await listUsers(companyId, );
  const mapped = users
    .map((u) => ({
      id: u.id,
      name: (u.name || u.email || "").trim(),
      email: (u.email || "").trim().toLowerCase(),
    }))
    .filter((u) => u.email);
  tdUsersLightCache = { at: Date.now(), users: mapped };
  return mapped;
}

/** Direct worklog fetch for hourly reports (avoids extra server-fn + company round-trips). */
export async function fetchHourlyTimeDoctorSegments(
  userId: string,
  start: string,
  end: string,
): Promise<{
  worklogs: Array<{ totalSeconds: number; startedAt?: string }>;
  poorTime: Array<{ totalSeconds: number; startedAt?: string }>;
} | null> {
  try {
    const companyId = await getCompanyIdCached();
    const range = clampRange(start, end);
    const [worklogs, poorTime] = await Promise.all([
      listCompanyWorklogs(companyId, range, userId, ),
      listCompanyPoorTime(companyId, range, userId, ),
    ]);
    return { worklogs, poorTime };
  } catch {
    return null;
  }
}

const WorklogEntriesInput = z.object({
  userId: z.string().min(1),
  start: DateSchema,
  end: DateSchema,
});

/** Raw worklog + poor-time segments with start times (for hourly bucketing). */
export const fetchUserWorklogEntriesForRange = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => WorklogEntriesInput.parse(data))
  .handler(async ({ data }) => {
    const company = await getCompany();
    const range = clampRange(data.start, data.end);
    const [worklogs, poorTime] = await Promise.all([
      listCompanyWorklogs(company.id, range, data.userId, ),
      listCompanyPoorTime(company.id, range, data.userId, ),
    ]);
    return { range, worklogs, poorTime };
  });

