export type GroqMessage = { role: "system" | "user" | "assistant"; content: string };

export function groqModel(): string {
  return process.env.ALYSON_MINI_MODULE_AI_MODEL || process.env.GROQ_MODEL || "llama-3.1-8b-instant";
}

export function groqApiKey(): string | null {
  const key = process.env.ALYSON_MINI_MODULE_AI_API_KEY || process.env.GROQ_API_KEY;
  return key?.trim() || null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isGroqRateLimitError(message: string): boolean {
  return /rate limit|too many requests|429/i.test(message);
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
): Promise<string> {
  const apiKey = groqApiKey();
  if (!apiKey) {
    throw new Error("Groq is not configured (set GROQ_API_KEY or ALYSON_MINI_MODULE_AI_API_KEY).");
  }

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
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
  let json: { choices?: { message?: { content?: string } }[]; error?: { message?: string } } | null = null;
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
  opts?: { model?: string; maxRetries?: number; maxRetryWaitMs?: number },
): Promise<string> {
  const model = opts?.model || groqModel();
  const maxRetries = opts?.maxRetries ?? 2;
  const maxRetryWaitMs = opts?.maxRetryWaitMs ?? 45_000;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await groqChatOnce(messages, temperature, model);
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
