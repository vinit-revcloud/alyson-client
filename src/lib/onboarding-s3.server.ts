import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { BUNDLED_ONBOARDING_ROSTER_CSV } from "@/lib/bundled-data";
import { parseOnboardingCsv } from "@/lib/onboarding-csv";
import type {
  OnboardingDataFile,
  OnboardingLogEntry,
  OnboardingOperation,
  OnboardingRow,
} from "@/lib/onboarding-schema";

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} (required for S3)`);
  return v;
}

function requireEnvAlias(primary: string, aliases: string[]) {
  const v = process.env[primary] || aliases.map((a) => process.env[a]).find(Boolean);
  if (!v) throw new Error(`Missing ${primary} (required for S3)`);
  return v;
}

function s3() {
  const region = requireEnvAlias("AWS_REGION", ["S3_REGION"]);
  const accessKeyId = requireEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("AWS_SECRET_ACCESS_KEY");
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

async function ensureBucketExists(bucket: string) {
  const client = s3();
  const region = requireEnvAlias("AWS_REGION", ["S3_REGION"]);
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return;
  } catch {
    // create below
  }
  const cmd =
    region === "us-east-1"
      ? new CreateBucketCommand({ Bucket: bucket })
      : new CreateBucketCommand({
          Bucket: bucket,
          CreateBucketConfiguration: { LocationConstraint: region as never },
        });
  await client.send(cmd);
}

async function streamToString(stream: unknown) {
  const readable = stream as Readable;
  const chunks: Buffer[] = [];
  for await (const c of readable) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

function isMissingObjectError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NoSuchKey" || e.Code === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
}

function bucketName() {
  return process.env.ALYSON_HR_ORGCHART_S3_BUCKET || "alyson-hr-orgchart";
}

function dataKey() {
  return process.env.ALYSON_HR_ONBOARDING_S3_KEY || "onboarding/data.json";
}

function logKey() {
  return process.env.ALYSON_HR_ONBOARDING_LOG_S3_KEY || "onboarding/operations.log.jsonl";
}

function normalizeRows(rows: OnboardingRow[]): OnboardingRow[] {
  return [...rows].sort((a, b) => {
    const an = (a.Name || a["Employee ID"] || "").toLowerCase();
    const bn = (b.Name || b["Employee ID"] || "").toLowerCase();
    return an.localeCompare(bn, undefined, { sensitivity: "base" });
  });
}

function sanitizeRows(rows: OnboardingRow[]): OnboardingRow[] {
  return normalizeRows(
    rows
      .filter((r) => r && typeof r === "object")
      .map((r) => {
        const employeeId = String(r["Employee ID"] ?? r._rowId ?? "").trim();
        const rowId = employeeId || String(r._rowId ?? "");
        return { ...r, _rowId: rowId, "Employee ID": employeeId || rowId } as OnboardingRow;
      })
      .filter((r) => r._rowId || r.Name || r["Official Email"] || r["Personal Email"]),
  );
}

function loadSeedRows(): OnboardingRow[] {
  return sanitizeRows(parseOnboardingCsv(BUNDLED_ONBOARDING_ROSTER_CSV));
}

async function readLogTail(): Promise<string> {
  const bucket = bucketName();
  const key = logKey();
  try {
    const r = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!r.Body) return "";
    return await streamToString(r.Body);
  } catch (err) {
    if (isMissingObjectError(err)) return "";
    throw err;
  }
}

export async function appendOnboardingLog(entry: OnboardingLogEntry) {
  const bucket = bucketName();
  const key = logKey();
  await ensureBucketExists(bucket);

  const line = `${JSON.stringify(entry)}\n`;
  const existing = await readLogTail();
  const body = existing + line;

  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/x-ndjson; charset=utf-8",
      Metadata: {
        "x-amz-meta-kind": "alyson-hr-onboarding-log",
        "x-amz-meta-updated-at": entry.ts,
      },
    }),
  );

  return { bucket, key };
}

export async function getOnboardingFromS3(): Promise<{
  rows: OnboardingRow[];
  updatedAt: string | null;
  bucket: string;
  key: string;
}> {
  const bucket = bucketName();
  const key = dataKey();

  try {
    const r = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!r.Body) {
      return { rows: [], updatedAt: null, bucket, key };
    }
    const parsed = JSON.parse(await streamToString(r.Body)) as OnboardingDataFile;
    const rows = sanitizeRows(Array.isArray(parsed?.rows) ? parsed.rows : []);
    return { rows, updatedAt: parsed?.updatedAt ?? null, bucket, key };
  } catch (err) {
    if (isMissingObjectError(err)) {
      return { rows: [], updatedAt: null, bucket, key };
    }
    throw err;
  }
}

export async function putOnboardingToS3(
  rows: OnboardingRow[],
  args?: {
    op?: OnboardingOperation;
    actor?: string | null;
    employeeId?: string | null;
    details?: string;
  },
) {
  const bucket = bucketName();
  const key = dataKey();
  await ensureBucketExists(bucket);

  const updatedAt = new Date().toISOString();
  const sanitized = sanitizeRows(rows);
  const body: OnboardingDataFile = {
    version: 1,
    updatedAt,
    rows: sanitized,
  };

  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(body, null, 2),
      ContentType: "application/json; charset=utf-8",
      Metadata: {
        "x-amz-meta-kind": "alyson-hr-onboarding-data",
        "x-amz-meta-updated-at": updatedAt,
      },
    }),
  );

  await appendOnboardingLog({
    ts: updatedAt,
    op: args?.op ?? "bulk_replace",
    employeeId: args?.employeeId ?? null,
    actor: args?.actor ?? null,
    rowCount: sanitized.length,
    details: args?.details,
  });

  return { bucket, key, updatedAt, rows: sanitized };
}

/** Load from S3, or seed from bundled CSV on first use. */
export async function ensureOnboardingOnS3(actor?: string | null) {
  const existing = await getOnboardingFromS3();
  if (existing.rows.length) return existing;

  const seed = loadSeedRows();
  if (!seed.length) return existing;

  const saved = await putOnboardingToS3(seed, {
    op: "bootstrap",
    actor: actor ?? null,
    details: `Seeded ${seed.length} rows from onboarding-roster.csv`,
  });

  return {
    rows: saved.rows,
    updatedAt: saved.updatedAt,
    bucket: saved.bucket,
    key: saved.key,
  };
}

export async function deleteOnboardingRowFromS3(
  employeeId: string,
  actor?: string | null,
) {
  const existing = await ensureOnboardingOnS3(actor);
  const next = existing.rows.filter(
    (r) => r._rowId !== employeeId && r["Employee ID"] !== employeeId,
  );
  if (next.length === existing.rows.length) {
    throw new Error("Employee not found");
  }
  const saved = await putOnboardingToS3(next, {
    op: "delete",
    actor: actor ?? null,
    employeeId,
    details: `Deleted employee ${employeeId}`,
  });
  return saved;
}
