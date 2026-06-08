import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { buildNotetakerTasksReport, generateNotetakerTasksInsights } from "@/lib/notetaker-tasks.server";
import type { NotetakerTasksReport } from "@/lib/notetaker-tasks-types";

const ReportInput = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  assigneeEmail: z.string().email(),
  assigneeName: z.string().min(1).optional(),
  maxMeetings: z.preprocess(
    (v) => {
      if (v === undefined || v === null || v === "") return undefined;
      const n = typeof v === "string" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
      return Math.min(Math.max(Math.trunc(n), 1), 20);
    },
    z.number().int().min(1).max(20).optional(),
  ),
  forceRefresh: z.boolean().optional(),
});

export const getNotetakerTasksReport = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => ReportInput.parse(data))
  .handler(async ({ data }) => {
    const report = await buildNotetakerTasksReport({
      start: data.start,
      end: data.end,
      assigneeEmail: data.assigneeEmail,
      assigneeName: data.assigneeName,
      maxMeetings: data.maxMeetings,
      forceRefresh: data.forceRefresh,
    });
    return { report };
  });

const InsightsInput = z.object({
  report: z.custom<NotetakerTasksReport>(),
});

export const getNotetakerTasksInsights = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => InsightsInput.parse(data))
  .handler(async ({ data }) => {
    const result = await generateNotetakerTasksInsights(data.report);
    return result;
  });
