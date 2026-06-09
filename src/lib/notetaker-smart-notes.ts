import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  deepseekApiKey,
  groqApiKey,
  isAiRateLimitOrQuotaError,
  meetingAiChat,
  type GroqMessage,
} from "@/lib/groq-chat.server";

const Input = z.object({
  title: z.string().optional(),
  transcriptText: z.string().min(1).max(500_000),
});

function chunkText(text: string, chunkSize: number, overlap: number) {
  const out: string[] = [];
  const t = String(text || "");
  let i = 0;
  while (i < t.length) {
    const end = Math.min(t.length, i + chunkSize);
    out.push(t.slice(i, end));
    if (end >= t.length) break;
    i = Math.max(0, end - overlap);
  }
  return out;
}

async function aiChat(
  messages: GroqMessage[],
  providerRef: { current: "groq" | "deepseek" | null },
): Promise<string> {
  try {
    const res = await meetingAiChat(messages, 0.2, providerRef.current ? { provider: providerRef.current } : undefined);
    providerRef.current = res.provider;
    return res.content;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (providerRef.current !== "deepseek" && deepseekApiKey() && isAiRateLimitOrQuotaError(msg)) {
      providerRef.current = "deepseek";
      const res = await meetingAiChat(messages, 0.2, { provider: "deepseek" });
      return res.content;
    }
    throw e;
  }
}

export async function runSmartMeetingNotes(data: { title?: string; transcriptText: string }) {
  if (!groqApiKey() && !deepseekApiKey()) {
    throw new Error("Missing AI key — set GROQ_API_KEY or DEEPSEEK_API_KEY in .env");
  }

  const title = (data.title || "Meeting").trim();
  const transcript = String(data.transcriptText || "").trim();
  const providerRef: { current: "groq" | "deepseek" | null } = { current: groqApiKey() ? "groq" : "deepseek" };

  const chunks =
    transcript.length <= 12_000 ? [transcript] : chunkText(transcript, 10_000, 800).slice(0, 20);
  const chunkSummaries: string[] = [];

  for (let idx = 0; idx < chunks.length; idx++) {
    const part = chunks[idx];
    const sys = [
      "You are Alyson Notetaker.",
      "Summarize the transcript chunk into high-signal bullet points.",
      "Extract: decisions, action items (with owner if mentioned), risks/blockers, and key context.",
      "Be concise. Do not hallucinate names or facts not in the chunk.",
    ].join("\n");
    const summary = await aiChat(
      [
        { role: "system", content: sys },
        { role: "user", content: `Meeting: ${title}\n\nChunk ${idx + 1}/${chunks.length}:\n${part}` },
      ],
      providerRef,
    );
    if (summary) chunkSummaries.push(summary);
  }

  const combineSys = [
    "You are Alyson Notetaker.",
    "Combine multiple chunk summaries into final meeting notes.",
    "Output in Markdown with these sections (only include sections that have content):",
    "- Summary",
    "- Decisions",
    "- Action items",
    "- Risks / blockers",
    "- Open questions",
    "Keep it tight and operational.",
    "Do not invent details not present in the summaries.",
  ].join("\n");

  const combined = await aiChat(
    [
      { role: "system", content: combineSys },
      { role: "user", content: `Meeting: ${title}\n\nChunk summaries:\n\n${chunkSummaries.join("\n\n---\n\n")}` },
    ],
    providerRef,
  );

  const notes = combined.trim();
  if (!notes) throw new Error("AI returned empty notes");

  return {
    notes,
    model: providerRef.current === "deepseek" ? "deepseek-chat" : "groq",
    strategy: chunks.length > 1 ? "chunked" : "single",
    chunks: chunks.length,
  };
}

export const generateSmartMeetingNotes = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }) => runSmartMeetingNotes(data));
