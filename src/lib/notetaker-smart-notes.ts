import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { listDeepseekModels } from "@/lib/groq-chat.server";

const Input = z.object({
  title: z.string().optional(),
  transcriptText: z.string().min(1).max(500_000),
});

export const listMeetingAiModels = createServerFn({ method: "GET" }).handler(async () => {
  const deepseek = await listDeepseekModels().catch(() => []);
  return { deepseek };
});

export const generateSmartMeetingNotes = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }) => {
    const { runSmartMeetingNotes } = await import("@/lib/notetaker-smart-notes.server");
    return runSmartMeetingNotes(data);
  });
