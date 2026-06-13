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

export function deepseekModel(): string {
  return process.env.DEEPSEEK_MODEL || "deepseek-chat";
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
    const model = opts?.provider === "deepseek" ? opts?.model || deepseekModel() : deepseekModel();
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
