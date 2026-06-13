import type { RecallCostReport } from "@/lib/recall-cost-report.server";

async function groqChat(messages: { role: "system" | "user" | "assistant"; content: string }[]) {
  const apiKey = process.env.ALYSON_MINI_MODULE_AI_API_KEY || process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("AI insights are not configured (set ALYSON_MINI_MODULE_AI_API_KEY).");

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.ALYSON_MINI_MODULE_AI_MODEL || process.env.GROQ_MODEL || "llama-3.1-8b-instant",
      temperature: 0.2,
      messages,
    }),
  });

  const text = await r.text();
  let json: { choices?: { message?: { content?: string } }[]; error?: { message?: string } } | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  if (!r.ok) {
    const msg = json?.error?.message || text.slice(0, 300) || `AI insights request failed (${r.status})`;
    throw new Error(String(msg));
  }
  return String(json?.choices?.[0]?.message?.content || "").trim();
}

function compactReportForLlm(report: RecallCostReport) {
  const peakDay = [...report.daily].sort((a, b) => b.totalCostUsd - a.totalCostUsd)[0];
  const avgMeetingsPerDay =
    report.daily.length > 0
      ? report.daily.reduce((s, d) => s + d.meetings, 0) / report.daily.length
      : 0;

  return {
    range: report.range,
    botHours: report.usage.botTotalHours,
    botUsageCostUsd: report.costs.botUsageCostUsd,
    transcriptUsageCostUsd: report.costs.transcriptUsageCostUsd,
    totalCostUsd: report.costs.totalUsageCostUsd,
    costPerMeetingUsd: report.costs.costPerMeetingUsd,
    meetings: report.meetings,
    calendarMonth: report.calendarMonth,
    rates: {
      botHourUsd: report.costs.botHourRateUsd,
      transcriptHourUsd: report.costs.transcriptHourRateUsd,
    },
    dailySummary: {
      days: report.daily.length,
      peakDay: peakDay
        ? { day: peakDay.day, totalCostUsd: peakDay.totalCostUsd, meetings: peakDay.meetings }
        : null,
      avgMeetingsPerDay,
    },
    recentDaily: report.daily.slice(-14).map((d) => ({
      day: d.day,
      botHours: d.botHours,
      botCostUsd: d.botCostUsd,
      transcriptCostUsd: d.transcriptCostUsd,
      totalCostUsd: d.totalCostUsd,
      meetings: d.meetings,
    })),
  };
}

export async function generateRecallCostInsights(report: RecallCostReport) {
  const sys = [
    "You are Alyson Recall Cost Analyst.",
    "Analyze Recall.ai bot + transcription usage costs for an HR ops team.",
    "Output concise Markdown with sections:",
    "- Cost summary (period + this calendar month)",
    "- Bot vs transcription cost split",
    "- Cost per meeting interpretation",
    "- 2–3 actionable efficiency recommendations",
    "Use only facts from the JSON. Do not invent numbers.",
    "If Recall is not configured or data is sparse, say so briefly.",
  ].join("\n");

  const insights = await groqChat([
    { role: "system", content: sys },
    { role: "user", content: `Recall cost JSON:\n\n${JSON.stringify(compactReportForLlm(report), null, 2)}` },
  ]);

  return {
    insightsMd: insights || "No insights generated.",
    model: process.env.ALYSON_MINI_MODULE_AI_MODEL || process.env.GROQ_MODEL || "llama-3.1-8b-instant",
  };
}
