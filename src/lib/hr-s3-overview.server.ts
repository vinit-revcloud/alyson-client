import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import type { Department, Employee, Compensation, MetricsRow } from "@/lib/queries";
import { isGenericPlaceholderRoster, revcloudOverviewParts } from "@/lib/revcloud-overview";
import { archiveS3JsonBeforeWrite } from "@/lib/s3-archive.server";

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
    // fall through to create
  }

  const cmd =
    region === "us-east-1"
      ? new CreateBucketCommand({ Bucket: bucket })
      : new CreateBucketCommand({
          Bucket: bucket,
          CreateBucketConfiguration: { LocationConstraint: region },
        });

  await client.send(cmd);
}

async function streamToString(stream: any) {
  const readable = stream as Readable;
  const chunks: Buffer[] = [];
  for await (const c of readable) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

export type HrOverviewSnapshot = {
  version: 1;
  generatedAt: string;
  source: "supabase" | "demo" | "revcloud";
  departments: Department[];
  employees: Employee[];
  compensation: Compensation[];
  history: MetricsRow[];
};

export class HrOverviewWriteBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HrOverviewWriteBlockedError";
  }
}

function bucketName() {
  // Requested default bucket name; allow override via env.
  return process.env.ALYSON_HR_S3_BUCKET || "alyson-hr-dummy-datas";
}

function overviewKey() {
  return process.env.ALYSON_HR_S3_KEY || "alyson-hr/overview.json";
}

function isMissingObjectError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  if (e.name === "NoSuchKey" || e.Code === "NoSuchKey") return true;
  if (e.$metadata?.httpStatusCode === 404) return true;
  return false;
}

function buildRevcloudSnapshot(): HrOverviewSnapshot {
  const parts = revcloudOverviewParts();
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "revcloud",
    departments: parts.departments,
    employees: parts.employees,
    compensation: parts.compensation,
    history: parts.history,
  };
}

/** Never overwrite a real roster with generic Employee 1…N placeholders. */
async function assertSafeOverviewWrite(snapshot: HrOverviewSnapshot) {
  if (!isGenericPlaceholderRoster(snapshot.employees)) return;
  try {
    const existing = await getHrOverviewSnapshotFromS3();
    if (!isGenericPlaceholderRoster(existing.employees)) {
      throw new HrOverviewWriteBlockedError(
        "Refusing to replace the RevCloud team roster in S3 with generic placeholder employees. Use source=revcloud.",
      );
    }
  } catch (err) {
    if (err instanceof HrOverviewWriteBlockedError) throw err;
    if (!isMissingObjectError(err)) throw err;
  }
}

export async function putHrOverviewSnapshotToS3(snapshot: HrOverviewSnapshot) {
  await assertSafeOverviewWrite(snapshot);
  const bucket = bucketName();
  const client = s3();
  await ensureBucketExists(bucket);
  const key = overviewKey();
  await archiveS3JsonBeforeWrite(client, bucket, key);
  const body = JSON.stringify(snapshot, null, 2);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/json; charset=utf-8",
      Metadata: {
        "x-amz-meta-kind": "alyson-hr-overview",
        "x-amz-meta-version": String(snapshot.version),
        "x-amz-meta-generated-at": snapshot.generatedAt,
        "x-amz-meta-source": snapshot.source,
      },
    }),
  );
  return { bucket, key, generatedAt: snapshot.generatedAt };
}

export async function getHrOverviewSnapshotFromS3(): Promise<HrOverviewSnapshot> {
  const bucket = bucketName();
  const r = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: overviewKey() }));
  if (!r.Body) throw new Error("Overview snapshot not found in S3");
  const text = await streamToString(r.Body);
  const parsed = JSON.parse(text) as HrOverviewSnapshot;
  if (!parsed || parsed.version !== 1) throw new Error("Invalid overview snapshot format");
  return parsed;
}

/**
 * S3 is the source of truth. If the live snapshot is missing or placeholder-only,
 * seed the canonical RevCloud roster (previous live copy is archived automatically).
 */
export async function getOrSeedHrOverviewFromS3(): Promise<HrOverviewSnapshot> {
  try {
    const snap = await getHrOverviewSnapshotFromS3();
    if (!isGenericPlaceholderRoster(snap.employees)) return snap;
    const seeded = buildRevcloudSnapshot();
    await putHrOverviewSnapshotToS3(seeded);
    return seeded;
  } catch (err) {
    if (!isMissingObjectError(err)) throw err;
    const seeded = buildRevcloudSnapshot();
    await putHrOverviewSnapshotToS3(seeded);
    return seeded;
  }
}

