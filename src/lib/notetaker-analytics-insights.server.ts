import type { NotetakerAnalyticsReport } from "@/lib/notetaker-analytics.server";

async function groqChat(messages: { role: "system" | "user" | "assistant"; content: string }[]) {
  const apiKey = process.env.ALYSON_MINI_MODULE_AI_API_KEY || process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("Missing GROQ_API_KEY (set GROQ_API_KEY or ALYSON_MINI_MODULE_AI_API_KEY)");

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
    const msg = json?.error?.message || text.slice(0, 300) || `Groq request failed (${r.status})`;
    throw new Error(String(msg));
  }
  return String(json?.choices?.[0]?.message?.content || "").trim();
}

function compactReportForLlm(report: NotetakerAnalyticsReport) {
  return {
    range: report.range,
    analyzedMeetings: report.analyzedCount,
    uniqueSpeakers: report.uniqueSpeakersGlobal,
    totalUtterances: report.totalUtterances,
    topSpeakers: report.topSpeakers.slice(0, 15).map((s) => ({
      speaker: s.speaker,
      utterances: s.utterances,
      words: s.words,
      meetings: s.meetingsSpoken,
    })),
    recentMeetings: report.meetings.slice(0, 12).map((m) => ({
      title: m.title,
      day: m.day,
      speakers: m.speakers.slice(0, 8).map((s) => ({ name: s.speaker, utterances: s.utterances })),
    })),
    filters: report.filters,
  };
}

export async function generateNotetakerAnalyticsInsights(report: NotetakerAnalyticsReport) {
  const sys = [
    "You are Alyson Meeting Analytics.",
    "Analyze speaker participation stats from meeting transcripts.",
    "Output concise Markdown with sections:",
    "- Participation overview",
    "- Most active speakers (with evidence from counts only)",
    "- Meetings with uneven participation (if data supports it)",
    "- Suggested follow-ups for HR/ops",
    "Use only facts from the JSON. Do not invent speakers or meetings.",
    "If data is sparse, say so briefly.",
  ].join("\n");

  const insights = await groqChat([
    { role: "system", content: sys },
    { role: "user", content: `Analytics JSON:\n\n${JSON.stringify(compactReportForLlm(report), null, 2)}` },
  ]);

  return {
    insightsMd: insights || "No insights generated.",
    model: process.env.ALYSON_MINI_MODULE_AI_MODEL || process.env.GROQ_MODEL || "llama-3.1-8b-instant",
  };
}
