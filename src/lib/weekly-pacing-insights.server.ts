import type { WeeklyHoursTrendReport, WeeklyPacingReport, WeeklyPacingRow } from "@/lib/weekly-pacing";
import { PACING_STATUS_LABEL } from "@/lib/weekly-pacing";
import {
  groqChat,
  groqModel,
  isAiRateLimitOrQuotaError,
  meetingAiChat,
} from "@/lib/groq-chat.server";

/** 8b has much higher Groq TPD limits than 70b — safe default for large reports. */
const DEFAULT_MODEL = "llama-3.1-8b-instant";
const FALLBACK_MODEL = "llama-3.1-8b-instant";

function pacingInsightsModels(): string[] {
  const override = process.env.ALYSON_PACING_INSIGHTS_MODEL?.trim();
  if (override) {
    const models = [override];
    if (override !== FALLBACK_MODEL) models.push(FALLBACK_MODEL);
    return models;
  }
  const envModel = process.env.ALYSON_MINI_MODULE_AI_MODEL?.trim() || process.env.GROQ_MODEL?.trim();
  if (envModel && envModel !== DEFAULT_MODEL) {
    return [envModel, DEFAULT_MODEL];
  }
  return [DEFAULT_MODEL];
}

function maxOutputTokens(): number {
  const raw = process.env.ALYSON_PACING_INSIGHTS_MAX_TOKENS?.trim();
  const n = raw ? Number(raw) : 4096;
  return Number.isFinite(n) && n >= 512 && n <= 8192 ? n : 4096;
}

async function chatForInsights(messages: { role: "system" | "user" | "assistant"; content: string }[]) {
  const models = pacingInsightsModels();
  const maxTokens = maxOutputTokens();
  const errors: string[] = [];

  for (let i = 0; i < models.length; i++) {
    const model = models[i]!;
    try {
      const content = await groqChat(messages, 0.25, {
        model,
        maxRetries: 0,
        maxTokens: maxOutputTokens(),
      });
      return { content, model, provider: "groq" as const };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${model}: ${msg}`);
      if (!isAiRateLimitOrQuotaError(msg) || i >= models.length - 1) break;
    }
  }

  try {
    const result = await meetingAiChat(messages, 0.25);
    return { content: result.content, model: result.model, provider: result.provider };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(msg);
    throw new Error(
      errors.length
        ? `AI insights unavailable (${errors[errors.length - 1]}). Try again later or set DEEPSEEK_API_KEY for fallback.`
        : msg,
    );
  }
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function avg(nums: number[]) {
  if (!nums.length) return 0;
  return round2(nums.reduce((s, n) => s + n, 0) / nums.length);
}

function median(nums: number[]) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : round2((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Compact row — omits email/ids to cut input tokens. */
function compactRow(r: WeeklyPacingRow) {
  return {
    name: r.name,
    loc: r.location || "?",
    team: r.team || "?",
    mgr: r.managerName || "?",
    hrs: r.hoursWorked,
    pace: r.projectedPace,
    rem: r.hoursRemaining,
    over: r.hoursOver,
    reqDay: r.requiredHoursPerDay,
    daysLeft: r.remainingWorkDays,
    status: PACING_STATUS_LABEL[r.status],
  };
}

type GroupStats = {
  name: string;
  count: number;
  metTarget: number;
  critical: number;
  atRisk: number;
  behind: number;
  onTrack: number;
  avgHoursWorked: number;
  avgProjectedPace: number;
  avgHoursRemaining: number;
  pctMetTarget: number;
};

function groupStats(rows: WeeklyPacingRow[], keyFn: (r: WeeklyPacingRow) => string): GroupStats[] {
  const map = new Map<string, WeeklyPacingRow[]>();
  for (const r of rows) {
    const key = keyFn(r);
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }

  return [...map.entries()]
    .map(([name, list]) => {
      const metTarget = list.filter((r) => r.metTarget).length;
      const under = list.filter((r) => !r.metTarget);
      return {
        name,
        count: list.length,
        metTarget,
        critical: list.filter((r) => r.status === "critical").length,
        atRisk: list.filter((r) => r.status === "at_risk").length,
        behind: list.filter((r) => r.status === "behind").length,
        onTrack: list.filter((r) => r.status === "on_track").length,
        avgHoursWorked: avg(list.map((r) => r.hoursWorked)),
        avgProjectedPace: avg(list.map((r) => r.projectedPace)),
        avgHoursRemaining: avg(under.map((r) => r.hoursRemaining)),
        pctMetTarget: list.length ? round1((metTarget / list.length) * 100) : 0,
      };
    })
    .sort((a, b) => b.critical + b.atRisk - (a.critical + a.atRisk) || b.count - a.count);
}

function summarizeActiveRows(rows: WeeklyPacingRow[]) {
  const metTarget = rows.filter((r) => r.metTarget).length;
  const under = rows.filter((r) => !r.metTarget);
  return {
    total: rows.length,
    metTarget,
    underTarget: rows.length - metTarget,
    pctMetTarget: rows.length ? round1((metTarget / rows.length) * 100) : 0,
    critical: rows.filter((r) => r.status === "critical").length,
    atRisk: rows.filter((r) => r.status === "at_risk").length,
    behind: rows.filter((r) => r.status === "behind").length,
    onTrack: rows.filter((r) => r.status === "on_track").length,
    needsAttention: rows.filter((r) => ["critical", "at_risk", "behind"].includes(r.status)).length,
  };
}

function aggregateStats(rows: WeeklyPacingRow[], targetHours: number) {
  const hours = rows.map((r) => r.hoursWorked);
  const paces = rows.map((r) => r.projectedPace);
  const under = rows.filter((r) => !r.metTarget);
  return {
    totalHoursLogged: round2(hours.reduce((s, h) => s + h, 0)),
    avgHoursWorked: avg(hours),
    medianHoursWorked: median(hours),
    minHoursWorked: hours.length ? round2(Math.min(...hours)) : 0,
    maxHoursWorked: hours.length ? round2(Math.max(...hours)) : 0,
    avgProjectedPace: avg(paces),
    medianProjectedPace: median(paces),
    avgPaceDeltaVsTarget: avg(paces.map((p) => round2(p - targetHours))),
    avgRequiredHoursPerDayForUnderTarget: under.length
      ? avg(under.map((r) => r.requiredHoursPerDay))
      : 0,
    totalHoursRemaining: round2(under.reduce((s, r) => s + r.hoursRemaining, 0)),
    totalHoursOverTarget: round2(rows.reduce((s, r) => s + r.hoursOver, 0)),
  };
}

function buildTrendAnalysis(trend: WeeklyHoursTrendReport | null | undefined, targetHours: number) {
  if (!trend?.points?.length) return null;

  const points = trend.points;
  const latest = points[points.length - 1]!;
  const previous = points.length >= 2 ? points[points.length - 2]! : null;

  const vsTargetHours = round1(latest.avgHoursWorked - targetHours);
  const weekOverWeekLiftHours = previous
    ? round1(latest.avgHoursWorked - previous.avgHoursWorked)
    : null;
  const weekOverWeekLiftPct =
    previous && previous.avgHoursWorked > 0 && weekOverWeekLiftHours != null
      ? round1((weekOverWeekLiftHours / previous.avgHoursWorked) * 100)
      : null;

  const recent = points.slice(-8);
  const bestWeek = [...recent].sort((a, b) => b.avgHoursWorked - a.avgHoursWorked)[0]!;
  const worstWeek = [...recent].sort((a, b) => a.avgHoursWorked - b.avgHoursWorked)[0]!;

  return {
    targetHours,
    latestWeek: {
      label: latest.weekLabel,
      avgHours: latest.avgHoursWorked,
      count: latest.employeeCount,
    },
    previousWeek: previous
      ? { label: previous.weekLabel, avgHours: previous.avgHoursWorked }
      : null,
    weekOverWeek: { liftHours: weekOverWeekLiftHours, liftPct: weekOverWeekLiftPct },
    vsTarget: { deltaHours: vsTargetHours, met: latest.avgHoursWorked >= targetHours },
    vsBaseline: {
      priorAvg: trend.priorAverageHours,
      liftHours: trend.liftHours,
      liftPct: trend.liftPct,
    },
    bestRecentWeek: { label: bestWeek.weekLabel, avgHours: bestWeek.avgHoursWorked },
    worstRecentWeek: { label: worstWeek.weekLabel, avgHours: worstWeek.avgHoursWorked },
    weeks: points.map((p) => ({
      label: p.weekLabel,
      avg: p.avgHoursWorked,
      vsTarget: round1(p.avgHoursWorked - targetHours),
      vsBaseline: round1(p.avgHoursWorked - trend.priorAverageHours),
    })),
  };
}

export type WeeklyPacingInsightsInput = {
  report: WeeklyPacingReport;
  summary: {
    metTarget: number;
    underTarget: number;
    critical: number;
    atRisk: number;
    behind: number;
  };
  filterSummary: string | null;
  rows: WeeklyPacingRow[];
  trend?: WeeklyHoursTrendReport | null;
};

function compactForLlm(input: WeeklyPacingInsightsInput) {
  const activeRows = input.rows.filter((r) => r.active);
  const targetHours = input.report.targetHours;

  const critical = activeRows.filter((r) => r.status === "critical").map(compactRow);
  const atRisk = activeRows.filter((r) => r.status === "at_risk").map(compactRow);
  const behind = activeRows.filter((r) => r.status === "behind").map(compactRow);

  const topPerformers = [...activeRows]
    .filter((r) => r.metTarget)
    .sort((a, b) => b.hoursOver - a.hoursOver || b.hoursWorked - a.hoursWorked)
    .slice(0, 12)
    .map(compactRow);

  const onTrackNames = activeRows
    .filter((r) => r.status === "on_track")
    .map((r) => r.name);

  const targetMetNames = activeRows
    .filter((r) => r.metTarget && r.status !== "on_track")
    .map((r) => r.name);

  return {
    company: input.report.company.name,
    week: input.report.week,
    today: input.report.today,
    targetHours,
    activeCount: activeRows.length,
    weekProgress: {
      elapsed: input.report.elapsedWorkDays,
      total: input.report.totalWorkDays,
      remaining: input.report.remainingWorkDays,
    },
    filters: input.filterSummary,
    summary: summarizeActiveRows(activeRows),
    aggregate: aggregateStats(activeRows, targetHours),
    byLocation: groupStats(activeRows, (r) => r.location?.trim() || "Not set"),
    byTeam: groupStats(activeRows, (r) => r.team?.trim() || "Not set"),
    byManager: groupStats(activeRows, (r) => r.managerName?.trim() || "Not set").slice(0, 15),
    needsAttention: { critical, atRisk, behind },
    topPerformers,
    onTrack: { count: onTrackNames.length, names: onTrackNames.slice(0, 30) },
    targetMet: { count: targetMetNames.length, names: targetMetNames.slice(0, 30) },
    warnings: input.report.warnings,
    trend: buildTrendAnalysis(input.trend, targetHours),
  };
}

const INSIGHTS_SYSTEM_PROMPT = [
  "You are Alyson Weekly Pacing Analyst for Cintara. Write an executive Markdown report for ACTIVE employees only.",
  "Use ONLY the JSON facts. Cite names, hours, and percentages. Never invent data or mention inactive staff.",
  "",
  "Sections (exact headings):",
  "## Executive summary",
  "## Week context",
  "## Headline metrics",
  "## Trend & baseline analysis",
  "## Location breakdown",
  "## Team breakdown",
  "## Manager view",
  "## Critical & at-risk employees",
  "## On-track & target-met highlights",
  "## Behind pace (recoverable)",
  "## Recommended actions",
  "## Watch list for next week",
  "",
  "Cover every person in needsAttention (critical, atRisk, behind) with hrs, pace, rem, reqDay, mgr.",
  "For trend section use trend.weeks if present. Be thorough but avoid repeating the same bullet twice.",
].join("\n");

export async function generateWeeklyPacingInsights(input: WeeklyPacingInsightsInput) {
  const activeCount = input.rows.filter((r) => r.active).length;
  const modelHint = pacingInsightsModels()[0] || groqModel();

  if (!activeCount) {
    return {
      insightsMd: "No active employees in the current view — widen filters or confirm the Cintara roster.",
      model: modelHint,
    };
  }

  const payload = compactForLlm(input);
  const userContent = `Weekly pacing data (compact JSON):\n${JSON.stringify(payload)}`;

  const result = await chatForInsights([
    { role: "system", content: INSIGHTS_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ]);

  return {
    insightsMd: result.content || "No insights generated.",
    model: `${result.provider}:${result.model}`,
  };
}
