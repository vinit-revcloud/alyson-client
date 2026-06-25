import { deepseekApiKey, deepseekChat, resolveDeepseekModel, type GroqMessage } from "@/lib/groq-chat.server";

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

async function deepseekNotesChat(messages: GroqMessage[], model: string): Promise<string> {
  return deepseekChat(messages, 0.2, { model });
}

export async function runSmartMeetingNotes(data: { title?: string; transcriptText: string }) {
  if (!deepseekApiKey()) {
    throw new Error("Missing DEEPSEEK_API_KEY — meeting notes require DeepSeek.");
  }

  const title = (data.title || "Meeting").trim();
  const transcript = String(data.transcriptText || "").trim();
  const model = await resolveDeepseekModel();

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
    const summary = await deepseekNotesChat(
      [
        { role: "system", content: sys },
        {
          role: "user",
          content: `Meeting: ${title}\n\nChunk ${idx + 1}/${chunks.length}:\n${part}`,
        },
      ],
      model,
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

  const combined = await deepseekNotesChat(
    [
      { role: "system", content: combineSys },
      {
        role: "user",
        content: `Meeting: ${title}\n\nChunk summaries:\n\n${chunkSummaries.join("\n\n---\n\n")}`,
      },
    ],
    model,
  );

  const notes = combined.trim();
  if (!notes) throw new Error("DeepSeek returned empty notes");

  return {
    notes,
    model,
    strategy: chunks.length > 1 ? "chunked" : "single",
    chunks: chunks.length,
  };
}
