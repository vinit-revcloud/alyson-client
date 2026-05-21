import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getNotetakerSession } from "@/lib/notetaker-get-session-functions";
import { autoPersistEndedMeetingToS3 } from "@/lib/notetaker-auto-persist.server";

const BotIdInput = z.object({ botId: z.string().min(1) });

/** Manual persist (overwrites S3, regenerates notes). Auto-persist runs when a meeting ends. */
export const finalizeAndPersistNotetakerSession = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => BotIdInput.parse(data))
  .handler(async ({ data }) => {
    const sess = await getNotetakerSession({ data: { botId: data.botId } });

    const result = await autoPersistEndedMeetingToS3({
      session: sess.session,
      lines: sess.lines ?? [],
      existingNotesMd: sess.notesMd,
      existingNotesModel: sess.notesModel,
      force: true,
      forceNotes: true,
    });

    if (!result.persisted && result.skipped === "empty_transcript") {
      throw new Error("No transcript lines to persist.");
    }

    return {
      persisted: {
        botId: data.botId,
        persisted: result.persisted,
        skipped: result.skipped,
      },
    };
  });

