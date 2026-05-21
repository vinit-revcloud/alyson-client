import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { buildNotetakerAnalyticsReport } from "@/lib/notetaker-analytics.server";
import { generateNotetakerAnalyticsInsights } from "@/lib/notetaker-analytics-insights.server";

const ReportInput = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  speakerFilters: z.array(z.string()).optional(),
  /** @deprecated use speakerFilters — comma-separated still accepted via string union */
  speakerFilter: z.string().optional(),
  meetingTitleFilter: z.string().optional(),
  maxMeetings: z.number().int().min(1).max(100).optional(),
});

export const getNotetakerAnalyticsReport = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => ReportInput.parse(data))
  .handler(async ({ data }) => {
    const report = await buildNotetakerAnalyticsReport({
      start: data.start,
      end: data.end,
      speakerFilters: data.speakerFilters ?? (data.speakerFilter ? [data.speakerFilter] : undefined),
      meetingTitleFilter: data.meetingTitleFilter,
      maxMeetings: data.maxMeetings,
    });
    return { report };
  });

const InsightsInput = z.object({
  report: z.object({
    range: z.object({ start: z.string(), end: z.string() }),
    generatedAt: z.string(),
    filters: z.object({ speakers: z.array(z.string()), meetingTitle: z.string() }),
    meetingCount: z.number(),
    analyzedCount: z.number(),
    skippedNoTranscript: z.number(),
    totalUtterances: z.number(),
    totalWords: z.number(),
    uniqueSpeakersGlobal: z.number(),
    meetings: z.array(z.any()),
    topSpeakers: z.array(z.any()),
    meetingsByDay: z.array(z.object({ day: z.string(), meetings: z.number() })),
    speakerByMeeting: z.array(z.any()),
  }),
});

export const getNotetakerAnalyticsInsights = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => InsightsInput.parse(data))
  .handler(async ({ data }) => {
    const result = await generateNotetakerAnalyticsInsights(data.report as any);
    return result;
  });
