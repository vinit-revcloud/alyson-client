/**
 * Audit Alyson Notetaker S3: transcripts vs notes.md coverage.
 * Usage: dotenv -e .env -- node scripts/audit-notetaker-s3-notes.mjs
 */
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET;
if (!bucket) throw new Error("Missing AWS_S3_BUCKET or S3_BUCKET");

const s3 = new S3Client({
  region: process.env.AWS_REGION || process.env.S3_REGION,
  credentials: {
    accessKeyId: requireEnv("AWS_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY"),
  },
});

async function listAssetPrefixes(base, fileName) {
  const out = new Set();
  const suffix = `/${fileName}`;
  let token;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: base, ContinuationToken: token }),
    );
    for (const obj of page.Contents ?? []) {
      const key = String(obj.Key || "");
      if (!key.endsWith(suffix)) continue;
      const prefix = key.slice(base.length, key.length - suffix.length);
      if (prefix) out.add(prefix);
    }
    token = page.NextContinuationToken;
  } while (token);
  return out;
}

const transcriptBase = "alyson-notetaker/transcripts/";
const notesBase = "alyson-notetaker/meetingnotes/";

console.log(`Auditing bucket: ${bucket}\n`);

const [transcriptPrefixes, notesPrefixes] = await Promise.all([
  listAssetPrefixes(transcriptBase, "transcript.txt"),
  listAssetPrefixes(notesBase, "notes.md"),
]);

const missing = [...transcriptPrefixes].filter((p) => !notesPrefixes.has(p));

console.log(`Transcript files:  ${transcriptPrefixes.size}`);
console.log(`Notes files:       ${notesPrefixes.size}`);
console.log(`✓ Both:            ${transcriptPrefixes.size - missing.length}`);
console.log(`✗ Missing notes:   ${missing.length}\n`);

if (missing.length) {
  console.log("--- Missing notes ---");
  for (const p of missing.slice(0, 30)) console.log(`  ${p}`);
  if (missing.length > 30) console.log(`  … and ${missing.length - 30} more`);
}

process.exit(missing.length > 0 ? 1 : 0);
