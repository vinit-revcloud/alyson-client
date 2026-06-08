import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import type { NotetakerSession, NotetakerSessionPayload } from "@/lib/alyson-notetaker-functions";
import { getNotesMdFromS3, getTranscriptTextFromS3 } from "@/lib/notetaker-s3-calendar.server";
import {
  getNotetakerSessionsIndexFromS3,
  putNotetakerSessionsIndexToS3,
} from "@/lib/notetaker-sessions-s3.server";

function requireEnvAlias(primary: string, aliases: string[]) {
  const v = process.env[primary] || aliases.map((a) => process.env[a]).find(Boolean);
  if (!v) throw new Error(`Missing ${primary} (required for S3 session history)`);
  return v;
}

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} (required for S3 session history)`);
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

function parseMeetingPrefix(prefix: string) {
  const parts = prefix.split("_");
  const time = parts.pop() || "";
  const date = parts.pop() || "";
  const name = parts.join("_") || "meeting";
  const iso = `${date}T${time.replaceAll("-", ":")}Z`;
  const startedAt = Number.isFinite(Date.parse(iso)) ? iso : null;
  return {
    title: name.replaceAll("-", " ") || "Meeting",
    date,
    startedAt,
  };
}

type BotIndexDoc = {
  version: number;
  botId: string;
  title?: string;
  prefix: string;
  transcriptKey?: string;
  notesKey?: string | null;
  finalizedAt?: string;
  lineCount?: number;
  wordCount?: number;
  transcriptHash?: string;
  notesHash?: string | null;
  cronLastHash?: string;
  cronStablePasses?: number;
  cronFinalized?: boolean;
  cronFinalizedAt?: string;
};

function linesFromPlainTranscript(transcriptText: string) {
  const baseTime = Date.now();
  return transcriptText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      const m = line.match(/^([^:]+):\s*(.+)$/);
      return {
        received_at: new Date(baseTime + i).toISOString(),
        event: "transcript",
        participant: { name: (m?.[1] || "Speaker").trim() },
        text: (m?.[2] || line).trim(),
      };
    });
}

export function mergeNotetakerSessions(...lists: NotetakerSession[][]): NotetakerSession[] {
  const byId = new Map<string, NotetakerSession>();
  for (const list of lists) {
    for (const s of list) {
      const id = String(s.botId || "").trim();
      if (!id) continue;
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, s);
        continue;
      }
      byId.set(id, {
        ...prev,
        ...s,
        title: s.title || prev.title,
        createdAt: s.createdAt || prev.createdAt,
        status: s.status || prev.status,
        meetingUrl: s.meetingUrl || prev.meetingUrl,
        botName: s.botName || prev.botName,
      });
    }
  }
  return Array.from(byId.values()).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

async function listSessionsFromBotIndex(): Promise<NotetakerSession[]> {
  const client = s3();
  const bucket = bucketName();
  const base = "alyson-notetaker/bot-index/";
  const out: NotetakerSession[] = [];
  let token: string | undefined;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: base,
      }),
    );
    for (const obj of page.Contents ?? []) {
      const key = String(obj.Key || "");
      if (!key.endsWith(".json")) continue;
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!r.Body) continue;
        const parsed = JSON.parse(await streamToString(r.Body)) as BotIndexDoc;
        if (!parsed?.botId || parsed.version !== 1) continue;
        const meta = parseMeetingPrefix(String(parsed.prefix || ""));
        const storedTitle = String(parsed.title || "").trim();
        out.push({
          botId: String(parsed.botId),
          title: storedTitle || meta.title,
          createdAt: String(parsed.finalizedAt || meta.startedAt || obj.LastModified?.toISOString() || ""),
          status: "persisted",
        });
      } catch {
        // skip corrupt index entries
      }
    }
    token = page.NextContinuationToken;
  } while (token);

  return out;
}

/**
 * Merge incoming sessions into the S3 catalog index (never drop existing entries).
 * Also folds in per-bot index files so history survives upstream TTL expiry.
 */
export async function mergeSessionsIndexToS3(incoming: NotetakerSession[]): Promise<NotetakerSession[]> {
  let existing: NotetakerSession[] = [];
  try {
    existing = (await getNotetakerSessionsIndexFromS3()).sessions ?? [];
  } catch {
    // index may not exist yet
  }
  const fromBotIndex = await listSessionsFromBotIndex();
  const merged = mergeNotetakerSessions(existing, fromBotIndex, incoming);
  await putNotetakerSessionsIndexToS3({ sessions: merged });
  return merged;
}

const s3IndexCache = { at: 0, sessions: [] as NotetakerSession[] };
const S3_INDEX_CACHE_MS = 20_000;

async function listPersistedSessionsFromS3IndexOnly(): Promise<NotetakerSession[]> {
  const now = Date.now();
  if (now - s3IndexCache.at < S3_INDEX_CACHE_MS && s3IndexCache.sessions.length) {
    return s3IndexCache.sessions;
  }

  const fromIndex: NotetakerSession[] = [];
  try {
    const idx = await getNotetakerSessionsIndexFromS3();
    for (const s of idx.sessions ?? []) {
      if (!s?.botId) continue;
      fromIndex.push({
        ...s,
        status: s.status || "persisted",
      });
    }
  } catch {
    // index may not exist yet
  }

  s3IndexCache.at = now;
  s3IndexCache.sessions = fromIndex;
  return fromIndex;
}

/** All persisted meetings discoverable from S3 (index snapshot + per-bot index files). */
export async function listPersistedSessionsFromS3(options?: {
  /** Full S3 scan is slow; default false for session list UI. */
  includeBotIndex?: boolean;
}): Promise<NotetakerSession[]> {
  const fromIndex = await listPersistedSessionsFromS3IndexOnly();
  if (options?.includeBotIndex) {
    const fromBotIndex = await listSessionsFromBotIndex();
    return mergeNotetakerSessions(fromIndex, fromBotIndex);
  }
  return fromIndex;
}

export function invalidatePersistedSessionsS3Cache() {
  s3IndexCache.at = 0;
  s3IndexCache.sessions = [];
}

export async function isMeetingPersistedInS3(botId: string): Promise<boolean> {
  const doc = await loadBotIndexDoc(botId);
  return Boolean(doc?.botId && doc.transcriptKey);
}

export async function loadBotIndexDoc(botId: string): Promise<BotIndexDoc | null> {
  const client = s3();
  const bucket = bucketName();
  const key = `alyson-notetaker/bot-index/${encodeURIComponent(botId)}.json`;
  try {
    const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!r.Body) return null;
    const parsed = JSON.parse(await streamToString(r.Body)) as BotIndexDoc;
    if (!parsed || parsed.version !== 1 || String(parsed.botId) !== botId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Load transcript + notes for a past meeting from S3 (when upstream no longer has the session). */
export async function loadPersistedSessionPayloadFromS3(botId: string): Promise<NotetakerSessionPayload | null> {
  const idx = await loadBotIndexDoc(botId);
  const transcriptKey =
    idx?.transcriptKey || (idx?.prefix ? `alyson-notetaker/transcripts/${idx.prefix}/transcript.txt` : null);
  if (!transcriptKey) return null;

  let transcriptText = "";
  try {
    transcriptText = await getTranscriptTextFromS3({ transcriptKey });
  } catch {
    return null;
  }

  const meta = parseMeetingPrefix(String(idx?.prefix || ""));
  const storedTitle = String(idx?.title || "").trim();
  let notesMd: string | null = null;
  if (idx?.notesKey) {
    try {
      notesMd = await getNotesMdFromS3({ notesKey: String(idx.notesKey) });
    } catch {
      notesMd = null;
    }
  }

  const lines = linesFromPlainTranscript(transcriptText);
  const speakers = new Set(lines.map((l) => l.participant?.name).filter(Boolean));

  let title = storedTitle || meta.title;
  if (!storedTitle) {
    const { resolveMeetingTitle, isGenericMeetingTitle } = await import("@/lib/notetaker-session-title.server");
    if (isGenericMeetingTitle(title)) {
      title = await resolveMeetingTitle({ botId, title });
    }
  }

  return {
    session: {
      botId,
      title,
      createdAt: String(idx?.finalizedAt || meta.startedAt || new Date().toISOString()),
      status: "persisted",
    },
    lines,
    participantCount: speakers.size,
    startedLabel: String(idx?.finalizedAt || meta.startedAt || ""),
    hasRecallConfig: true,
    hasGroqConfig: true,
    notesMd,
    notesModel: notesMd ? "s3" : undefined,
    persistedInS3: true,
  };
}
