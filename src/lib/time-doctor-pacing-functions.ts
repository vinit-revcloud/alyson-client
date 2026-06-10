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
