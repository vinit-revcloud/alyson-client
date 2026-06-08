/**
 * Manual trigger for transcript cron (local dev or CI).
 * Usage: dotenv -e .env -- npm run cron:notetaker-transcripts
 */
const base = (process.env.CRON_BASE_URL || "http://localhost:3001").replace(/\/$/, "");
const secret =
  process.env.NOTETAKER_TRANSCRIPT_CRON_SECRET?.trim() ||
  process.env.CRON_SECRET?.trim() ||
  "";

const headers = secret ? { Authorization: `Bearer ${secret}` } : {};

const res = await fetch(`${base}/api/cron/notetaker-transcripts`, {
  method: "POST",
  headers,
});

const body = await res.text();
console.log(res.status, body);

if (!res.ok) process.exit(1);
