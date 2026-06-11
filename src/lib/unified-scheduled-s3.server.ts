import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";

export type UnifiedScheduledStateEntry = {
  dedupeKey: string;
  googleEventId: string;
  iCalUID: string;
  calendarUserEmail: string;
  title?: string;
  meetingUrl: string;
  startTime: string;
  endTime?: string;
  botJoinAt: string;
  recallBotId: string;
  /** Recall Calendar V2 event id — strict match for Smart schedule UI persistence. */
  recallCalendarEventId?: string;
  creationSource?: "notetaker_managed" | "direct_recall_fallback" | "recall_calendar_v2";
  scheduledAt: string;
  status:
    | "scheduled"
    | "dispatched"
    | "joining"
    | "in_call"
    | "done"
    | "failed"
    | "no_transcript";
  /** Last known Notetaker / Recall upstream status string. */
  upstreamStatus?: string;
  lastStatusAt?: string;
  transcriptLineCount?: number;
  lastTranscriptAt?: string;
  transcriptWebhookUrl?: string;
  joinedAt?: string;
  endedAt?: string;
  lastError?: string;
};

export type UnifiedScheduledState = {
  version: 1;
  updatedAt: string;
  scheduled: UnifiedScheduledStateEntry[];
};

const STATE_KEY = "alyson-notetaker/unified-scheduled/index.json";

function s3Configured() {
  const bucket = process.env.AWS_S3_BUCKET?.trim() || process.env.S3_BUCKET?.trim();
  return Boolean(
    bucket &&
      process.env.AWS_ACCESS_KEY_ID?.trim() &&
      process.env.AWS_SECRET_ACCESS_KEY?.trim(),
  );
}

export function unifiedScheduledStateUsesS3() {
  const mode = String(process.env.UNIFIED_SCHEDULED_STATE_SOURCE ?? "auto").trim().toLowerCase();
  if (mode === "file") return false;
  if (mode === "s3") return s3Configured();
  return s3Configured();
}

function requireEnvAlias(primary: string, aliases: string[]) {
  const v = process.env[primary] || aliases.map((a) => process.env[a]).find(Boolean);
  if (!v) throw new Error(`Missing ${primary} (required for unified schedule S3)`);
  return v;
}

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} (required for unified schedule S3)`);
  return v;
}

function s3() {
  const region = requireEnvAlias("AWS_REGION", ["S3_REGION"]);
  return new S3Client({
    region,
    credentials: {
      accessKeyId: requireEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY"),
    },
  });
}

function bucketName() {
  return requireEnvAlias("AWS_S3_BUCKET", ["S3_BUCKET"]);
}

async function streamToString(stream: unknown) {
  const readable = stream as Readable;
  const chunks: Buffer[] = [];
  for await (const c of readable) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

async function ensureBucketExists(bucket: string) {
  const client = s3();
  const region = requireEnvAlias("AWS_REGION", ["S3_REGION"]);
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return;
  } catch {
    // create if missing (dev)
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

export async function readUnifiedScheduledStateFromS3(): Promise<UnifiedScheduledState> {
  const bucket = bucketName();
  const client = s3();
  try {
    const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: STATE_KEY }));
    if (!r.Body) return emptyState();
    const parsed = JSON.parse(await streamToString(r.Body)) as UnifiedScheduledState;
    return normalizeState(parsed);
  } catch (e: unknown) {
    const code = (e as { name?: string })?.name;
    if (code === "NoSuchKey" || code === "NotFound") return emptyState();
    throw e;
  }
}

export async function writeUnifiedScheduledStateToS3(state: UnifiedScheduledState): Promise<void> {
  const bucket = bucketName();
  await ensureBucketExists(bucket);
  const body: UnifiedScheduledState = {
    version: 1,
    updatedAt: new Date().toISOString(),
    scheduled: state.scheduled ?? [],
  };
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: STATE_KEY,
      Body: JSON.stringify(body, null, 2),
      ContentType: "application/json; charset=utf-8",
      Metadata: { kind: "alyson-unified-scheduled-state" },
    }),
  );
}

function emptyState(): UnifiedScheduledState {
  return { version: 1, updatedAt: new Date().toISOString(), scheduled: [] };
}

function normalizeState(raw: unknown): UnifiedScheduledState {
  if (!raw || typeof raw !== "object") return emptyState();
  const o = raw as Partial<UnifiedScheduledState>;
  const scheduled = Array.isArray(o.scheduled) ? o.scheduled : [];
  return {
    version: 1,
    updatedAt: String(o.updatedAt || new Date().toISOString()),
    scheduled: scheduled.filter((s) => s && typeof s === "object" && s.recallBotId && s.dedupeKey),
  };
}
