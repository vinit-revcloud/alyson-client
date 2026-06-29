import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { buildBotJoinReport } from "@/lib/notetaker-bot-join-report.server";

const RangeInput = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  calendarEmail: z.string().email().optional(),
  forceRefresh: z.boolean().optional(),
  /** Rolling window ending now (e.g. 24 = last 24 hours). */
  windowHours: z.number().int().min(1).max(168).optional(),
});

/** POST avoids flaky GET input handling in TanStack Start dev (same pattern as getNotetakerSession). */
export const getBotJoinReport = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => RangeInput.parse(data))
  .handler(async ({ data }) => {
    const report = await buildBotJoinReport({
      start: data.start,
      end: data.end,
      calendarEmail: data.calendarEmail,
      forceRefresh: data.forceRefresh,
      windowHours: data.windowHours,
    });
    return { report };
  });
