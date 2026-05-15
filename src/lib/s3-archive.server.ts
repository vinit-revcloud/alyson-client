import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";

function isMissingObjectError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  if (e.name === "NoSuchKey" || e.Code === "NoSuchKey") return true;
  if (e.$metadata?.httpStatusCode === 404) return true;
  return false;
}

async function streamToString(stream: unknown) {
  const readable = stream as Readable;
  const chunks: Buffer[] = [];
  for await (const c of readable) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

/** Immutable archive path — never overwrites an existing archive key. */
export function archiveObjectKey(sourceKey: string, at = new Date()) {
  const day = at.toISOString().slice(0, 10);
  const ts = at.toISOString().replace(/[:.]/g, "-");
  const safe = sourceKey.replace(/\//g, "__");
  return `archive/${safe}/${day}/${ts}.json`;
}

/**
 * Copy the current S3 object to archive/ before it is replaced.
 * Returns the archive key, or null if the source object did not exist.
 */
export async function archiveS3JsonBeforeWrite(
  client: S3Client,
  bucket: string,
  sourceKey: string,
): Promise<string | null> {
  try {
    const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: sourceKey }));
    if (!r.Body) return null;
    const text = await streamToString(r.Body);
    const archiveKey = archiveObjectKey(sourceKey);
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: archiveKey,
        Body: text,
        ContentType: "application/json; charset=utf-8",
        Metadata: {
          "x-amz-meta-archived-from": sourceKey,
          "x-amz-meta-archived-at": new Date().toISOString(),
        },
      }),
    );
    return archiveKey;
  } catch (err) {
    if (isMissingObjectError(err)) return null;
    throw err;
  }
}
