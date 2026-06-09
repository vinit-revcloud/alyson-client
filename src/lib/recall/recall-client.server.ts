function requireEnv(name: string) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

export function recallApiBase(): string {
  const raw = process.env.RECALL_BASE_URL?.trim() || "https://ap-northeast-1.recall.ai";
  return raw.replace(/\/$/, "").replace(/\/api\/v[0-9]+$/i, "");
}

export function recallApiKey(): string {
  return requireEnv("RECALL_API_KEY");
}

export function appBaseUrl(fallbackOrigin?: string): string {
  if (fallbackOrigin?.trim()) {
    return fallbackOrigin.replace(/\/$/, "");
  }
  const explicit = process.env.ALYSON_APP_BASE_URL?.trim() || process.env.VERCEL_URL?.trim();
  if (explicit) {
    const u = explicit.replace(/\/$/, "");
    return u.startsWith("http") ? u : `https://${u}`;
  }
  return "http://localhost:3001";
}

export async function recallFetch<T = unknown>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const base = recallApiBase();
  const url = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const controller = new AbortController();
  const timeoutMs = init?.timeoutMs ?? 30_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Token ${recallApiKey()}`,
        Accept: "application/json",
        ...(init?.headers || {}),
      },
    });

    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!res.ok) {
      const msg =
        (body as { detail?: string })?.detail ||
        (body as { message?: string })?.message ||
        text.slice(0, 300) ||
        `Recall API failed (${res.status})`;
      const err = new Error(String(msg));
      (err as Error & { status?: number; body?: unknown }).status = res.status;
      (err as Error & { body?: unknown }).body = body;
      throw err;
    }

    return body as T;
  } finally {
    clearTimeout(timeout);
  }
}

export function isRecallRetryableError(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  if (status === 409 || status === 507 || status === 429) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /409|507|429|rate limit|try again/i.test(msg);
}

export async function recallFetchWithRetry<T = unknown>(
  path: string,
  init?: RequestInit & { timeoutMs?: number; maxRetries?: number },
): Promise<T> {
  const maxRetries = init?.maxRetries ?? 3;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await recallFetch<T>(path, init);
    } catch (e) {
      lastError = e;
      if (!isRecallRetryableError(e) || attempt >= maxRetries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
