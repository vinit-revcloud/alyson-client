import { recallFetch } from "@/lib/recall/recall-client.server";

export type RecallUsageResponse = {
  bot_total: number;
};

type CacheEntry = { at: number; data: RecallUsageResponse };

const usageCache = new Map<string, CacheEntry>();

function billingCacheMs(): number {
  const raw = process.env.RECALL_BILLING_CACHE_MS?.trim();
  const n = raw ? Number(raw) : 60 * 60_000;
  return Number.isFinite(n) && n >= 60_000 ? n : 60 * 60_000;
}

/** Recall billing usage is capped at 5 req/min — stay well under that. */
const BILLING_MIN_INTERVAL_MS = 13_000;
let lastBillingCallAt = 0;
let billingGate: Promise<void> = Promise.resolve();

async function throttleBillingApiCall() {
  billingGate = billingGate.then(async () => {
    const now = Date.now();
    const wait = lastBillingCallAt + BILLING_MIN_INTERVAL_MS - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastBillingCallAt = Date.now();
  });
  await billingGate;
}

function isoRangeParams(startDay: string, endDay: string) {
  return {
    start: `${startDay}T00:00:00.000Z`,
    end: `${endDay}T23:59:59.999Z`,
  };
}

function cacheGet(key: string, allowStale = false): RecallUsageResponse | null {
  const hit = usageCache.get(key);
  if (!hit) return null;
  const age = Date.now() - hit.at;
  if (age <= billingCacheMs()) return hit.data;
  if (allowStale) return hit.data;
  return null;
}

async function fetchBillingUsageFromRecall(startDay: string, endDay: string): Promise<RecallUsageResponse> {
  const { start, end } = isoRangeParams(startDay, endDay);
  const params = new URLSearchParams({ start, end });
  await throttleBillingApiCall();
  const data = await recallFetch<RecallUsageResponse>(`/api/v1/billing/usage/?${params.toString()}`, {
    method: "GET",
    timeoutMs: 20_000,
  });
  return { bot_total: Number(data?.bot_total ?? 0) };
}

/** @see https://docs.recall.ai/reference/billing_usage_retrieve — max 5 req/min per workspace. */
export async function fetchRecallBotUsage(args: {
  startDay: string;
  endDay: string;
  skipCache?: boolean;
}): Promise<RecallUsageResponse> {
  if (!process.env.RECALL_API_KEY?.trim()) {
    throw new Error("RECALL_API_KEY is not configured");
  }

  const cacheKey = `${args.startDay}:${args.endDay}`;
  if (!args.skipCache) {
    const hit = cacheGet(cacheKey);
    if (hit) return hit;
  }

  try {
    const normalized = await fetchBillingUsageFromRecall(args.startDay, args.endDay);
    usageCache.set(cacheKey, { at: Date.now(), data: normalized });
    return normalized;
  } catch (e) {
    const stale = cacheGet(cacheKey, true);
    if (stale) return stale;
    const status = (e as { status?: number })?.status;
    if (status === 429) {
      throw new Error("Recall billing API rate limit — try again in a minute (results are cached for 1 hour).");
    }
    throw e;
  }
}

/** Meeting bot recording — default $0.50/hr (Recall pay-as-you-go). */
export function recallBotHourRateUsd(): number {
  const raw = process.env.RECALL_BOT_HOUR_USD?.trim();
  const n = raw ? Number(raw) : 0.5;
  return Number.isFinite(n) && n >= 0 ? n : 0.5;
}

/** Recall.ai built-in transcription — default $0.15/hr (same active hours as bot). */
export function recallTranscriptHourRateUsd(): number {
  const raw = process.env.RECALL_TRANSCRIPT_HOUR_USD?.trim();
  const n = raw ? Number(raw) : 0.15;
  return Number.isFinite(n) && n >= 0 ? n : 0.15;
}

export function botSecondsToCostUsd(seconds: number, hourlyRate: number): number {
  return (Math.max(0, seconds) / 3600) * hourlyRate;
}

export function recallUsageCostsFromSeconds(seconds: number) {
  const botUsageCostUsd = botSecondsToCostUsd(seconds, recallBotHourRateUsd());
  const transcriptUsageCostUsd = botSecondsToCostUsd(seconds, recallTranscriptHourRateUsd());
  return {
    botUsageCostUsd,
    transcriptUsageCostUsd,
    totalUsageCostUsd: botUsageCostUsd + transcriptUsageCostUsd,
  };
}
