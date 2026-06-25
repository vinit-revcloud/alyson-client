export type GroqMessage = { role: "system" | "user" | "assistant"; content: string };

export type MeetingAiChatResult = {
  content: string;
  provider: "groq" | "deepseek";
  model: string;
};

export function groqModel(): string {
  return (
    process.env.ALYSON_MINI_MODULE_AI_MODEL || process.env.GROQ_MODEL || "llama-3.1-8b-instant"
  );
}

export function groqApiKey(): string | null {
  const key = process.env.ALYSON_MINI_MODULE_AI_API_KEY || process.env.GROQ_API_KEY;
  return key?.trim() || null;
}

export function deepseekApiKey(): string | null {
  return process.env.DEEPSEEK_API_KEY?.trim() || null;
}

const DEEPSEEK_MODEL_PREFERENCE = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"];

let deepseekModelsCache: { at: number; models: string[] } | null = null;

export type DeepseekModelInfo = { id: string; ownedBy: string };

/** @see https://api-docs.deepseek.com/api/list-models */
export async function listDeepseekModels(): Promise<DeepseekModelInfo[]> {
  const apiKey = deepseekApiKey();
  if (!apiKey) return [];

  const r = await fetch("https://api.deepseek.com/models", {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const text = await r.text();
  let json: { data?: { id?: string; owned_by?: string }[] } | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  if (!r.ok) {
    const msg = text.slice(0, 300) || `DeepSeek models request failed (${r.status})`;
    throw new Error(msg);
  }

  return (json?.data ?? [])
    .map((m) => ({
      id: String(m.id || "").trim(),
      ownedBy: String(m.owned_by || "deepseek").trim(),
    }))
    .filter((m) => m.id);
}

async function cachedDeepseekModelIds(): Promise<string[]> {
  const hit = deepseekModelsCache;
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.models;

  const models = (await listDeepseekModels()).map((m) => m.id);
  if (models.length) deepseekModelsCache = { at: Date.now(), models };
  return models;
}

/** Pick the best DeepSeek chat model for meeting notes (fetched from /models when possible). */
export async function resolveDeepseekModel(): Promise<string> {
  const explicit = process.env.DEEPSEEK_MODEL?.trim();
  if (explicit) return explicit;

  try {
    const available = await cachedDeepseekModelIds();
    for (const preferred of DEEPSEEK_MODEL_PREFERENCE) {
      if (available.includes(preferred)) return preferred;
    }
    if (available[0]) return available[0];
  } catch {
    // fall through to default
  }

  return "deepseek-v4-flash";
}

export function deepseekModel(): string {
  return process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash";
}

export function meetingAiConfigured(): boolean {
  return Boolean(groqApiKey() || deepseekApiKey());
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isGroqRateLimitError(message: string): boolean {
  return /rate limit|too many requests|429|tokens per day|tpd/i.test(message);
}

export function isAiRateLimitOrQuotaError(message: string): boolean {
  return isGroqRateLimitError(message) || /quota|tokens per day|insufficient/i.test(message);
}

export function parseGroqRetryDelayMs(message: string): number | null {
  const sec = message.match(/try again in ([\d.]+)s/i);
  if (sec?.[1]) return Math.ceil(parseFloat(sec[1]) * 1000) + 200;
  const ms = message.match(/try again in ([\d.]+)ms/i);
  if (ms?.[1]) return Math.ceil(parseFloat(ms[1])) + 200;
  return null;
}

async function groqChatOnce(
  messages: GroqMessage[],
  temperature: number,
  model: string,
  maxTokens?: number,
): Promise<string> {
  const apiKey = groqApiKey();
  if (!apiKey) {
    throw new Error("Groq is not configured (set GROQ_API_KEY or ALYSON_MINI_MODULE_AI_API_KEY).");
  }

  const body: Record<string, unknown> = {
    model,
    temperature,
    messages,
  };
  if (maxTokens != null && maxTokens > 0) body.max_tokens = maxTokens;

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await r.text();
  let json: {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  } | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  if (!r.ok) {
    const msg = json?.error?.message || text.slice(0, 300) || `Groq request failed (${r.status})`;
    throw new Error(String(msg));
  }
  return String(json?.choices?.[0]?.message?.content || "").trim();
}

export async function groqChat(
  messages: GroqMessage[],
  temperature = 0.2,
  opts?: { model?: string; maxRetries?: number; maxRetryWaitMs?: number; maxTokens?: number },
): Promise<string> {
  const model = opts?.model || groqModel();
  const maxRetries = opts?.maxRetries ?? 2;
  const maxRetryWaitMs = opts?.maxRetryWaitMs ?? 45_000;
  const maxTokens = opts?.maxTokens;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await groqChatOnce(messages, temperature, model, maxTokens);
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!isGroqRateLimitError(msg) || attempt >= maxRetries) throw e;

      const wait = parseGroqRetryDelayMs(msg) ?? 2_000 * (attempt + 1);
      if (wait > maxRetryWaitMs) throw e;
      await sleep(wait);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function deepseekChatOnce(
  messages: GroqMessage[],
  temperature: number,
  model: string,
): Promise<string> {
  const apiKey = deepseekApiKey();
  if (!apiKey) {
    throw new Error("DeepSeek is not configured (set DEEPSEEK_API_KEY).");
  }

  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature,
      messages,
    }),
  });

  const text = await r.text();
  let json: {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  } | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  if (!r.ok) {
    const msg =
      json?.error?.message || text.slice(0, 300) || `DeepSeek request failed (${r.status})`;
    throw new Error(String(msg));
  }
  return String(json?.choices?.[0]?.message?.content || "").trim();
}

export async function deepseekChat(
  messages: GroqMessage[],
  temperature = 0.2,
  opts?: { model?: string; maxRetries?: number },
): Promise<string> {
  const model = opts?.model || deepseekModel();
  const maxRetries = opts?.maxRetries ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await deepseekChatOnce(messages, temperature, model);
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!isAiRateLimitOrQuotaError(msg) || attempt >= maxRetries) throw e;
      await sleep(2_000 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Groq first, then DeepSeek on rate-limit / quota / missing Groq key. */
export async function meetingAiChat(
  messages: GroqMessage[],
  temperature = 0.2,
  opts?: { provider?: "groq" | "deepseek"; model?: string },
): Promise<MeetingAiChatResult> {
  const errors: string[] = [];
  const preferDeepseek = opts?.provider === "deepseek";

  if (!preferDeepseek && groqApiKey()) {
    try {
      const model = opts?.model || groqModel();
      const content = await groqChat(messages, temperature, { model });
      return { content, provider: "groq", model };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Groq: ${msg}`);
      if (!deepseekApiKey()) throw e;
    }
  }

  if (deepseekApiKey()) {
    const model =
      opts?.model ||
      (opts?.provider === "deepseek" ? await resolveDeepseekModel() : deepseekModel());
    const content = await deepseekChat(messages, temperature, { model });
    return { content, provider: "deepseek", model };
  }

  throw new Error(
    errors.join(" | ") ||
      "No AI provider configured (set GROQ_API_KEY or DEEPSEEK_API_KEY in .env).",
  );
}

export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    return JSON.parse(fence[1].trim());
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error("Model did not return valid JSON.");
}
