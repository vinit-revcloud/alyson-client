import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const WeeklyPacingInput = z.object({
  targetHours: z.number().min(1).max(168).optional(),
  day: DateSchema.optional(),
});

const WeeklyTrendInput = z.object({
  weekCount: z.number().min(4).max(26).optional(),
  targetHours: z.number().min(1).max(168).optional(),
  location: z.string().optional(),
  team: z.string().optional(),
  active: z.string().optional(),
});

const PacingRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  title: z.string(),
  location: z.string().nullable(),
  team: z.string().nullable(),
  managerName: z.string().nullable(),
  managerEmail: z.string().nullable(),
  hoursWorked: z.number(),
  avgDailyPace: z.number(),
  hoursRemaining: z.number(),
  hoursOver: z.number(),
  projectedPace: z.number(),
  hoursExpected: z.number(),
  paceDelta: z.number(),
  remainingWorkDays: z.number(),
  requiredHoursPerDay: z.number(),
  weekProgressPct: z.number(),
  metTarget: z.boolean(),
  active: z.boolean(),
  status: z.enum(["target_met", "on_track", "behind", "at_risk", "critical"]),
});

const WeeklyPacingInsightsInput = z.object({
  report: z.object({
    company: z.object({ id: z.string(), name: z.string() }),
    targetHours: z.number(),
    timeZone: z.string(),
    timeZoneLabel: z.string(),
    today: z.string(),
    week: z.object({ start: z.string(), end: z.string() }),
    pacingSampleDays: z.array(z.string()),
    elapsedWorkDays: z.number(),
    totalWorkDays: z.number(),
    remainingWorkDays: z.number(),
    generatedAt: z.string(),
    warnings: z.array(z.string()),
    rows: z.array(PacingRowSchema).optional(),
  }),
  summary: z.object({
    metTarget: z.number(),
    underTarget: z.number(),
    critical: z.number(),
    atRisk: z.number(),
    behind: z.number(),
  }),
  filterSummary: z.string().nullable(),
  rows: z.array(PacingRowSchema),
  trend: z
    .object({
      targetHours: z.number(),
      priorAverageHours: z.number(),
      liftHours: z.number(),
      liftPct: z.number(),
      latestWeek: z
        .object({
          weekStart: z.string(),
          weekEnd: z.string(),
          weekLabel: z.string(),
          avgHoursWorked: z.number(),
          employeeCount: z.number(),
          isCurrentWeek: z.boolean().optional(),
        })
        .nullable(),
      points: z
        .array(
          z.object({
            weekStart: z.string(),
            weekEnd: z.string(),
            weekLabel: z.string(),
            avgHoursWorked: z.number(),
            employeeCount: z.number(),
            isCurrentWeek: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .nullable()
    .optional(),
});

export const fetchWeeklyPacingReport = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => WeeklyPacingInput.parse(data ?? {}))
  .handler(async ({ data }) => {
    const { buildWeeklyPacingReport } = await import("@/lib/time-doctor-pacing.server");
    return buildWeeklyPacingReport(data);
  });

export const fetchWeeklyHoursTrend = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => WeeklyTrendInput.parse(data ?? {}))
  .handler(async ({ data }) => {
    const { buildWeeklyHoursTrendReport } = await import("@/lib/time-doctor-pacing.server");
    return buildWeeklyHoursTrendReport(data);
  });

export const getWeeklyPacingInsights = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => WeeklyPacingInsightsInput.parse(data))
  .handler(async ({ data }) => {
    const { generateWeeklyPacingInsights } = await import("@/lib/weekly-pacing-insights.server");
    return generateWeeklyPacingInsights(data as Parameters<typeof generateWeeklyPacingInsights>[0]);
  });
