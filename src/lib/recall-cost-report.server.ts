import {
  fetchRecallBotUsage,
  recallBotHourRateUsd,
  recallTranscriptHourRateUsd,
  recallUsageCostsFromSeconds,
} from "@/lib/recall/recall-billing.server";
import { listAllBotIndexDocs } from "@/lib/notetaker-sessions-history.server";
import { listMeetingsFromS3 } from "@/lib/notetaker-s3-calendar.server";

export type RecallCostDailyRow = {
  day: string;
  botSeconds: number;
  botHours: number;
  botCostUsd: number;
  transcriptCostUsd: number;
  totalCostUsd: number;
  meetings: number;
  costPerMeetingUsd: number | null;
  /** True when bot seconds are allocated from period total (no per-day Recall API call). */
  estimated: boolean;
};

export type RecallCostReport = {
  range: { start: string; end: string };
  generatedAt: string;
  recallConfigured: boolean;
  /** Daily bot/cost split is estimated from period total + meeting counts (Recall allows 5 billing calls/min). */
  dailyCostsEstimated: boolean;
  usage: {
    botTotalSeconds: number;
    botTotalHours: number;
    botUsageCostUsd: number;
    transcriptUsageCostUsd: number;
    totalUsageCostUsd: number;
  };
  meetings: {
    total: number;
    /** S3 meetings linked to a Recall bot id. */
    withBot: number;
    withTranscript: number;
    withNotes: number;
    botsCreated: number;
  };
  costs: {
    botUsageCostUsd: number;
    transcriptUsageCostUsd: number;
    totalUsageCostUsd: number;
    /** Total cost ÷ S3 meeting count (includes non-Recall assets). */
    costPerMeetingUsd: number | null;
    /** Total cost ÷ meetings with a Recall bot id. */
    costPerRecallMeetingUsd: number | null;
    botHourRateUsd: number;
    transcriptHourRateUsd: number;
    combinedHourRateUsd: number;
  };
  calendarMonth: {
    start: string;
    end: string;
    botTotalSeconds: number;
    botTotalHours: number;
    botUsageCostUsd: number;
    transcriptUsageCostUsd: number;
    totalUsageCostUsd: number;
    meetings: number;
    withBot: number;
    costPerMeetingUsd: number | null;
    costPerRecallMeetingUsd: number | null;
  };
  daily: RecallCostDailyRow[];
};

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

function daysBetweenInclusive(start: string, end: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${start}T12:00:00Z`);
  const endMs = new Date(`${end}T12:00:00Z`).getTime();
  while (cur.getTime() <= endMs) {
    out.push(isoDay(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function calendarMonthRange(today = isoDay(new Date())) {
  const d = new Date(`${today}T12:00:00Z`);
  const start = isoDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
  return { start, end: today };
}

function meetingDay(doc: { finalizedAt?: string; cronFinalizedAt?: string; prefix?: string }): string | null {
  const anchor = String(doc.finalizedAt || doc.cronFinalizedAt || "").trim();
  if (anchor && Number.isFinite(Date.parse(anchor))) return anchor.slice(0, 10);
  const parts = String(doc.prefix || "").split("_");
  const date = parts.length >= 2 ? parts[parts.length - 2] : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

/** Split period bot seconds across days proportional to meeting count (no per-day Recall API). */
function allocateDailyBotSeconds(
  days: string[],
  totalSeconds: number,
  meetingsByDay: Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const day of days) out.set(day, 0);
  if (totalSeconds <= 0) return out;

  const totalMeetings = days.reduce((s, d) => s + (meetingsByDay.get(d) ?? 0), 0);
  if (totalMeetings <= 0) return out;

  let allocated = 0;
  for (let i = 0; i < days.length; i++) {
    const day = days[i]!;
    const meetings = meetingsByDay.get(day) ?? 0;
    if (i === days.length - 1) {
      out.set(day, Math.max(0, totalSeconds - allocated));
      continue;
    }
    const share = Math.round((totalSeconds * meetings) / totalMeetings);
    out.set(day, share);
    allocated += share;
  }
  return out;
}

async function fetchUsageSeconds(startDay: string, endDay: string): Promise<number> {
  try {
    const usage = await fetchRecallBotUsage({ startDay, endDay });
    return Number(usage.bot_total ?? 0);
  } catch {
    return 0;
  }
}

export async function buildRecallCostReport(args: {
  start: string;
  end: string;
}): Promise<RecallCostReport> {
  const recallConfigured = Boolean(process.env.RECALL_API_KEY?.trim());
  const botHourRateUsd = recallBotHourRateUsd();
  const transcriptHourRateUsd = recallTranscriptHourRateUsd();

  const [botIndexDocs, s3Meetings] = await Promise.all([
    listAllBotIndexDocs(),
    listMeetingsFromS3({ start: args.start, end: args.end }),
  ]);

  const meetingsInRange = s3Meetings.filter((m) => m.day >= args.start && m.day <= args.end);
  const botsInRange = botIndexDocs.filter((doc) => {
    const day = meetingDay(doc);
    return day && day >= args.start && day <= args.end;
  });

  const month = calendarMonthRange();
  const periodKey = `${args.start}:${args.end}`;
  const monthKey = `${month.start}:${month.end}`;

  let botTotalSeconds = 0;
  let monthBotSeconds = 0;

  if (recallConfigured) {
    // At most 2 Recall billing API calls per report (period + month if different range).
    botTotalSeconds = await fetchUsageSeconds(args.start, args.end);
    if (periodKey === monthKey) {
      monthBotSeconds = botTotalSeconds;
    } else {
      monthBotSeconds = await fetchUsageSeconds(month.start, month.end);
    }
  }

  const periodCosts = recallUsageCostsFromSeconds(botTotalSeconds);
  const meetingCount = meetingsInRange.length;
  const meetingsWithBot = meetingsInRange.filter((m) => m.botId).length;
  const costPerMeetingUsd =
    meetingCount > 0 ? periodCosts.totalUsageCostUsd / meetingCount : null;
  const costPerRecallMeetingUsd =
    meetingsWithBot > 0 ? periodCosts.totalUsageCostUsd / meetingsWithBot : null;

  const meetingsByDay = new Map<string, number>();
  for (const m of meetingsInRange) {
    meetingsByDay.set(m.day, (meetingsByDay.get(m.day) ?? 0) + 1);
  }

  const dayList = daysBetweenInclusive(args.start, args.end);
  const dailyUsage = allocateDailyBotSeconds(dayList, botTotalSeconds, meetingsByDay);

  const daily: RecallCostDailyRow[] = dayList.map((day) => {
    const botSeconds = dailyUsage.get(day) ?? 0;
    const meetings = meetingsByDay.get(day) ?? 0;
    const dayCosts = recallUsageCostsFromSeconds(botSeconds);
    return {
      day,
      botSeconds,
      botHours: botSeconds / 3600,
      botCostUsd: dayCosts.botUsageCostUsd,
      transcriptCostUsd: dayCosts.transcriptUsageCostUsd,
      totalCostUsd: dayCosts.totalUsageCostUsd,
      meetings,
      costPerMeetingUsd: meetings > 0 ? dayCosts.totalUsageCostUsd / meetings : null,
      estimated: true,
    };
  });

  const monthCosts = recallUsageCostsFromSeconds(monthBotSeconds);
  const monthMeetingsInRange = s3Meetings.filter((m) => m.day >= month.start && m.day <= month.end);
  const monthMeetings = monthMeetingsInRange.length;
  const monthMeetingsWithBot = monthMeetingsInRange.filter((m) => m.botId).length;
  const combinedHourRateUsd = botHourRateUsd + transcriptHourRateUsd;

  return {
    range: { start: args.start, end: args.end },
    generatedAt: new Date().toISOString(),
    recallConfigured,
    dailyCostsEstimated: true,
    usage: {
      botTotalSeconds,
      botTotalHours: botTotalSeconds / 3600,
      botUsageCostUsd: periodCosts.botUsageCostUsd,
      transcriptUsageCostUsd: periodCosts.transcriptUsageCostUsd,
      totalUsageCostUsd: periodCosts.totalUsageCostUsd,
    },
    meetings: {
      total: meetingCount,
      withBot: meetingsWithBot,
      withTranscript: meetingsInRange.filter((m) => m.hasTranscript).length,
      withNotes: meetingsInRange.filter((m) => m.hasNotes).length,
      botsCreated: botsInRange.length,
    },
    costs: {
      botUsageCostUsd: periodCosts.botUsageCostUsd,
      transcriptUsageCostUsd: periodCosts.transcriptUsageCostUsd,
      totalUsageCostUsd: periodCosts.totalUsageCostUsd,
      costPerMeetingUsd,
      costPerRecallMeetingUsd,
      botHourRateUsd,
      transcriptHourRateUsd,
      combinedHourRateUsd,
    },
    calendarMonth: {
      start: month.start,
      end: month.end,
      botTotalSeconds: monthBotSeconds,
      botTotalHours: monthBotSeconds / 3600,
      botUsageCostUsd: monthCosts.botUsageCostUsd,
      transcriptUsageCostUsd: monthCosts.transcriptUsageCostUsd,
      totalUsageCostUsd: monthCosts.totalUsageCostUsd,
      meetings: monthMeetings,
      withBot: monthMeetingsWithBot,
      costPerMeetingUsd: monthMeetings > 0 ? monthCosts.totalUsageCostUsd / monthMeetings : null,
      costPerRecallMeetingUsd:
        monthMeetingsWithBot > 0 ? monthCosts.totalUsageCostUsd / monthMeetingsWithBot : null,
    },
    daily,
  };
}
