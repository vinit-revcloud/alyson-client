import { attachManagerToPacingRow } from "@/lib/org-chart-roster";
import { getOrgChartRosterLookup } from "@/lib/org-chart-roster.server";
import { resolveCintaraActiveForPacing } from "@/lib/cintara-active-members";
import { getCintaraActiveMemberLookup } from "@/lib/cintara-active-members.server";
import {
  timeDoctorPacingGetCompany,
  timeDoctorPacingListUsers,
  timeDoctorPacingLoadRangeSeconds,
  timeDoctorPacingWeekStartSunday,
  getTimeDoctorTimezoneLabel,
  timeDoctorTodayIso,
} from "@/lib/time-doctor-functions";
import {
  addDaysIso,
  buildPacingRow,
  computeWeekPacingMetrics,
  fridayOfWeek,
  resolvePacingRollupDay,
  weekStartIso,
  type WeeklyHoursTrendPoint,
  type WeeklyHoursTrendReport,
  type WeeklyPacingReport,
} from "@/lib/weekly-pacing";

function weekStartSundayIso(day: string): string {
  return timeDoctorPacingWeekStartSunday(day);
}

function matchesTrendFacet(args: {
  location: string | null;
  team: string | null;
  active: boolean;
  locationFilter: string;
  teamFilter: string;
  activeFilter: string;
}): boolean {
  const loc = args.location?.trim() || "__empty__";
  const team = args.team?.trim() || "__empty__";
  if (args.locationFilter !== "__all__" && loc !== args.locationFilter) return false;
  if (args.teamFilter !== "__all__" && team !== args.teamFilter) return false;
  if (args.activeFilter === "yes" && !args.active) return false;
  if (args.activeFilter === "no" && args.active) return false;
  return true;
}

function weekRollupEnd(weekStart: string, today: string): string {
  const currentWeekStart = weekStartIso(today);
  if (weekStart < currentWeekStart) return fridayOfWeek(weekStart);
  return resolvePacingRollupDay(today, today);
}

function formatWeekLabel(weekStart: string, weekEnd: string): string {
  const start = new Date(`${weekStart}T12:00:00Z`);
  const end = new Date(`${weekEnd}T12:00:00Z`);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${fmt(start)} – ${fmt(end)}`;
}

type PacingUserContext = {
  rosterLookup: ReturnType<typeof getOrgChartRosterLookup>;
  activeLookup: ReturnType<typeof getCintaraActiveMemberLookup>;
};

function buildFilteredUserIds(
  users: Awaited<ReturnType<typeof timeDoctorPacingListUsers>>,
  ctx: PacingUserContext,
  filters: { locationFilter: string; teamFilter: string; activeFilter: string },
): Set<string> {
  const ids = new Set<string>();
  for (const u of users) {
    const email = (u.email || "").trim();
    const name = (u.name || u.email || "").trim();
    const withMeta = attachManagerToPacingRow({ email, name }, ctx.rosterLookup);
    const active = resolveCintaraActiveForPacing(ctx.activeLookup, ctx.rosterLookup, {
      email,
      name,
    });
    if (
      matchesTrendFacet({
        location: withMeta.location,
        team: withMeta.team,
        active,
        locationFilter: filters.locationFilter,
        teamFilter: filters.teamFilter,
        activeFilter: filters.activeFilter,
      })
    ) {
      ids.add(u.id);
    }
  }
  return ids;
}

/** Current-week pacing: all employees with hours worked, gap/over target, and required daily pace. */
export async function buildWeeklyPacingReport(args?: {
  targetHours?: number;
  day?: string;
}): Promise<WeeklyPacingReport> {
  const targetHours = args?.targetHours ?? 35;
  const company = await timeDoctorPacingGetCompany();
  const rollupDay = args?.day ?? timeDoctorTodayIso();
  const warnings: string[] = [];

  let weekStart = weekStartIso(rollupDay);
  const rangeCache = new Map<string, Map<string, number>>();

  let weekly = new Map<string, number>();
  try {
    weekly = await timeDoctorPacingLoadRangeSeconds(company.id, weekStart, rollupDay, rangeCache);
    const weekEmpty = [...weekly.values()].every((s) => s === 0);
    if (weekEmpty) {
      const sundayStart = weekStartSundayIso(rollupDay);
      if (sundayStart !== weekStart) {
        const alt = await timeDoctorPacingLoadRangeSeconds(company.id, sundayStart, rollupDay, rangeCache);
        if ([...alt.values()].some((s) => s > 0)) {
          weekly = alt;
          weekStart = sundayStart;
        }
      }
    }
  } catch (e) {
    warnings.push(`weekly-worklogs: ${String(e)}`);
  }

  let users: Awaited<ReturnType<typeof timeDoctorPacingListUsers>> = [];
  try {
    users = await timeDoctorPacingListUsers(company.id);
  } catch (e) {
    warnings.push(`users: ${String(e)}`);
  }

  const pacingWeekStart = weekStartIso(rollupDay);
  const metrics = computeWeekPacingMetrics({
    weekStart: pacingWeekStart,
    today: rollupDay,
    targetHours,
  });
  const sampleDays = metrics.pacingSampleDays;

  await Promise.all(
    sampleDays.map(async (day) => {
      try {
        await timeDoctorPacingLoadRangeSeconds(company.id, day, day, rangeCache);
      } catch (e) {
        warnings.push(`daily-worklogs-${day}: ${String(e)}`);
      }
    }),
  );

  const rosterLookup = getOrgChartRosterLookup();
  const activeLookup = getCintaraActiveMemberLookup();

  const rows = users
    .map((u) => {
      const daySeconds = sampleDays.map((day) => {
        const cacheKey = `${company.id}:${day}:${day}`;
        const dayMap = rangeCache.get(cacheKey);
        return dayMap?.get(u.id) ?? 0;
      });
      const row = buildPacingRow({
        id: u.id,
        email: (u.email || "").trim(),
        name: (u.name || u.email || "").trim(),
        title: u.title ?? "",
        weeklySeconds: weekly.get(u.id) ?? 0,
        dailyHours: daySeconds.map((s) => s / 3600),
        metrics,
        today: rollupDay,
        weekStart: pacingWeekStart,
      });
      if (!row) return null;
      const withManager = attachManagerToPacingRow(row, rosterLookup);
      return {
        ...withManager,
        active: resolveCintaraActiveForPacing(activeLookup, rosterLookup, {
          email: withManager.email,
          name: withManager.name,
        }),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r != null);

  return {
    company: { id: company.id, name: company.name },
    targetHours,
    timeZone: company.timeZone ?? "America/Chicago",
    timeZoneLabel: company.timeZoneLabel ?? getTimeDoctorTimezoneLabel(),
    today: rollupDay,
    week: { start: pacingWeekStart, end: metrics.weekEnd },
    pacingSampleDays: metrics.pacingSampleDays,
    elapsedWorkDays: metrics.elapsedWorkDays,
    totalWorkDays: metrics.totalWorkDays,
    remainingWorkDays: metrics.remainingWorkDays,
    generatedAt: new Date().toISOString(),
    rows,
    warnings: warnings.slice(0, 8),
  };
}

export async function buildWeeklyHoursTrendReport(args?: {
  weekCount?: number;
  targetHours?: number;
  location?: string;
  team?: string;
  active?: string;
}): Promise<WeeklyHoursTrendReport> {
  const weekCount = args?.weekCount ?? 8;
  const targetHours = args?.targetHours ?? 35;
  const locationFilter = args?.location ?? "__all__";
  const teamFilter = args?.team ?? "__all__";
  const activeFilter = args?.active ?? "__all__";
  const today = timeDoctorTodayIso();
  const warnings: string[] = [];

  const company = await timeDoctorPacingGetCompany();
  let users: Awaited<ReturnType<typeof timeDoctorPacingListUsers>> = [];
  try {
    users = await timeDoctorPacingListUsers(company.id);
  } catch (e) {
    warnings.push(`users: ${String(e)}`);
  }

  const ctx: PacingUserContext = {
    rosterLookup: getOrgChartRosterLookup(),
    activeLookup: getCintaraActiveMemberLookup(),
  };
  const filteredUserIds = buildFilteredUserIds(users, ctx, {
    locationFilter,
    teamFilter,
    activeFilter,
  });

  const currentWeekStart = weekStartIso(today);
  const weekStarts: string[] = [];
  for (let i = weekCount - 1; i >= 0; i--) {
    weekStarts.push(addDaysIso(currentWeekStart, -7 * i));
  }

  const rangeCache = new Map<string, Map<string, number>>();

  const pointResults = await Promise.all(
    weekStarts.map(async (weekStart): Promise<WeeklyHoursTrendPoint | null> => {
      const weekEnd = weekRollupEnd(weekStart, today);
      if (weekStart > weekEnd) return null;
      try {
        let weekly = await timeDoctorPacingLoadRangeSeconds(
          company.id,
          weekStart,
          weekEnd,
          rangeCache,
        );
        const weekEmpty = [...weekly.values()].every((s) => s === 0);
        if (weekEmpty) {
          const sundayStart = weekStartSundayIso(weekEnd);
          if (sundayStart !== weekStart) {
            const alt = await timeDoctorPacingLoadRangeSeconds(
              company.id,
              sundayStart,
              weekEnd,
              rangeCache,
            );
            if ([...alt.values()].some((s) => s > 0)) weekly = alt;
          }
        }

        let totalSeconds = 0;
        let counted = 0;
        for (const userId of filteredUserIds) {
          const seconds = weekly.get(userId) ?? 0;
          totalSeconds += seconds;
          counted += 1;
        }

        const avgHoursWorked = counted > 0 ? totalSeconds / counted / 3600 : 0;
        return {
          weekStart,
          weekEnd,
          weekLabel: formatWeekLabel(weekStart, weekEnd),
          employeeCount: counted,
          avgHoursWorked: Math.round(avgHoursWorked * 100) / 100,
          totalHoursWorked: Math.round((totalSeconds / 3600) * 100) / 100,
          isCurrentWeek: weekStart === currentWeekStart,
        };
      } catch (e) {
        warnings.push(`week-${weekStart}: ${String(e)}`);
        return null;
      }
    }),
  );

  const points = pointResults
    .filter((p): p is WeeklyHoursTrendPoint => p != null)
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  const priorPoints = points.length > 1 ? points.slice(0, -1) : [];
  const priorAverageHours =
    priorPoints.length > 0
      ? Math.round(
          (priorPoints.reduce((sum, p) => sum + p.avgHoursWorked, 0) / priorPoints.length) * 100,
        ) / 100
      : 0;

  const latest = points.length ? points[points.length - 1]! : null;
  const liftHours =
    latest != null ? Math.round((latest.avgHoursWorked - priorAverageHours) * 100) / 100 : 0;
  const liftPct =
    priorAverageHours > 0
      ? Math.round(((liftHours / priorAverageHours) * 100) * 10) / 10
      : latest && latest.avgHoursWorked > 0
        ? 100
        : 0;

  return {
    company: { id: company.id, name: company.name },
    targetHours,
    timeZoneLabel: getTimeDoctorTimezoneLabel(),
    weekCount,
    filters: { location: locationFilter, team: teamFilter, active: activeFilter },
    points,
    priorAverageHours,
    latestWeek: latest,
    liftHours,
    liftPct,
    generatedAt: new Date().toISOString(),
    warnings: warnings.slice(0, 8),
  };
}
