import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { sendMeetingNotesEmail } from "@/lib/meeting-notes-email.server";
import { ensureMeetingNotesInS3 } from "@/lib/notetaker-auto-persist.server";
import {
  isCallEndedGraceElapsed,
  isNotesEmailStaleFallback,
  isNotesReadyUnsentCatchup,
  isTranscriptIdleStable,
  meetingEndMarkersPresent,
  notesIdleStableMs,
  nextTranscriptIdleFields,
} from "@/lib/notetaker-persistence.server";
import { buildS3Metadata } from "@/lib/s3-metadata.server";
import { s3CostAllocationTagging } from "@/lib/s3-cost-tags.server";
import { loadBotIndexDoc, listAllBotIndexDocs } from "@/lib/notetaker-sessions-history.server";

export type AutoMeetingNotesEmailResult = {
  botId: string;
  attempted: boolean;
  sent: boolean;
  skipped?: string;
  recipients?: string[];
  error?: string;
  /** How long the transcript has been unchanged (ms), when known. */
  idleMs?: number;
  /** Required idle window before notes+email (ms). */
  requiredIdleMs?: number;
  notesGenerated?: boolean;
};

export type AutoMeetingNotesEmailSweepResult = {
  scanned: number;
  attempted: number;
  sent: number;
  skipped: number;
  errors: number;
  results: AutoMeetingNotesEmailResult[];
};

type NotesEmailLockDoc = {
  version: 1;
  botId: string;
  claimId: string;
  claimedAt: string;
  status: "claimed" | "sent" | "failed";
  messageId?: string | null;
  recipients?: string[] | null;
  error?: string | null;
  sentAt?: string | null;
};

/** Stale in-flight claim: allow a new worker to reclaim (SES hung / crashed mid-send). */
const CLAIM_STALE_MS = 20 * 60_000;

/** Set NOTETAKER_NOTES_AUTO_EMAIL=false to generate notes after idle but skip SES. */
function notesAutoEmailEnabled(): boolean {
  return String(process.env.NOTETAKER_NOTES_AUTO_EMAIL ?? "true").trim().toLowerCase() !== "false";
}

/**
 * Prefer end markers. Otherwise:
 * - notes already on S3 + idle → send now (past stuck meetings)
 * - catch-up window (default 1h) → generate notes + send
 */
function meetingEligibleForNotesEmail(index: {
  recallCallEndedAt?: string | null;
  cronFinalized?: boolean;
  cronFinalizedAt?: string | null;
  finalizedAt?: string | null;
  meetingStartedAt?: string | null;
  prefix?: string | null;
  title?: string | null;
  notesKey?: string | null;
  notesEmailSentAt?: string | null;
  transcriptHash?: string | null;
  transcriptUnchangedSince?: string | null;
}): { eligible: boolean; via: "ended_markers" | "notes_ready_catchup" | "stale_fallback" | null } {
  if (meetingEndMarkersPresent(index)) return { eligible: true, via: "ended_markers" };
  if (isNotesReadyUnsentCatchup(index)) return { eligible: true, via: "notes_ready_catchup" };
  if (isNotesEmailStaleFallback(index)) return { eligible: true, via: "stale_fallback" };
  return { eligible: false, via: null };
}

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function requireEnvAlias(primary: string, aliases: string[]) {
  const v = process.env[primary] || aliases.map((a) => process.env[a]).find(Boolean);
  if (!v) throw new Error(`Missing ${primary}`);
  return v;
}

function s3() {
  return new S3Client({
    region: requireEnvAlias("AWS_REGION", ["S3_REGION"]),
    credentials: {
      accessKeyId: requireEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY"),
    },
  });
}

function bucketName() {
  return requireEnvAlias("AWS_S3_BUCKET", ["S3_BUCKET"]);
}

function botIndexKey(botId: string) {
  return `alyson-notetaker/bot-index/${encodeURIComponent(botId)}.json`;
}

function notesEmailLockKey(botId: string) {
  return `alyson-notetaker/notes-email-locks/${encodeURIComponent(botId)}.json`;
}

async function streamToString(body: { transformToString?: () => Promise<string> } | unknown): Promise<string> {
  if (body && typeof (body as { transformToString?: () => Promise<string> }).transformToString === "function") {
    return (body as { transformToString: () => Promise<string> }).transformToString();
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function loadNotesEmailLock(botId: string): Promise<NotesEmailLockDoc | null> {
  try {
    const r = await s3().send(
      new GetObjectCommand({
        Bucket: bucketName(),
        Key: notesEmailLockKey(botId),
      }),
    );
    if (!r.Body) return null;
    const parsed = JSON.parse(await streamToString(r.Body)) as NotesEmailLockDoc;
    if (!parsed || parsed.version !== 1 || String(parsed.botId) !== botId) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function putNotesEmailLock(doc: NotesEmailLockDoc, opts?: { createOnly?: boolean }) {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: notesEmailLockKey(doc.botId),
      Body: JSON.stringify(doc, null, 2),
      ContentType: "application/json; charset=utf-8",
      Tagging: s3CostAllocationTagging("notetaker", "notes-email-lock"),
      Metadata: buildS3Metadata({ kind: "alyson-notetaker-notes-email-lock", botid: doc.botId }),
      ...(opts?.createOnly ? { IfNoneMatch: "*" } : {}),
    }),
  );
}

async function deleteNotesEmailLock(botId: string) {
  try {
    await s3().send(
      new DeleteObjectCommand({
        Bucket: bucketName(),
        Key: notesEmailLockKey(botId),
      }),
    );
  } catch {
    // best-effort
  }
}

function isPreconditionFailed(e: unknown): boolean {
  const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    err?.name === "PreconditionFailed" ||
    err?.Code === "PreconditionFailed" ||
    err?.$metadata?.httpStatusCode === 412
  );
}

/**
 * Atomic-ish send claim via S3 create-only lock object (If-None-Match: *).
 * Only one concurrent worker can win; losers skip without calling SES.
 */
async function claimNotesEmailSend(
  botId: string,
): Promise<{ ok: true; claimId: string; claimedAt: string } | { ok: false; reason: string }> {
  const existing = await loadNotesEmailLock(botId);
  if (existing?.status === "sent" || existing?.sentAt) {
    return { ok: false, reason: "already_sent_lock" };
  }
  if (existing?.status === "claimed") {
    const age = Date.now() - Date.parse(existing.claimedAt);
    if (Number.isFinite(age) && age < CLAIM_STALE_MS) {
      return { ok: false, reason: "send_in_progress" };
    }
    // Stale claim â delete so we can create-only again.
    await deleteNotesEmailLock(botId);
  } else if (existing?.status === "failed") {
    await deleteNotesEmailLock(botId);
  }

  const claimId = randomUUID();
  const claimedAt = new Date().toISOString();
  const doc: NotesEmailLockDoc = {
    version: 1,
    botId,
    claimId,
    claimedAt,
    status: "claimed",
  };

  try {
    await putNotesEmailLock(doc, { createOnly: true });
  } catch (e) {
    if (isPreconditionFailed(e)) {
      const again = await loadNotesEmailLock(botId);
      if (again?.status === "sent" || again?.sentAt) return { ok: false, reason: "already_sent_lock" };
      return { ok: false, reason: "send_in_progress" };
    }
    throw e;
  }

  // Mirror claim onto bot-index for ops visibility (non-atomic; lock is source of truth).
  const index = await loadBotIndexDoc(botId).catch(() => null);
  if (index?.prefix) {
    try {
      await s3().send(
        new PutObjectCommand({
          Bucket: bucketName(),
          Key: botIndexKey(botId),
          Body: JSON.stringify(
            {
              ...index,
              notesEmailClaimAt: claimedAt,
              notesEmailClaimId: claimId,
            },
            null,
            2,
          ),
          ContentType: "application/json; charset=utf-8",
          Tagging: s3CostAllocationTagging("notetaker", "bot-index"),
          Metadata: buildS3Metadata({ kind: "alyson-notetaker-bot-index", botid: botId }),
        }),
      );
    } catch {
      // lock already won; index mirror is best-effort
    }
  }

  return { ok: true, claimId, claimedAt };
}

/**
 * Persist delivery metadata after SES succeeds (auto or manual).
 * Creates/updates the lock object so auto-send never races a manual send.
 */
export async function recordMeetingNotesEmailSent(
  botId: string,
  args: { sentAt: string; messageId?: string; recipients: string[]; claimId?: string },
): Promise<void> {
  const id = String(botId || "").trim();
  if (!id) return;

  const lock: NotesEmailLockDoc = {
    version: 1,
    botId: id,
    claimId: args.claimId || randomUUID(),
    claimedAt: args.sentAt,
    status: "sent",
    sentAt: args.sentAt,
    messageId: args.messageId ?? null,
    recipients: args.recipients,
  };
  await putNotesEmailLock(lock);

  const index = await loadBotIndexDoc(id);
  if (!index?.prefix) return;

  await s3().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: botIndexKey(id),
      Body: JSON.stringify(
        {
          ...index,
          notesEmailSentAt: args.sentAt,
          notesEmailMessageId: args.messageId ?? null,
          notesEmailRecipients: args.recipients,
          notesEmailClaimAt: index.notesEmailClaimAt ?? args.sentAt,
          notesEmailClaimId: args.claimId ?? index.notesEmailClaimId ?? lock.claimId,
        },
        null,
        2,
      ),
      ContentType: "application/json; charset=utf-8",
      Tagging: s3CostAllocationTagging("notetaker", "bot-index"),
      Metadata: buildS3Metadata({ kind: "alyson-notetaker-bot-index", botid: id }),
    }),
  );
}

async function markNotesEmailFailed(botId: string, claimId: string, error: string): Promise<void> {
  const existing = await loadNotesEmailLock(botId);
  if (existing && existing.claimId !== claimId) return;
  await putNotesEmailLock({
    version: 1,
    botId,
    claimId,
    claimedAt: existing?.claimedAt || new Date().toISOString(),
    status: "failed",
    error,
  });
}

/** Backfill transcriptUnchangedSince when older bot-index rows lack it. */
async function ensureTranscriptIdleMarker(
  botId: string,
  index: NonNullable<Awaited<ReturnType<typeof loadBotIndexDoc>>>,
): Promise<NonNullable<Awaited<ReturnType<typeof loadBotIndexDoc>>>> {
  if (index.transcriptUnchangedSince && Number.isFinite(Date.parse(index.transcriptUnchangedSince))) {
    return index;
  }
  if (!index.transcriptHash) return index;

  const idle = nextTranscriptIdleFields({
    previousHash: null,
    previousUnchangedSince: null,
    currentHash: index.transcriptHash,
    // Prefer known finalize/end markers so we don't restart the 15m clock from "now".
    nowIso:
      index.cronFinalizedAt ||
      index.recallCallEndedAt ||
      index.finalizedAt ||
      new Date().toISOString(),
  });

  await s3().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: botIndexKey(botId),
      Body: JSON.stringify({ ...index, ...idle }, null, 2),
      ContentType: "application/json; charset=utf-8",
      Tagging: s3CostAllocationTagging("notetaker", "bot-index"),
      Metadata: buildS3Metadata({ kind: "alyson-notetaker-bot-index", botid: botId }),
    }),
  );

  return { ...index, ...idle };
}

function idleAgeMs(index: { transcriptUnchangedSince?: string | null }): number | undefined {
  const since = Date.parse(String(index.transcriptUnchangedSince || ""));
  if (!Number.isFinite(since)) return undefined;
  return Math.max(0, Date.now() - since);
}

/**
 * Pipeline (post-meeting only):
 * 1) Meeting ended (end markers) OR notes-ready catch-up OR stale unsent (≥1h)
 * 2) Transcript hash unchanged for >=15 min (skipped for stale fallback)
 * 3) Generate notes from the full transcript (if missing)
 * 4) Claim S3 email lock, then SES (idempotent -- never double-send)
 */
export async function maybeAutoSendMeetingNotesEmail(
  botId: string,
  options?: { force?: boolean; bypassIdleGate?: boolean; bypassMeetingEndedGate?: boolean },
): Promise<AutoMeetingNotesEmailResult> {
  const id = String(botId || "").trim();
  const requiredIdleMs = notesIdleStableMs();
  if (!id) {
    return { botId: "", attempted: false, sent: false, skipped: "missing_bot_id", requiredIdleMs };
  }

  let index = await loadBotIndexDoc(id).catch(() => null);
  if (!index?.prefix) {
    return { botId: id, attempted: false, sent: false, skipped: "no_bot_index", requiredIdleMs };
  }
  if (!options?.force && index.notesEmailSentAt) {
    return { botId: id, attempted: false, sent: false, skipped: "already_sent", requiredIdleMs };
  }
  const existingLock = await loadNotesEmailLock(id).catch(() => null);
  if (!options?.force && (existingLock?.status === "sent" || existingLock?.sentAt)) {
    return { botId: id, attempted: false, sent: false, skipped: "already_sent_lock", requiredIdleMs };
  }
  if (index.supersededByBotId) {
    return { botId: id, attempted: false, sent: false, skipped: "superseded", requiredIdleMs };
  }
  if (!index.transcriptKey || !index.transcriptHash) {
    return { botId: id, attempted: false, sent: false, skipped: "no_transcript", requiredIdleMs };
  }

  const eligibility = meetingEligibleForNotesEmail(index);
  // Recall confirmed the call ended → the transcript is final; no need to wait 15 min of silence.
  const catchupBypassIdle =
    eligibility.via === "stale_fallback" ||
    eligibility.via === "notes_ready_catchup" ||
    isCallEndedGraceElapsed(index);
  // Never generate/send from a still-live meeting (partial transcript risk),
  // unless catch-up says this meeting already has notes / is past the short window.
  if (!options?.force && !options?.bypassMeetingEndedGate && !eligibility.eligible) {
    return {
      botId: id,
      attempted: false,
      sent: false,
      skipped: "meeting_not_ended",
      requiredIdleMs,
    };
  }

  index = await ensureTranscriptIdleMarker(id, index);
  const idleMs = idleAgeMs(index);
  if (
    !options?.bypassIdleGate &&
    !options?.force &&
    !catchupBypassIdle &&
    !isTranscriptIdleStable(index)
  ) {
    return {
      botId: id,
      attempted: false,
      sent: false,
      skipped: "transcript_not_idle_15m",
      idleMs,
      requiredIdleMs,
    };
  }

  let notesGenerated = false;
  let notesMd = "";
  if (index.notesKey) {
    try {
      const { getNotesMdFromS3 } = await import("@/lib/notetaker-s3-calendar.server");
      notesMd = (await getNotesMdFromS3({ notesKey: index.notesKey })).trim();
    } catch {
      notesMd = "";
    }
  }
  if (!notesMd) {
    const ensured = await ensureMeetingNotesInS3(id);
    notesMd = String(ensured.notesMd || "").trim();
    notesGenerated = Boolean(notesMd);
  }
  if (!notesMd) {
    return {
      botId: id,
      attempted: false,
      sent: false,
      skipped: "no_notes",
      idleMs,
      requiredIdleMs,
      notesGenerated,
    };
  }

  // Notes are ready — optional kill-switch skips SES only.
  if (!notesAutoEmailEnabled() && !options?.force) {
    return {
      botId: id,
      attempted: false,
      sent: false,
      skipped: "auto_email_disabled",
      idleMs,
      requiredIdleMs,
      notesGenerated,
    };
  }

  // Claim BEFORE SES so concurrent cron / persist / listeners cannot all send.
  // `force` intentionally bypasses the lock (admin/manual resend).
  let claimId: string | undefined;
  if (!options?.force) {
    const claim = await claimNotesEmailSend(id);
    if (!claim.ok) {
      return {
        botId: id,
        attempted: false,
        sent: false,
        skipped: claim.reason,
        idleMs,
        requiredIdleMs,
        notesGenerated,
      };
    }
    claimId = claim.claimId;

    // Re-check bot-index after claim (another path may have marked sent while we prepared notes).
    const fresh = await loadBotIndexDoc(id).catch(() => null);
    if (fresh?.notesEmailSentAt) {
      await recordMeetingNotesEmailSent(id, {
        sentAt: fresh.notesEmailSentAt,
        messageId: fresh.notesEmailMessageId ?? undefined,
        recipients: fresh.notesEmailRecipients ?? [],
        claimId,
      });
      return {
        botId: id,
        attempted: false,
        sent: false,
        skipped: "already_sent",
        idleMs,
        requiredIdleMs,
        notesGenerated,
      };
    }
  }

  try {
    const sent = await sendMeetingNotesEmail({
      botId: id,
      notesMd,
      title: index.title,
    });
    await recordMeetingNotesEmailSent(id, {
      sentAt: new Date().toISOString(),
      messageId: sent.messageId,
      recipients: sent.recipients,
      claimId,
    });
    return {
      botId: id,
      attempted: true,
      sent: true,
      recipients: sent.recipients,
      idleMs,
      requiredIdleMs,
      notesGenerated,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (claimId) await markNotesEmailFailed(id, claimId, msg).catch(() => {});
    return {
      botId: id,
      attempted: true,
      sent: false,
      error: msg,
      skipped: "send_failed",
      idleMs,
      requiredIdleMs,
      notesGenerated,
    };
  }
}

const MAX_AUTO_EMAILS_PER_SWEEP = 20;

/**
 * Cron sweep: ended+idle meetings, notes-ready catch-up, and short unsent fallback.
 */
export async function sweepAutoSendMeetingNotesEmails(): Promise<AutoMeetingNotesEmailSweepResult> {
  const docs = await listAllBotIndexDocs();
  const candidates = docs.filter((d) => {
    const botId = String(d.botId || "").trim();
    if (!botId || !d.prefix) return false;
    if (d.notesEmailSentAt) return false;
    if (d.supersededByBotId) return false;
    if (!d.transcriptKey || !d.transcriptHash) return false;
    const eligibility = meetingEligibleForNotesEmail(d);
    if (!eligibility.eligible) return false;
    if (eligibility.via === "stale_fallback" || eligibility.via === "notes_ready_catchup") return true;
    if (isCallEndedGraceElapsed(d)) return true;
    return isTranscriptIdleStable(d) || Boolean(d.transcriptUnchangedSince);
  });

  // Prefer notes-ready + stale catch-up first so stuck past meetings clear quickly.
  candidates.sort((a, b) => {
    const rank = (d: typeof a) => {
      if (isCallEndedGraceElapsed(d)) return -1; // just-finished meetings first
      const via = meetingEligibleForNotesEmail(d).via;
      if (via === "notes_ready_catchup") return 0;
      if (via === "stale_fallback") return 1;
      return 2;
    };
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const aIdle = Date.parse(String(a.transcriptUnchangedSince || "")) || 0;
    const bIdle = Date.parse(String(b.transcriptUnchangedSince || "")) || 0;
    return aIdle - bIdle;
  });

  const result: AutoMeetingNotesEmailSweepResult = {
    scanned: candidates.length,
    attempted: 0,
    sent: 0,
    skipped: 0,
    errors: 0,
    results: [],
  };

  for (const doc of candidates.slice(0, MAX_AUTO_EMAILS_PER_SWEEP)) {
    const row = await maybeAutoSendMeetingNotesEmail(String(doc.botId));
    result.results.push(row);
    if (row.attempted) result.attempted += 1;
    if (row.sent) result.sent += 1;
    else if (row.error) result.errors += 1;
    else result.skipped += 1;
  }

  return result;
}
