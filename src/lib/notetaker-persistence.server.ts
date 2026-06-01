import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { NotetakerSession, NotetakerTranscriptLine } from "@/lib/alyson-notetaker-functions";
import { withResolvedMeetingTitle } from "@/lib/notetaker-session-title.server";

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} (required for persistence)`);
  return v;
}

function requireEnvAlias(primary: string, aliases: string[]) {
  const v = process.env[primary] || aliases.map((a) => process.env[a]).find(Boolean);
  if (!v) throw new Error(`Missing ${primary} (required for persistence)`);
  return v;
}

function sanitizeMeetingName(title: string) {
  return String(title || "Meeting")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60) || "meeting";
}

function utcStamp(iso: string) {
  const d = new Date(iso);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}-${mi}-${ss}` };
}

function buildS3Prefix(session: NotetakerSession) {
  const name = sanitizeMeetingName(session.title || "Meeting");
  const startedAt = session.createdAt || new Date().toISOString();
  const { date, time } = utcStamp(startedAt);
  return `${name}_${date}_${time}`;
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
      : new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration: { LocationConstraint: region } });

  await client.send(cmd);
}

export function composeTranscript(lines: NotetakerTranscriptLine[]) {
  const sorted = [...lines].sort((a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime());
  const transcriptText = sorted
    .map((L) => {
      const who = (L.participant?.name || "Speaker").trim();
      const text = String(L.text || "").trim();
      if (!text) return "";
      return `${who}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");
  return {
    transcriptText,
    lineCount: sorted.length,
    firstLineAt: sorted[0]?.received_at ?? null,
    lastLineAt: sorted[sorted.length - 1]?.received_at ?? null,
    wordCount: transcriptText ? transcriptText.split(/\s+/).filter(Boolean).length : 0,
  };
}

export async function persistMeetingToS3({
  session,
  lines,
  notes,
}: {
  session: NotetakerSession;
  lines: NotetakerTranscriptLine[];
  notes: { notesMd: string; model?: string } | null;
}) {
  const bucket = requireEnvAlias("AWS_S3_BUCKET", ["S3_BUCKET"]);
  await ensureBucketExists(bucket);
  session = await withResolvedMeetingTitle(session);
  const prefix = buildS3Prefix(session);
  const transcriptKey = `alyson-notetaker/transcripts/${prefix}/transcript.txt`;
  const notesKey = `alyson-notetaker/meetingnotes/${prefix}/notes.md`;
  const botIndexKey = `alyson-notetaker/bot-index/${encodeURIComponent(session.botId)}.json`;

  const endedAt = new Date().toISOString();
  const transcript = composeTranscript(lines);

  const metadata = {
    "x-amz-meta-session-id": session.botId, // we only have botId in this app; backend can map to uuid later
    "x-amz-meta-bot-id": session.botId,
    "x-amz-meta-meeting-title": String(session.title || "Meeting"),
    "x-amz-meta-started-at": String(session.createdAt || ""),
    "x-amz-meta-ended-at": endedAt,
  } as Record<string, string>;

  // 1) Upload to S3 (write-on-finish)
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: transcriptKey,
      Body: transcript.transcriptText || "",
      ContentType: "text/plain; charset=utf-8",
      Metadata: metadata,
    }),
  );

  if (notes?.notesMd) {
    await s3().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: notesKey,
        Body: notes.notesMd,
        ContentType: "text/markdown; charset=utf-8",
        Metadata: metadata,
      }),
    );
  }

  // 2) Write a tiny index file for fast deletes by botId (avoid listing+head scanning).
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: botIndexKey,
      Body: JSON.stringify(
        {
          version: 1,
          botId: session.botId,
          title: session.title,
          prefix,
          transcriptKey,
          notesKey: notes?.notesMd ? notesKey : null,
          finalizedAt: endedAt,
        },
        null,
        2,
      ),
      ContentType: "application/json; charset=utf-8",
      Metadata: { kind: "alyson-notetaker-bot-index", botid: String(session.botId) },
    }),
  );

  return {
    botId: session.botId,
    transcriptKey,
    notesKey: notes?.notesMd ? notesKey : null,
    finalizedAt: endedAt,
  };
}

