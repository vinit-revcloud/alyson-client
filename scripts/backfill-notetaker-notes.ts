/**
 * Generate notes.md in S3 for ALL meetings that have transcript.txt but no notes.md.
 * Usage: dotenv -e .env -- npx tsx scripts/backfill-notetaker-notes.ts
 */
import { backfillAllMissingNotesFromS3 } from "../src/lib/notetaker-auto-persist.server";

console.log("Starting company-wide notes backfill…\n");

const result = await backfillAllMissingNotesFromS3();

console.log(`Attempted:  ${result.attempted}`);
console.log(`Succeeded:  ${result.succeeded}`);
console.log(`Failed:     ${result.failed}`);
console.log(`Remaining:  ${result.remainingMissing}\n`);

if (result.failed) {
  console.log("--- Failures ---");
  for (const r of result.results.filter((x) => !x.ok)) {
    console.log(`  ${r.prefix} (${r.skipped ?? "unknown"})`);
  }
}

process.exit(result.remainingMissing > 0 ? 1 : 0);
