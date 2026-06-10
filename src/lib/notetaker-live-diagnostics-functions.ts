import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { buildNotetakerLiveDiagnostics } from "@/lib/notetaker-live-diagnostics.server";

const BotIdInput = z.object({ botId: z.string().min(1) });

export const getNotetakerLiveDiagnostics = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => BotIdInput.parse(data))
  .handler(async ({ data }) => buildNotetakerLiveDiagnostics(data.botId));
