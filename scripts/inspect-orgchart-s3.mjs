import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

const bucket = process.env.ALYSON_HR_ORGCHART_S3_BUCKET || "alyson-hr-orgchart";
const s3 = new S3Client({
  region: process.env.AWS_REGION || process.env.S3_REGION,
  credentials: {
    accessKeyId: requireEnv("AWS_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY"),
  },
});

async function getJson(key) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await Buffer.from(await r.Body.transformToByteArray()).toString("utf8");
    return JSON.parse(text);
  } catch (e) {
    return { error: String(e) };
  }
}

async function list(prefix) {
  const out = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    out.push(...(r.Contents ?? []).map((o) => o.Key));
    token = r.NextContinuationToken;
  } while (token);
  return out;
}

const terms = await getJson("terminations/index.json");
const adds = await getJson("additions/index.json");
const main = await getJson("main/state.json");
const logs = await getJson("logs/index.json");

console.log("=== bucket", bucket, "===");
console.log("\n--- terminations ---");
console.log(JSON.stringify(terms, null, 2)?.slice(0, 8000));

console.log("\n--- additions ---");
console.log(JSON.stringify(adds, null, 2)?.slice(0, 8000));

console.log("\n--- main overrides count ---", Object.keys(main?.managerOverrides ?? {}).length);

const events = logs?.events ?? [];
console.log("\n--- log events count ---", events.length);

const needles = ["wisha", "thiru", "dummy", "terminate", "add_person"];
for (const n of needles) {
  const hits = events.filter(
    (e) =>
      JSON.stringify(e).toLowerCase().includes(n) ||
      (e.payload?.fullName && String(e.payload.fullName).toLowerCase().includes(n)),
  );
  console.log(`\n--- events matching "${n}": ${hits.length} ---`);
  for (const h of hits.slice(-8)) {
    console.log(h.at, h.type, h.payload?.fullName ?? h.payload?.employeeName ?? JSON.stringify(h.payload).slice(0, 120));
  }
}

const archiveKeys = await list("archive/");
console.log("\n--- archive objects ---", archiveKeys.length);
for (const k of archiveKeys.slice(-15)) console.log(k);

const logFiles = await list("logs/by-date/");
console.log("\n--- per-event log files ---", logFiles.length);
