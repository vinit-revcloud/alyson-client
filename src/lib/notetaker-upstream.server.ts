/** Shared HTTP client for the Alyson Notetaker service (Recall bot + live transcript). */

export function notetakerBaseUrl() {
  const raw =
    process.env.ALYSON_NOTETAKER_BASE_URL ||
    process.env.VITE_ALYSON_NOTETAKER_BASE_URL ||
    process.env.TEST_BOTV2_BASE_URL ||
    process.env.VITE_TEST_BOTV2_BASE_URL ||
    "http://localhost:3003";
  return String(raw).replace(/\/$/, "");
}

function upstreamTimeoutMs() {
  const n = Number(process.env.NOTETAKER_UPSTREAM_TIMEOUT_MS || 8_000);
  return Number.isFinite(n) && n > 0 ? n : 8_000;
}

export async function notetakerUpstream(path: string, init?: RequestInit) {
  const url = `${notetakerBaseUrl()}${path.startsWith("/") ? "" : "/"}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs());
  let r: Response;
  try {
    r = await fetch(url, {
      ...init,
      signal: init?.signal ?? controller.signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`Notetaker API timed out after ${upstreamTimeoutMs()}ms (${path})`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
  const contentType = r.headers.get("content-type") || "";
  const text = await r.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  if (contentType.includes("text/html") || (text && text.trim().startsWith("<!DOCTYPE html"))) {
    throw new Error(
      `Notetaker API returned HTML (wrong base URL or server not running). ` +
        `Check ALYSON_NOTETAKER_BASE_URL (currently: ${notetakerBaseUrl()}).`,
    );
  }
  if (!r.ok) {
    const msg =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : text || `Request failed (${r.status})`;
    throw new Error(msg);
  }
  return json;
}
