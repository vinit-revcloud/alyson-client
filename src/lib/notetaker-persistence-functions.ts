import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { persistMeetingToS3 } from "@/lib/notetaker-persistence.server";
import { getNotetakerSession } from "@/lib/notetaker-get-session-functions";
import { generateNotetakerNotes } from "@/lib/alyson-notetaker-functions";

const BotIdInput = z.object({ botId: z.string().min(1) });

export const finalizeAndPersistNotetakerSession = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => BotIdInput.parse(data))
  .handler(async ({ data }) => {
    const sess = await getNotetakerSession({ data: { botId: data.botId } });

    let notes: { notesMd: string; model?: string } | null = null;
    try {
      const res = await generateNotetakerNotes({ data: { botId: data.botId, prompt: "" } });
      notes = { notesMd: res.notes, model: res.model };
    } catch {
      // notes are optional; persistence should still succeed
    }

    const persisted = await persistMeetingToS3({
      session: sess.session,
      lines: sess.lines ?? [],
      notes,
    });

    return { persisted };
  });

