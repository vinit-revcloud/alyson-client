import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import type { EmployeeFull } from "@/lib/queries";
import { archiveObjectKey, archiveS3JsonBeforeWrite } from "@/lib/s3-archive.server";

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
          CreateBucketConfiguration: { LocationConstraint: region as any },
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
  if (e.name === "NoSuchKey" || e.Code === "NoSuchKey") return true;
  if (e.$metadata?.httpStatusCode === 404) return true;
  return false;
}

export type OrgChartTerminationRecord = {
  employeeId: string;
  fullName: string;
  role: string | null;
  departmentName: string | null;
  isDummy: boolean;
  terminatedAt: string;
  previousManagerId: string | null;
  reparentedToManagerId: string | null;
  reason: string | null;
};

export type OrgChartAuditEventType =
  | "manager_change"
  | "terminate"
  | "add_person"
  | "positions_saved"
  | "reset"
  | "publish";

export type OrgChartAuditPayload = Record<string, any>;

export type OrgChartAuditEvent = {
  id: string;
  at: string;
  type: OrgChartAuditEventType;
  payload: OrgChartAuditPayload;
};

export type OrgChartSnapshot = {
  version: 1;
  updatedAt: string;
  positions: Record<string, { x: number; y: number }>;
  managerOverrides: Record<string, string | null>;
  terminated: OrgChartTerminationRecord[];
  added: EmployeeFull[];
  events: OrgChartAuditEvent[];
};

const DEFAULT_BUCKET = "alyson-hr-orgchart";

export function bucketName() {
  return process.env.ALYSON_HR_ORGCHART_S3_BUCKET || DEFAULT_BUCKET;
}

/**
 * Object layout (isolated by concern):
 *
 *   alyson-hr-orgchart/
 *     main/state.json                  // positions + managerOverrides (the live org graph)
 *     terminations/index.json          // array of TerminationRecord
 *     additions/index.json             // array of added EmployeeFull (dummies + admin-added)
 *     logs/index.json                  // full append-only event index (no cap)
 *     logs/by-date/<YYYY-MM-DD>/<id>.json  // one immutable file per event (full audit history)
 */
export const ORGCHART_KEYS = {
  main: "main/state.json",
  roster: "roster/overview.json",
  terminations: "terminations/index.json",
  additions: "additions/index.json",
  logsIndex: "logs/index.json",
  logEventFile(at: string, id: string) {
    const day = at.slice(0, 10); // YYYY-MM-DD
    return `logs/by-date/${day}/${id}.json`;
  },
} as const;

export type OrgChartRosterFile = {
  version: 1;
  updatedAt: string;
  source: string;
  employees: Array<{
    id: string;
    full_name: string;
    email: string;
    role: string;
    level: string;
    department_id: string;
    department_name: string;
    manager_id: string | null;
    manager_name: string | null;
  }>;
};

async function getJson<T>(key: string): Promise<T | null> {
  const bucket = bucketName();
  try {
    const r = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!r.Body) return null;
    const text = await streamToString(r.Body);
    return JSON.parse(text) as T;
  } catch (err) {
    if (isMissingObjectError(err)) return null;
    throw err;
  }
}

async function putJson(key: string, body: unknown, metaKind: string, updatedAt: string) {
  const bucket = bucketName();
  const client = s3();
  await ensureBucketExists(bucket);
  await archiveS3JsonBeforeWrite(client, bucket, key);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(body, null, 2),
      ContentType: "application/json; charset=utf-8",
      Metadata: {
        "x-amz-meta-kind": metaKind,
        "x-amz-meta-updated-at": updatedAt,
      },
    }),
  );
}

/** Full snapshot copy before any destructive org-chart operation (nothing is deleted from S3). */
async function archiveFullOrgChartSnapshot(reason: string) {
  const snap = await readOrgChartFromS3();
  const at = new Date();
  const key = archiveObjectKey(`orgchart__full__${reason}`, at);
  const bucket = bucketName();
  const client = s3();
  await ensureBucketExists(bucket);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify({ ...snap, archiveReason: reason, archivedAt: at.toISOString() }, null, 2),
      ContentType: "application/json; charset=utf-8",
      Metadata: {
        "x-amz-meta-kind": "alyson-orgchart-full-archive",
        "x-amz-meta-reason": reason,
      },
    }),
  );
  return key;
}

type MainFile = {
  version: 1;
  updatedAt: string;
  positions: Record<string, { x: number; y: number }>;
  managerOverrides: Record<string, string | null>;
};

type TerminationsFile = {
  version: 1;
  updatedAt: string;
  records: OrgChartTerminationRecord[];
};

type AdditionsFile = {
  version: 1;
  updatedAt: string;
  people: EmployeeFull[];
};

type LogsIndexFile = {
  version: 1;
  updatedAt: string;
  events: OrgChartAuditEvent[];
};

export function makeEmptyOrgChartSnapshot(): OrgChartSnapshot {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    positions: {},
    managerOverrides: {},
    terminated: [],
    added: [],
    events: [],
  };
}

export async function readOrgChartFromS3(): Promise<OrgChartSnapshot> {
  const [main, terms, adds, logs] = await Promise.all([
    getJson<MainFile>(ORGCHART_KEYS.main),
    getJson<TerminationsFile>(ORGCHART_KEYS.terminations),
    getJson<AdditionsFile>(ORGCHART_KEYS.additions),
    getJson<LogsIndexFile>(ORGCHART_KEYS.logsIndex),
  ]);

  const updatedAt = [main?.updatedAt, terms?.updatedAt, adds?.updatedAt, logs?.updatedAt]
    .filter((s): s is string => Boolean(s))
    .sort()
    .pop() ?? new Date(0).toISOString();

  return {
    version: 1,
    updatedAt,
    positions: main?.positions ?? {},
    managerOverrides: main?.managerOverrides ?? {},
    terminated: terms?.records ?? [],
    added: adds?.people ?? [],
    events: logs?.events ?? [],
  };
}

/** Diff helper used to decide which "directories" to touch on partial writes. */
function shallowEqualMap<V>(a: Record<string, V>, b: Record<string, V>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!(k in b)) return false;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

function arraysEqualById<T extends { employeeId?: string; id?: string }>(a: T[], b: T[]) {
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export type WriteParts = {
  positions?: Record<string, { x: number; y: number }>;
  managerOverrides?: Record<string, string | null>;
  terminated?: OrgChartTerminationRecord[];
  added?: EmployeeFull[];
  event?: { type: OrgChartAuditEventType; payload?: OrgChartAuditPayload };
};

/**
 * Write only the parts that changed. When an event is provided, appends an immutable
 * file under logs/by-date/<YYYY-MM-DD>/<id>.json and appends the same event to logs/index.json
 * (full history, no cap).
 */
export async function writeOrgChartToS3(parts: WriteParts) {
  const bucket = bucketName();
  await ensureBucketExists(bucket);

  const existing = await readOrgChartFromS3();
  const updatedAt = new Date().toISOString();

  const nextPositions = parts.positions ?? existing.positions;
  const nextManagerOverrides = parts.managerOverrides ?? existing.managerOverrides;
  const nextTerminated = parts.terminated ?? existing.terminated;
  const nextAdded = parts.added ?? existing.added;

  const ops: Promise<unknown>[] = [];

  // 1) Main (positions + managerOverrides) — only write if changed.
  const mainChanged =
    !shallowEqualMap(nextPositions, existing.positions) ||
    !shallowEqualMap(nextManagerOverrides, existing.managerOverrides);
  if (mainChanged) {
    const mainFile: MainFile = {
      version: 1,
      updatedAt,
      positions: nextPositions,
      managerOverrides: nextManagerOverrides,
    };
    ops.push(putJson(ORGCHART_KEYS.main, mainFile, "alyson-orgchart-main", updatedAt));
  }

  // 2) Terminations directory.
  if (parts.terminated && !arraysEqualById(nextTerminated, existing.terminated)) {
    const file: TerminationsFile = {
      version: 1,
      updatedAt,
      records: nextTerminated,
    };
    ops.push(
      putJson(ORGCHART_KEYS.terminations, file, "alyson-orgchart-terminations", updatedAt),
    );
  }

  // 3) Additions directory.
  if (parts.added && !arraysEqualById(nextAdded, existing.added)) {
    const file: AdditionsFile = {
      version: 1,
      updatedAt,
      people: nextAdded,
    };
    ops.push(putJson(ORGCHART_KEYS.additions, file, "alyson-orgchart-additions", updatedAt));
  }

  // 4) Logging directory: per-event immutable file + rolling index.
  let appendedEvent: OrgChartAuditEvent | null = null;
  if (parts.event) {
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    appendedEvent = {
      id,
      at: updatedAt,
      type: parts.event.type,
      payload: parts.event.payload ?? {},
    };
    ops.push(
      putJson(
        ORGCHART_KEYS.logEventFile(updatedAt, id),
        appendedEvent,
        "alyson-orgchart-log-event",
        updatedAt,
      ),
    );
    // logs/index.json keeps the FULL event history (no rolling cap).
    const events = [...existing.events, appendedEvent];
    const logIndex: LogsIndexFile = { version: 1, updatedAt, events };
    ops.push(putJson(ORGCHART_KEYS.logsIndex, logIndex, "alyson-orgchart-logs-index", updatedAt));
  }

  await Promise.all(ops);

  return {
    bucket,
    updatedAt,
    written: {
      main: mainChanged,
      terminations: parts.terminated !== undefined && !arraysEqualById(nextTerminated, existing.terminated),
      additions: parts.added !== undefined && !arraysEqualById(nextAdded, existing.added),
      log: Boolean(appendedEvent),
    },
    event: appendedEvent,
    snapshot: {
      version: 1 as const,
      updatedAt,
      positions: nextPositions,
      managerOverrides: nextManagerOverrides,
      terminated: nextTerminated,
      added: nextAdded,
      events: appendedEvent ? [...existing.events, appendedEvent] : existing.events,
    } satisfies OrgChartSnapshot,
  };
}

/**
 * Clears only draft layout + manager overrides on the live chart.
 * Terminations, additions, and all log files are preserved.
 * A full snapshot is archived under archive/ before any live keys change.
 */
export async function resetOrgChartOnS3() {
  const archiveKey = await archiveFullOrgChartSnapshot("reset-draft");
  return writeOrgChartToS3({
    positions: {},
    managerOverrides: {},
    event: {
      type: "reset",
      payload: {
        resetAt: new Date().toISOString(),
        scope: "positions_and_overrides_only",
        archiveKey,
      },
    },
  });
}

/** Canonical HR roster copy stored alongside org-chart state (same bucket). */
export async function writeOrgChartRosterToS3(
  employees: Array<{
    id: string;
    full_name: string;
    email: string;
    role: string;
    level: string;
    department_id: string;
    department_name: string;
    manager_id?: string | null;
    manager_name?: string | null;
  }>,
  source = "revcloud",
) {
  const updatedAt = new Date().toISOString();
  const file: OrgChartRosterFile = {
    version: 1,
    updatedAt,
    source,
    employees: employees.map((e) => ({
      id: e.id,
      full_name: e.full_name,
      email: e.email,
      role: e.role,
      level: e.level,
      department_id: e.department_id,
      department_name: e.department_name,
      manager_id: e.manager_id ?? null,
      manager_name: e.manager_name ?? null,
    })),
  };
  await putJson(ORGCHART_KEYS.roster, file, "alyson-orgchart-roster", updatedAt);
  return { bucket: bucketName(), key: ORGCHART_KEYS.roster, updatedAt };
}
