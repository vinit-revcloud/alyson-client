/** Bearer auth for `/api/cron/notetaker-transcripts`. */
export function assertNotetakerTranscriptCronAuth(request: Request): Response | null {
  const secret =
    process.env.NOTETAKER_TRANSCRIPT_CRON_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim();
  if (!secret) {
    if (process.env.VERCEL || process.env.NODE_ENV === "production") {
      return Response.json(
        { error: "NOTETAKER_TRANSCRIPT_CRON_SECRET (or CRON_SECRET) is not configured" },
        { status: 503 },
      );
    }
    return null;
  }
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export function notetakerTranscriptCronEnabled(): boolean {
  return String(process.env.NOTETAKER_TRANSCRIPT_CRON_ENABLED ?? "true").trim().toLowerCase() !== "false";
}
