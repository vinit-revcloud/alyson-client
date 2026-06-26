import { emailLookupKeys } from "@/lib/cintara-email";
import { getLeaveFromS3 } from "@/lib/leave-s3.server";
import {
  countLeaveWorkdaysUnion,
  formatTeamLeaveLabel,
  leaveTypeLabel,
  matchesTeamLocation,
  type EmployeeLeaveLedger,
  type LeaveDataFile,
  type LeaveDateRange,
  type TeamLeaveEvent,
} from "@/lib/leave-schema";
import {
  PACING_LEAVE_HOURS_PER_DAY,
  isWeekdayIso,
  type WeeklyPacingTeamLeaveSummary,
} from "@/lib/weekly-pacing";

export { PACING_LEAVE_HOURS_PER_DAY };

export type LeaveDaysLookup = {
  byEmployeeId: Map<string, number>;
  byEmail: Map<string, number>;
};

export type EmployeeLeaveBreakdown = {
  leaveDays: number;
  leaveDaysPersonal: number;
  leaveDaysTeam: number;
};

export type PacingLeaveContext = {
  lookup: LeaveDaysLookup;
  teamLeaves: TeamLeaveEvent[];
  employees: Record<string, EmployeeLeaveLedger>;
  rangeStart: string;
  rangeEnd: string;
};

function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

function teamLeavesForEmployee(
  teamLeaves: TeamLeaveEvent[],
  location: string,
  team: string,
): TeamLeaveEvent[] {
  return teamLeaves.filter((tl) => matchesTeamLocation(location, team, tl.location, tl.team));
}

function personalRangesForEmployee(
  employees: Record<string, EmployeeLeaveLedger>,
  employeeId: string,
  email: string,
): LeaveDateRange[] {
  const ledger = employees[employeeId];
  if (ledger) return ledger.leaveEvents.map((e) => ({ startDate: e.startDate, endDate: e.endDate }));
  const emailKey = normEmail(email);
  for (const l of Object.values(employees)) {
    if (normEmail(l.officialEmail) === emailKey) {
      return l.leaveEvents.map((e) => ({ startDate: e.startDate, endDate: e.endDate }));
    }
  }
  return [];
}

function leaveBreakdownForEmployee(
  ctx: PacingLeaveContext,
  args: {
    employeeId: string;
    email: string;
    team?: string | null;
    location?: string | null;
  },
): EmployeeLeaveBreakdown {
  const team = args.team?.trim() ?? "";
  const location = args.location?.trim() ?? "";
  const personalRanges = personalRangesForEmployee(ctx.employees, args.employeeId, args.email);
  const teamRanges = teamLeavesForEmployee(ctx.teamLeaves, location, team).map((e) => ({
    startDate: e.startDate,
    endDate: e.endDate,
  }));

  const leaveDaysPersonal = countLeaveWorkdaysUnion(
    personalRanges,
    ctx.rangeStart,
    ctx.rangeEnd,
  );
  const leaveDaysTeam = countLeaveWorkdaysUnion(teamRanges, ctx.rangeStart, ctx.rangeEnd);
  const leaveDays = countLeaveWorkdaysUnion(
    [...personalRanges, ...teamRanges],
    ctx.rangeStart,
    ctx.rangeEnd,
  );

  return { leaveDays, leaveDaysPersonal, leaveDaysTeam };
}

function leaveDaysForLedger(
  ledger: EmployeeLeaveLedger,
  teamLeaves: TeamLeaveEvent[],
  rangeStart: string,
  rangeEnd: string,
): number {
  const applicableTeam = teamLeavesForEmployee(teamLeaves, ledger.location, ledger.team);
  const ranges = [
    ...ledger.leaveEvents.map((e) => ({ startDate: e.startDate, endDate: e.endDate })),
    ...applicableTeam.map((e) => ({ startDate: e.startDate, endDate: e.endDate })),
  ];
  return countLeaveWorkdaysUnion(ranges, rangeStart, rangeEnd);
}

export function buildLeaveDaysLookup(
  employees: Record<string, EmployeeLeaveLedger>,
  rangeStart: string,
  rangeEnd: string,
  teamLeaves: TeamLeaveEvent[] = [],
): LeaveDaysLookup {
  const byEmployeeId = new Map<string, number>();
  const byEmail = new Map<string, number>();

  for (const ledger of Object.values(employees)) {
    const days = leaveDaysForLedger(ledger, teamLeaves, rangeStart, rangeEnd);
    if (days <= 0) continue;
    byEmployeeId.set(ledger.employeeId, days);
    for (const key of emailLookupKeys(ledger.officialEmail)) {
      byEmail.set(key, days);
    }
    const email = normEmail(ledger.officialEmail);
    if (email) byEmail.set(email, days);
  }

  return { byEmployeeId, byEmail };
}

export function resolveLeaveBreakdownForEmployee(
  ctx: PacingLeaveContext,
  args: {
    employeeId: string;
    email: string;
    team?: string | null;
    location?: string | null;
  },
): EmployeeLeaveBreakdown {
  return leaveBreakdownForEmployee(ctx, args);
}

function isWeekdayOnLeave(ranges: LeaveDateRange[], day: string): boolean {
  if (!isWeekdayIso(day)) return false;
  return ranges.some((r) => day >= r.startDate && day <= r.endDate);
}

/** Per Mon–Thu sample day: +7h credit when that weekday is on personal or team leave. */
export function resolveDailyLeaveHoursForSample(
  ctx: PacingLeaveContext,
  args: {
    employeeId: string;
    email: string;
    team?: string | null;
    location?: string | null;
  },
  sampleDays: string[],
): number[] {
  const personalRanges = personalRangesForEmployee(ctx.employees, args.employeeId, args.email);
  const teamRanges = teamLeavesForEmployee(
    ctx.teamLeaves,
    args.location?.trim() ?? "",
    args.team?.trim() ?? "",
  ).map((e) => ({ startDate: e.startDate, endDate: e.endDate }));
  const allRanges = [...personalRanges, ...teamRanges];

  return sampleDays.map((day) =>
    isWeekdayOnLeave(allRanges, day) ? PACING_LEAVE_HOURS_PER_DAY : 0,
  );
}

/** @deprecated Use resolveLeaveBreakdownForEmployee */
export function resolveLeaveDaysForEmployee(
  ctx: PacingLeaveContext,
  args: {
    employeeId: string;
    email: string;
    team?: string | null;
    location?: string | null;
  },
): number {
  return leaveBreakdownForEmployee(ctx, args).leaveDays;
}

export function summarizeTeamLeavesForWeek(
  teamLeaves: TeamLeaveEvent[],
  rangeStart: string,
  rangeEnd: string,
): WeeklyPacingTeamLeaveSummary[] {
  return teamLeaves
    .map((ev) => {
      const daysInWeek = countLeaveWorkdaysUnion(
        [{ startDate: ev.startDate, endDate: ev.endDate }],
        rangeStart,
        rangeEnd,
      );
      if (daysInWeek <= 0) return null;
      return {
        id: ev.id,
        location: ev.location,
        teamLabel: formatTeamLeaveLabel(ev.team),
        startDate: ev.startDate,
        endDate: ev.endDate,
        daysInWeek,
        leaveType: leaveTypeLabel(ev.leaveType),
      };
    })
    .filter((e): e is WeeklyPacingTeamLeaveSummary => e != null)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
}

export function pacingLeaveHoursCredit(leaveDays: number): number {
  return Math.round(leaveDays * PACING_LEAVE_HOURS_PER_DAY * 100) / 100;
}

export function buildPacingLeaveContext(
  file: LeaveDataFile | null,
  rangeStart: string,
  rangeEnd: string,
): PacingLeaveContext {
  const teamLeaves = file?.teamLeaves ?? [];
  const employees = file?.employees ?? {};
  const lookup = buildLeaveDaysLookup(employees, rangeStart, rangeEnd, teamLeaves);
  return { lookup, teamLeaves, employees, rangeStart, rangeEnd };
}

export async function loadPacingLeaveContext(
  rangeStart: string,
  rangeEnd: string,
): Promise<PacingLeaveContext> {
  try {
    const { file } = await getLeaveFromS3();
    return buildPacingLeaveContext(file, rangeStart, rangeEnd);
  } catch {
    return buildPacingLeaveContext(null, rangeStart, rangeEnd);
  }
}

/** @deprecated Use loadPacingLeaveContext */
export async function loadLeaveDaysForPacingWeek(
  weekStart: string,
  weekEnd: string,
): Promise<LeaveDaysLookup> {
  const ctx = await loadPacingLeaveContext(weekStart, weekEnd);
  return ctx.lookup;
}

export async function loadLeaveDataFile(): Promise<LeaveDataFile | null> {
  try {
    const { file } = await getLeaveFromS3();
    return file;
  } catch {
    return null;
  }
}
