import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getNotetakerSessionsIndexFromS3 } from "@/lib/notetaker-sessions-s3.server";
import { buildNotetakerSessionsList } from "@/lib/notetaker-sessions-list.server";
import { maintainNotetakerSessionsCatalog } from "@/lib/notetaker-session-catalog.server";
import { invalidatePersistedSessionsS3Cache } from "@/lib/notetaker-sessions-history.server";

export const getNotetakerSessionsIndexFromS3Fn = createServerFn({ method: "GET" }).handler(async () => {
  return await getNotetakerSessionsIndexFromS3();
});

const SyncInput = z.object({
  persistOnly: z.boolean().optional(),
});

export const syncNotetakerSessionsIndexToS3 = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => SyncInput.parse(data))
  .handler(async () => {
    const live = await buildNotetakerSessionsList();
    invalidatePersistedSessionsS3Cache();
    await maintainNotetakerSessionsCatalog(live.sessions ?? []);
    return { count: live.sessions.length, syncedAt: new Date().toISOString() };
  });

