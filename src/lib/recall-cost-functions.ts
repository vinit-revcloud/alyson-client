import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { buildRecallCostReport } from "@/lib/recall-cost-report.server";
import { generateRecallCostInsights } from "@/lib/recall-cost-insights.server";

const RangeInput = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const getRecallCostReport = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => RangeInput.parse(data))
  .handler(async ({ data }) => {
    const report = await buildRecallCostReport({ start: data.start, end: data.end });
    return { report };
  });

const InsightsInput = z.object({
  report: z.object({
    range: z.object({ start: z.string(), end: z.string() }),
    generatedAt: z.string(),
    recallConfigured: z.boolean(),
    dailyCostsEstimated: z.boolean(),
    usage: z.object({
      botTotalSeconds: z.number(),
      botTotalHours: z.number(),
      botUsageCostUsd: z.number(),
      transcriptUsageCostUsd: z.number(),
      totalUsageCostUsd: z.number(),
    }),
    meetings: z.object({
      total: z.number(),
      withBot: z.number().optional(),
      withTranscript: z.number(),
      withNotes: z.number(),
      botsCreated: z.number(),
    }),
    costs: z.object({
      botUsageCostUsd: z.number(),
      transcriptUsageCostUsd: z.number(),
      totalUsageCostUsd: z.number(),
      costPerMeetingUsd: z.number().nullable(),
      costPerRecallMeetingUsd: z.number().nullable().optional(),
      botHourRateUsd: z.number(),
      transcriptHourRateUsd: z.number(),
      combinedHourRateUsd: z.number().optional(),
    }),
    calendarMonth: z.object({
      start: z.string(),
      end: z.string(),
      botTotalSeconds: z.number(),
      botTotalHours: z.number(),
      botUsageCostUsd: z.number(),
      transcriptUsageCostUsd: z.number(),
      totalUsageCostUsd: z.number(),
      meetings: z.number(),
      withBot: z.number().optional(),
      costPerMeetingUsd: z.number().nullable(),
      costPerRecallMeetingUsd: z.number().nullable().optional(),
    }),
    daily: z.array(
      z.object({
        day: z.string(),
        botSeconds: z.number(),
        botHours: z.number(),
        botCostUsd: z.number(),
        transcriptCostUsd: z.number(),
        totalCostUsd: z.number(),
        meetings: z.number(),
        costPerMeetingUsd: z.number().nullable(),
        estimated: z.boolean(),
      }),
    ),
  }),
});

export const getRecallCostInsights = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => InsightsInput.parse(data))
  .handler(async ({ data }) => {
    const result = await generateRecallCostInsights(data.report as Parameters<typeof generateRecallCostInsights>[0]);
    return result;
  });
