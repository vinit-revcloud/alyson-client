import { createFileRoute } from "@tanstack/react-router";
import { assertNotetakerTranscriptCronAuth } from "@/lib/notetaker-cron-auth.server";
import { runNotetakerTranscriptCron } from "@/lib/notetaker-transcript-cron.server";

export const Route = createFileRoute("/api/cron/notetaker-transcripts")({
  server: {
    handlers: {
      GET: async ({ request }) => runCron(request),
      POST: async ({ request }) => runCron(request),
    },
  },
});

async function runCron(request: Request) {
  const authFail = assertNotetakerTranscriptCronAuth(request);
  if (authFail) return authFail;

  try {
    const result = await runNotetakerTranscriptCron();
    console.info("[cron/notetaker-transcripts]", JSON.stringify(result));
    return Response.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Transcript cron failed";
    console.error("[cron/notetaker-transcripts]", message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
