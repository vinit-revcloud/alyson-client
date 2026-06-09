import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { isGenericMeetingTitle } from "@/lib/notetaker-session-title.server";

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} (required for S3 calendar)`);
  return v;
}

function requireEnvAlias(primary: string, aliases: string[]) {
  const v = process.env[primary] || aliases.map((a) => process.env[a]).find(Boolean);
  if (!v) throw new Error(`Missing ${primary} (required for S3 calendar)`);
  return v;
}

function s3() {
  const region = requireEnvAlias("AWS_REGION", ["S3_REGION"]);
  const accessKeyId = requireEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("AWS_SECRET_ACCESS_KEY");
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

async function streamToString(stream: any) {
  const readable = stream as Readable;
  const chunks: Buffer[] = [];
  for await (const c of readable) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

function parsePrefix(prefix: string) {
  // Expected: <MeetingName>_<YYYY-MM-DD>_<HH-MM-SS>
  // MeetingName itself may contain underscores due to sanitization; we parse from the end.
  const parts = prefix.split("_");
  const time = parts.pop() || "";
  const date = parts.pop() || "";
  const name = parts.join("_") || "meeting";
  const iso = `${date}T${time.replaceAll("-", ":")}Z`;
  const startedAt = isFinite(Date.parse(iso)) ? iso : null;
  return { title: name.replaceAll("-", " "), date, time, startedAt };
}

export type S3Meeting = {
  prefix: string;
  botId: string | null;
  day: string; // YYYY-MM-DD
  title: string;
  notesKey: string | null;
  transcriptKey: string | null;
  startedAt: string | null;
  hasNotes: boolean;
  hasTranscript: boolean;
};

type BotIndexDoc = {
  version: number;
  botId: string;
  title?: string;
  prefix: string;
};

let botIndexCache: { at: number; docs: BotIndexDoc[] } | null = null;
const BOT_INDEX_CACHE_MS = 5 * 60_000;

async function listMeetingAssetPrefixes(
  client: S3Client,
  bucket: string,
  base: string,
  fileName: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  const suffix = `/${fileName}`;
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: base,
        ContinuationToken: token,
      }),
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

async function getBotIndexDocs(client: S3Client, bucket: string): Promise<BotIndexDoc[]> {
  const now = Date.now();
  if (botIndexCache && now - botIndexCache.at < BOT_INDEX_CACHE_MS) {
    return botIndexCache.docs;
  }
  const docs = await listBotIndexDocs(client, bucket);
  botIndexCache = { at: now, docs };
  return docs;
}

export function invalidateNotetakerCalendarS3Cache() {
  botIndexCache = null;
}

async function listBotIndexDocs(client: S3Client, bucket: string): Promise<BotIndexDoc[]> {
  const base = "alyson-notetaker/bot-index/";
  const keys: string[] = [];
  let token: string | undefined;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: base,
        ContinuationToken: token,
      }),
    );
    for (const obj of page.Contents ?? []) {
      const key = String(obj.Key || "");
      if (key.endsWith(".json")) keys.push(key);
    }
    token = page.NextContinuationToken;
  } while (token);

  const out: BotIndexDoc[] = [];
  const batchSize = 16;
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    const docs = await Promise.all(
      batch.map(async (key) => {
        try {
          const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
          if (!r.Body) return null;
          const parsed = JSON.parse(await streamToString(r.Body)) as BotIndexDoc;
          if (parsed?.version === 1 && parsed.botId && parsed.prefix) return parsed;
        } catch {
          // skip corrupt index entries
        }
        return null;
      }),
    );
    for (const doc of docs) {
      if (doc) out.push(doc);
    }
  }

  return out;
}

/** Map S3 folder prefix → display title from bot-index + sessions catalog. */
async function loadTitleByPrefix(botIndexDocs: BotIndexDoc[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();

  for (const parsed of botIndexDocs) {
    const prefix = String(parsed.prefix || "").trim();
    const title = String(parsed.title || "").trim();
    if (prefix && title && !isGenericMeetingTitle(title)) out.set(prefix, title);
  }

  try {
    const { getNotetakerSessionsIndexFromS3 } = await import("@/lib/notetaker-sessions-s3.server");
    const idx = await getNotetakerSessionsIndexFromS3();
    const byBotId = new Map(botIndexDocs.map((d) => [String(d.botId), d]));

    for (const s of idx.sessions ?? []) {
      const botId = String(s.botId || "").trim();
      const title = String(s.title || "").trim();
      if (!botId || !title || isGenericMeetingTitle(title)) continue;
      const doc = byBotId.get(botId);
      const prefix = String(doc?.prefix || "").trim();
      if (prefix && !out.has(prefix)) out.set(prefix, title);
    }
  } catch {
    // sessions index optional
  }

  return out;
}

export async function listMeetingsFromS3({ start, end }: { start: string; end: string }) {
  const bucket = requireEnvAlias("AWS_S3_BUCKET", ["S3_BUCKET"]);
  const client = s3();

  const notesBase = "alyson-notetaker/meetingnotes/";
  const transcriptBase = "alyson-notetaker/transcripts/";

  const [notesPrefixes, transcriptPrefixes] = await Promise.all([
    listMeetingAssetPrefixes(client, bucket, notesBase, "notes.md"),
    listMeetingAssetPrefixes(client, bucket, transcriptBase, "transcript.txt"),
  ]);

  const prefixes = Array.from(new Set([...notesPrefixes, ...transcriptPrefixes])).filter((p) => {
    const parts = p.split("_");
    const date = parts.length >= 2 ? parts[parts.length - 2] : "";
    return date && date >= start && date <= end;
  });

  const botIndexDocs = await getBotIndexDocs(client, bucket);
  const botIndexByPrefix = new Map(botIndexDocs.map((d) => [String(d.prefix), d]));
  const titleByPrefix = await loadTitleByPrefix(botIndexDocs);

  const rows: S3Meeting[] = [];
  for (const p of prefixes) {
    const parsed = parsePrefix(p);
    const day = parsed.date;
    if (!day || day < start || day > end) continue;

    const idx = botIndexByPrefix.get(p);
    const title = titleByPrefix.get(p) || idx?.title || parsed.title || "Meeting";

    rows.push({
      prefix: p,
      botId: idx?.botId ? String(idx.botId) : null,
      day,
      title,
      startedAt: parsed.startedAt,
      notesKey: `${notesBase}${p}/notes.md`,
      transcriptKey: `${transcriptBase}${p}/transcript.txt`,
      hasNotes: notesPrefixes.has(p),
      hasTranscript: transcriptPrefixes.has(p),
    });
  }

  rows.sort((a, b) => (b.startedAt || b.day).localeCompare(a.startedAt || a.day));
  return rows;
}

export type NotesCoverageReport = {
  totalMeetings: number;
  withTranscript: number;
  withNotes: number;
  withBoth: number;
  missingNotes: Array<{ prefix: string; botId: string | null; day: string; title: string }>;
};

/** List transcripts in S3 that have no notes.md (read-only audit). */
export async function auditNotesCoverageFromS3(): Promise<NotesCoverageReport> {
  const bucket = requireEnvAlias("AWS_S3_BUCKET", ["S3_BUCKET"]);
  const client = s3();
  const notesBase = "alyson-notetaker/meetingnotes/";
  const transcriptBase = "alyson-notetaker/transcripts/";

  const [notesPrefixes, transcriptPrefixes] = await Promise.all([
    listMeetingAssetPrefixes(client, bucket, notesBase, "notes.md"),
    listMeetingAssetPrefixes(client, bucket, transcriptBase, "transcript.txt"),
  ]);

  const allPrefixes = new Set([...notesPrefixes, ...transcriptPrefixes]);
  const botIndexDocs = await getBotIndexDocs(client, bucket);
  const botIndexByPrefix = new Map(botIndexDocs.map((d) => [String(d.prefix), d]));
  const titleByPrefix = await loadTitleByPrefix(botIndexDocs);

  const missingNotes: NotesCoverageReport["missingNotes"] = [];
  let withBoth = 0;

  for (const p of transcriptPrefixes) {
    const hasNotes = notesPrefixes.has(p);
    if (hasNotes) {
      withBoth += 1;
      continue;
    }
    const parsed = parsePrefix(p);
    const idx = botIndexByPrefix.get(p);
    missingNotes.push({
      prefix: p,
      botId: idx?.botId ? String(idx.botId) : null,
      day: parsed.date,
      title: titleByPrefix.get(p) || idx?.title || parsed.title || "Meeting",
    });
  }

  missingNotes.sort((a, b) => b.day.localeCompare(a.day));

  return {
    totalMeetings: allPrefixes.size,
    withTranscript: transcriptPrefixes.size,
    withNotes: notesPrefixes.size,
    withBoth,
    missingNotes,
  };
}

export async function getNotesMdFromS3({ notesKey }: { notesKey: string }) {
  const bucket = requireEnvAlias("AWS_S3_BUCKET", ["S3_BUCKET"]);
  const client = s3();
  const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: notesKey }));
  const body = r.Body;
  if (!body) throw new Error("Notes not found");
  return await streamToString(body);
}

export async function getTranscriptTextFromS3({ transcriptKey }: { transcriptKey: string }) {
  const bucket = requireEnvAlias("AWS_S3_BUCKET", ["S3_BUCKET"]);
  const client = s3();
  const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: transcriptKey }));
  const body = r.Body;
  if (!body) throw new Error("Transcript not found");
  return await streamToString(body);
}

