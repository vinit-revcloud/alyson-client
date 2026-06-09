import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import type {
  BonusCashEvent,
  BonusDataFile,
  BonusLogEntry,
  BonusOperation,
  EmployeeCompensationLedger,
  ShareEvent,
} from "@/lib/bonus-schema";
import { newBonusEventId, newShareEventId } from "@/lib/bonus-schema";
import { ensureOnboardingOnS3 } from "@/lib/onboarding-s3.server";
import type { OnboardingRow } from "@/lib/onboarding-schema";

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
  return process.env.ALYSON_HR_BONUS_S3_KEY || "bonus/data.json";
}

function logKey() {
  return process.env.ALYSON_HR_BONUS_LOG_S3_KEY || "bonus/operations.log.jsonl";
}

function employeeIdFromRow(row: OnboardingRow): string {
  return String(row["Employee ID"] ?? row._rowId ?? "").trim();
}

function ledgerFromOnboardingRow(
  row: OnboardingRow,
  existing?: EmployeeCompensationLedger | null,
): EmployeeCompensationLedger {
  const employeeId = employeeIdFromRow(row);
  const now = new Date().toISOString();
  return {
    employeeId,
    employeeName: String(row.Name ?? existing?.employeeName ?? "").trim() || employeeId,
    officialEmail: String(row["Official Email"] ?? existing?.officialEmail ?? "").trim(),
    jobTitle: String(row["Job Title"] ?? existing?.jobTitle ?? "").trim(),
    team: String(row.Team ?? existing?.team ?? "").trim(),
    location: String(row.Location ?? existing?.location ?? "").trim(),
    active: true,
    bonusEvents: existing?.bonusEvents ?? [],
    shareEvents: existing?.shareEvents ?? [],
    updatedAt: existing?.updatedAt ?? now,
  };
}

export function syncLedgersWithOnboarding(
  onboardingRows: OnboardingRow[],
  existing: Record<string, EmployeeCompensationLedger>,
): Record<string, EmployeeCompensationLedger> {
  const next: Record<string, EmployeeCompensationLedger> = {};
  const seen = new Set<string>();

  for (const row of onboardingRows) {
    const id = employeeIdFromRow(row);
    if (!id) continue;
    seen.add(id);
    next[id] = ledgerFromOnboardingRow(row, existing[id]);
  }

  for (const [id, ledger] of Object.entries(existing)) {
    if (seen.has(id)) continue;
    next[id] = { ...ledger, active: false };
  }

  return next;
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

export async function appendBonusLog(entry: BonusLogEntry) {
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
        "x-amz-meta-kind": "alyson-hr-bonus-log",
        "x-amz-meta-updated-at": entry.ts,
      },
    }),
  );

  return { bucket, key };
}

export async function getBonusOperationsLog(limit = 200): Promise<{
  entries: BonusLogEntry[];
  bucket: string;
  key: string;
}> {
  const bucket = bucketName();
  const key = logKey();
  const raw = await readLogTail();
  if (!raw.trim()) return { entries: [], bucket, key };

  const entries = raw
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as BonusLogEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is BonusLogEntry => e != null);

  return { entries: entries.slice(-limit).reverse(), bucket, key };
}

export async function getBonusFromS3(): Promise<{
  file: BonusDataFile | null;
  bucket: string;
  key: string;
}> {
  const bucket = bucketName();
  const key = dataKey();

  try {
    const r = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!r.Body) return { file: null, bucket, key };
    const parsed = JSON.parse(await streamToString(r.Body)) as BonusDataFile;
    return { file: parsed, bucket, key };
  } catch (err) {
    if (isMissingObjectError(err)) return { file: null, bucket, key };
    throw err;
  }
}

async function putBonusToS3(
  employees: Record<string, EmployeeCompensationLedger>,
  args: {
    op: BonusOperation;
    actor?: string | null;
    employeeId?: string | null;
    employeeName?: string | null;
    details?: string;
    event?: BonusCashEvent | ShareEvent;
    syncedFromOnboardingAt?: string | null;
  },
) {
  const bucket = bucketName();
  const key = dataKey();
  await ensureBucketExists(bucket);

  const updatedAt = new Date().toISOString();
  const body: BonusDataFile = {
    version: 1,
    updatedAt,
    syncedFromOnboardingAt: args.syncedFromOnboardingAt ?? updatedAt,
    employees,
  };

  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(body, null, 2),
      ContentType: "application/json; charset=utf-8",
      Metadata: {
        "x-amz-meta-kind": "alyson-hr-bonus-data",
        "x-amz-meta-updated-at": updatedAt,
      },
    }),
  );

  await appendBonusLog({
    ts: updatedAt,
    op: args.op,
    actor: args.actor ?? null,
    employeeId: args.employeeId ?? null,
    employeeName: args.employeeName ?? null,
    details: args.details,
    event: args.event,
    employeeCount: Object.keys(employees).length,
  });

  return { bucket, key, updatedAt, employees };
}

/** Load bonus ledger, syncing employee roster from onboarding S3 on every read. */
export async function ensureBonusOnS3(actor?: string | null) {
  const onboarding = await ensureOnboardingOnS3(actor);
  const existing = await getBonusFromS3();
  const prevEmployees = existing.file?.employees ?? {};
  const merged = syncLedgersWithOnboarding(onboarding.rows, prevEmployees);

  const prevCount = Object.keys(prevEmployees).length;
  const mergedCount = Object.keys(merged).length;
  const isBootstrap = prevCount === 0;
  const rosterChanged =
    !existing.file ||
    mergedCount !== prevCount ||
    onboarding.rows.some((row) => {
      const id = employeeIdFromRow(row);
      const prev = prevEmployees[id];
      if (!prev) return true;
      return (
        prev.employeeName !== String(row.Name ?? "").trim() ||
        prev.officialEmail !== String(row["Official Email"] ?? "").trim() ||
        prev.team !== String(row.Team ?? "").trim() ||
        prev.location !== String(row.Location ?? "").trim() ||
        prev.jobTitle !== String(row["Job Title"] ?? "").trim() ||
        !prev.active
      );
    });

  if (!isBootstrap && !rosterChanged && existing.file) {
    return {
      employees: merged,
      updatedAt: existing.file.updatedAt,
      syncedFromOnboardingAt: existing.file.syncedFromOnboardingAt,
      bucket: existing.bucket,
      key: existing.key,
      logKey: logKey(),
      onboardingUpdatedAt: onboarding.updatedAt,
    };
  }

  const saved = await putBonusToS3(merged, {
    op: isBootstrap ? "bootstrap" : "sync",
    actor: actor ?? null,
    details: isBootstrap
      ? `Bootstrapped bonus ledger for ${mergedCount} employees from onboarding`
      : `Synced roster with onboarding (${mergedCount} ledgers)`,
    syncedFromOnboardingAt: new Date().toISOString(),
  });

  return {
    employees: saved.employees,
    updatedAt: saved.updatedAt,
    syncedFromOnboardingAt: saved.updatedAt,
    bucket: saved.bucket,
    key: saved.key,
    logKey: logKey(),
    onboardingUpdatedAt: onboarding.updatedAt,
  };
}

export async function appendBonusCashEvent(args: {
  employeeId: string;
  amountUsd: number;
  paidOn: string;
  periodLabel?: string;
  note?: string;
  actor?: string | null;
}) {
  const data = await ensureBonusOnS3(args.actor ?? null);
  const ledger = data.employees[args.employeeId];
  if (!ledger) throw new Error("Employee not found in bonus ledger");

  const event: BonusCashEvent = {
    id: newBonusEventId(),
    amountUsd: args.amountUsd,
    paidOn: args.paidOn,
    periodLabel: args.periodLabel,
    note: args.note?.trim() || undefined,
    createdAt: new Date().toISOString(),
    createdBy: args.actor ?? null,
  };

  const employees = {
    ...data.employees,
    [args.employeeId]: {
      ...ledger,
      bonusEvents: [...ledger.bonusEvents, event],
      updatedAt: event.createdAt,
    },
  };

  const saved = await putBonusToS3(employees, {
    op: "append_bonus",
    actor: args.actor ?? null,
    employeeId: ledger.employeeId,
    employeeName: ledger.employeeName,
    details: `Recorded $${args.amountUsd.toLocaleString()} bonus paid ${args.paidOn}`,
    event,
    syncedFromOnboardingAt: data.syncedFromOnboardingAt,
  });

  return { event, ledger: saved.employees[args.employeeId]! };
}

export async function appendShareLedgerEvent(args: {
  employeeId: string;
  eventType: ShareEvent["eventType"];
  shares: number;
  effectiveDate: string;
  strikePriceUsd?: number | null;
  note?: string;
  actor?: string | null;
}) {
  const data = await ensureBonusOnS3(args.actor ?? null);
  const ledger = data.employees[args.employeeId];
  if (!ledger) throw new Error("Employee not found in bonus ledger");

  const event: ShareEvent = {
    id: newShareEventId(),
    eventType: args.eventType,
    shares: args.shares,
    effectiveDate: args.effectiveDate,
    strikePriceUsd: args.strikePriceUsd ?? null,
    note: args.note?.trim() || undefined,
    createdAt: new Date().toISOString(),
    createdBy: args.actor ?? null,
  };

  const employees = {
    ...data.employees,
    [args.employeeId]: {
      ...ledger,
      shareEvents: [...ledger.shareEvents, event],
      updatedAt: event.createdAt,
    },
  };

  const saved = await putBonusToS3(employees, {
    op: "append_share",
    actor: args.actor ?? null,
    employeeId: ledger.employeeId,
    employeeName: ledger.employeeName,
    details: `Recorded ${args.eventType}: ${args.shares} shares on ${args.effectiveDate}`,
    event,
    syncedFromOnboardingAt: data.syncedFromOnboardingAt,
  });

  return { event, ledger: saved.employees[args.employeeId]! };
}

export async function voidBonusCashEvent(args: {
  employeeId: string;
  eventId: string;
  actor?: string | null;
}) {
  const data = await ensureBonusOnS3(args.actor ?? null);
  const ledger = data.employees[args.employeeId];
  if (!ledger) throw new Error("Employee not found in bonus ledger");

  const removed = ledger.bonusEvents.find((e) => e.id === args.eventId);
  if (!removed) throw new Error("Bonus payment not found");

  const employees = {
    ...data.employees,
    [args.employeeId]: {
      ...ledger,
      bonusEvents: ledger.bonusEvents.filter((e) => e.id !== args.eventId),
      updatedAt: new Date().toISOString(),
    },
  };

  const saved = await putBonusToS3(employees, {
    op: "void_bonus",
    actor: args.actor ?? null,
    employeeId: ledger.employeeId,
    employeeName: ledger.employeeName,
    details: `Removed accidental bonus $${removed.amountUsd.toLocaleString()} paid ${removed.paidOn} (snapshot kept in audit log)`,
    event: removed,
    syncedFromOnboardingAt: data.syncedFromOnboardingAt,
  });

  return { removed, ledger: saved.employees[args.employeeId]! };
}

export async function voidShareLedgerEvent(args: {
  employeeId: string;
  eventId: string;
  actor?: string | null;
}) {
  const data = await ensureBonusOnS3(args.actor ?? null);
  const ledger = data.employees[args.employeeId];
  if (!ledger) throw new Error("Employee not found in bonus ledger");

  const removed = ledger.shareEvents.find((e) => e.id === args.eventId);
  if (!removed) throw new Error("Share event not found");

  const employees = {
    ...data.employees,
    [args.employeeId]: {
      ...ledger,
      shareEvents: ledger.shareEvents.filter((e) => e.id !== args.eventId),
      updatedAt: new Date().toISOString(),
    },
  };

  const saved = await putBonusToS3(employees, {
    op: "void_share",
    actor: args.actor ?? null,
    employeeId: ledger.employeeId,
    employeeName: ledger.employeeName,
    details: `Removed accidental ${removed.eventType} (${removed.shares} shares on ${removed.effectiveDate}) — snapshot kept in audit log`,
    event: removed,
    syncedFromOnboardingAt: data.syncedFromOnboardingAt,
  });

  return { removed, ledger: saved.employees[args.employeeId]! };
}
