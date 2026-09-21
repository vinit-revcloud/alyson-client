import { recallFetch, recallFetchWithRetry } from "@/lib/recall/recall-client.server";

export type RecallBotStatusChange = {
  code: string;
  createdAt: string;
  subCode?: string | null;
  message?: string | null;
};

export type RecallBotLifecycle = {
  botId: string;
  botName?: string;
  meetingUrl?: string;
  joinAt?: string;
  statusChanges: RecallBotStatusChange[];
  joiningCallAt: string | null;
  waitingRoomEnteredAt: string | null;
  admittedAt: string | null;
  callEndedAt: string | null;
  doneAt: string | null;
  fatalAt: string | null;
  fatalSubCode: string | null;
  waitingRoomSeconds: number | null;
  joinedMeeting: boolean;
  stuckInWaitingRoom: boolean;
  finalStatusCode: string;
  /** Parsed from the same GET /api/v1/bot/{id}/ response — avoids a second Retrieve Bot call. */
  transcriptDownloadUrl?: string | null;
  fetchError?: string;
};

const ADMITTED_CODES = new Set([
  "in_call_not_recording",
  "in_call_recording",
  "recording_permission_allowed",
]);

const IN_CALL_CODES = new Set(["in_call_not_recording", "in_call_recording"]);

const TERMINAL_STATUS = new Set(["done", "fatal", "call_ended"]);

type BotListPage = {
  results?: unknown[];
  next?: string | null;
};

const lifecycleCache = new Map<string, { at: number; lifecycle: RecallBotLifecycle }>();

/** Throttle individual GET /api/v1/bot/{id} calls (Recall limit ~300/min). */
const BOT_FETCH_DELAY_MS = 400;
const MAX_INDIVIDUAL_BOT_FETCHES = 40;
const LIFECYCLE_CACHE_TERMINAL_MS = 24 * 60 * 60_000;
const LIFECYCLE_CACHE_ACTIVE_MS = 10 * 60_000;
const LIFECYCLE_CACHE_FAILED_MS = 90_000;
/** Default ~100/min spacing — leaves headroom under Recall's 300/min Retrieve Bot cap. */
const MIN_BOT_GET_INTERVAL_MS = 600;
/** Hard ceiling per process per rolling minute (well under 300). */
const MAX_BOT_GETS_PER_MINUTE = 100;

let lastBotGetAt = 0;
let botGetWindowStartedAt = 0;
let botGetsInWindow = 0;

function recallBotGetMinIntervalMs(): number {
  const n = Number(process.env.RECALL_BOT_GET_MIN_INTERVAL_MS ?? String(MIN_BOT_GET_INTERVAL_MS));
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 5000) : MIN_BOT_GET_INTERVAL_MS;
}

function recallBotGetsPerMinuteCap(): number {
  const n = Number(process.env.RECALL_BOT_GET_MAX_PER_MINUTE ?? String(MAX_BOT_GETS_PER_MINUTE));
  return Number.isFinite(n) && n >= 10 ? Math.min(Math.floor(n), 250) : MAX_BOT_GETS_PER_MINUTE;
}

function consumeBotGetBudget(): boolean {
  const now = Date.now();
  if (now - botGetWindowStartedAt >= 60_000) {
    botGetWindowStartedAt = now;
    botGetsInWindow = 0;
  }
  if (botGetsInWindow >= recallBotGetsPerMinuteCap()) return false;
  botGetsInWindow += 1;
  return true;
}

async function throttledRecallBotGet(path: string, init?: { timeoutMs?: number; maxRetries?: number }) {
  if (!consumeBotGetBudget()) {
    const err = new Error("Recall bot GET budget exhausted this minute (rate-limit protection)");
    (err as Error & { status?: number }).status = 429;
    throw err;
  }
  const minInterval = recallBotGetMinIntervalMs();
  if (minInterval > 0) {
    const wait = lastBotGetAt + minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    lastBotGetAt = Date.now();
  }
  return recallFetchWithRetry(path, init);
}

function cacheTtlMs(lifecycle: RecallBotLifecycle): number {
  if (lifecycle.fetchError) return LIFECYCLE_CACHE_FAILED_MS;
  // Ended but the transcript artifact isn't ready yet (typical right after call_ended):
  // cache briefly so the post-meeting backfill sees the download URL once Recall publishes it.
  if (TERMINAL_STATUS.has(lifecycle.finalStatusCode) && !lifecycle.transcriptDownloadUrl) {
    return LIFECYCLE_CACHE_FAILED_MS;
  }
  return TERMINAL_STATUS.has(lifecycle.finalStatusCode)
    ? LIFECYCLE_CACHE_TERMINAL_MS
    : LIFECYCLE_CACHE_ACTIVE_MS;
}

/** Drop the cached lifecycle (webhooks tell us the bot state just changed). */
export function invalidateRecallBotLifecycleCache(botId: string): void {
  lifecycleCache.delete(String(botId || "").trim());
}

function getCachedLifecycle(botId: string): RecallBotLifecycle | null {
  const row = lifecycleCache.get(botId);
  if (!row) return null;
  if (Date.now() - row.at > cacheTtlMs(row.lifecycle)) {
    lifecycleCache.delete(botId);
    return null;
  }
  return row.lifecycle;
}

function setCachedLifecycle(lifecycle: RecallBotLifecycle) {
  const id = String(lifecycle.botId || "").trim();
  if (!id) return;
  lifecycleCache.set(id, { at: Date.now(), lifecycle });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function emptyLifecycle(botId: string, fetchError?: string): RecallBotLifecycle {
  return {
    botId,
    statusChanges: [],
    joiningCallAt: null,
    waitingRoomEnteredAt: null,
    admittedAt: null,
    callEndedAt: null,
    doneAt: null,
    fatalAt: null,
    fatalSubCode: null,
    waitingRoomSeconds: null,
    joinedMeeting: false,
    stuckInWaitingRoom: false,
    finalStatusCode: fetchError ? "fetch_failed" : "unknown",
    fetchError,
  };
}

function firstAt(changes: RecallBotStatusChange[], codes: Set<string>): string | null {
  for (const c of changes) {
    if (codes.has(c.code)) return c.createdAt;
  }
  return null;
}

function lastAt(changes: RecallBotStatusChange[], codes: Set<string>): string | null {
  for (let i = changes.length - 1; i >= 0; i--) {
    if (codes.has(changes[i]!.code)) return changes[i]!.createdAt;
  }
  return null;
}

function secondsBetween(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null;
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 1000);
}

function normalizeStatusChanges(raw: unknown): RecallBotStatusChange[] {
  if (!Array.isArray(raw)) return [];
  const changes: RecallBotStatusChange[] = [];
  for (const row of raw) {
    const o = row as { code?: string; created_at?: string; sub_code?: string; message?: string };
    const code = String(o?.code || "").trim();
    const createdAt = String(o?.created_at || "").trim();
    if (!code || !createdAt) continue;
    changes.push({
      code,
      createdAt,
      subCode: o?.sub_code ?? null,
      message: o?.message ?? null,
    });
  }
  return changes.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export function extractTranscriptDownloadUrl(bot: unknown): string | null {
  const o = (bot && typeof bot === "object" ? bot : {}) as Record<string, unknown>;
  const recordings = Array.isArray(o.recordings) ? o.recordings : [];
  for (const rec of recordings) {
    const row = rec as {
      media_shortcuts?: { transcript?: { data?: { download_url?: string } } };
    };
    const url = row?.media_shortcuts?.transcript?.data?.download_url;
    if (typeof url === "string" && url.trim()) return url.trim();
  }
  return null;
}

export function parseRecallBotLifecycle(botId: string, bot: unknown): RecallBotLifecycle {
  const o = (bot && typeof bot === "object" ? bot : {}) as Record<string, unknown>;
  const resolvedId = String(o.id || o.bot_id || botId || "").trim();
  const statusChanges = normalizeStatusChanges(o.status_changes);
  const joiningCallAt = firstAt(statusChanges, new Set(["joining_call"]));
  const waitingRoomEnteredAt = firstAt(statusChanges, new Set(["in_waiting_room"]));
  const admittedAt = firstAt(statusChanges, ADMITTED_CODES);
  const callEndedAt = lastAt(statusChanges, new Set(["call_ended"]));
  const doneAt = lastAt(statusChanges, new Set(["done"]));
  const fatalChange = [...statusChanges].reverse().find((c) => c.code === "fatal");
  const fatalAt = fatalChange?.createdAt ?? null;
  const fatalSubCode = fatalChange?.subCode ?? null;

  const joinedMeeting = statusChanges.some((c) => IN_CALL_CODES.has(c.code));
  const lastCode = statusChanges[statusChanges.length - 1]?.code ?? "unknown";

  let waitingRoomSeconds: number | null = null;
  if (waitingRoomEnteredAt) {
    const end =
      admittedAt ||
      (lastCode === "in_waiting_room" ? callEndedAt || fatalAt || doneAt : null);
    waitingRoomSeconds = secondsBetween(waitingRoomEnteredAt, end);
  }

  const stuckInWaitingRoom =
    Boolean(waitingRoomEnteredAt) &&
    !joinedMeeting &&
    (lastCode === "in_waiting_room" || lastCode === "fatal" || lastCode === "call_ended");

  const meetingUrl =
    String((o.meeting_url as string) || (o.meetingUrl as string) || "").trim() || undefined;

  return {
    botId: resolvedId || botId,
    botName: String(o.bot_name || "").trim() || undefined,
    meetingUrl,
    joinAt: String(o.join_at || "").trim() || undefined,
    statusChanges,
    joiningCallAt,
    waitingRoomEnteredAt,
    admittedAt,
    callEndedAt,
    doneAt,
    fatalAt,
    fatalSubCode,
    waitingRoomSeconds,
    joinedMeeting,
    stuckInWaitingRoom,
    finalStatusCode: lastCode,
    transcriptDownloadUrl: extractTranscriptDownloadUrl(o),
  };
}

/** Paginated List Bots — one request per page instead of N× Retrieve Bot. */
export async function listRecallBotsInJoinRange(args: {
  joinAtAfter: string;
  joinAtBefore: string;
}): Promise<unknown[]> {
  const params = new URLSearchParams();
  params.set("join_at_after", args.joinAtAfter);
  params.set("join_at_before", args.joinAtBefore);

  const out: unknown[] = [];
  let path: string = `/api/v1/bot/?${params.toString()}`;

  for (let page = 0; page < 40; page++) {
    const res = await recallFetchWithRetry<BotListPage>(path, {
      timeoutMs: 30_000,
      maxRetries: 2,
    });
    out.push(...(res.results ?? []));
    if (!res.next) break;
    path = res.next;
    await sleep(BOT_FETCH_DELAY_MS);
  }

  return out;
}

export async function fetchRecallBotLifecycle(botId: string): Promise<RecallBotLifecycle> {
  const id = String(botId || "").trim();
  if (!id) return emptyLifecycle(id, "Missing bot id");

  const cached = getCachedLifecycle(id);
  if (cached) return cached;

  try {
    const bot = await throttledRecallBotGet(`/api/v1/bot/${encodeURIComponent(id)}/`, {
      timeoutMs: 20_000,
      // One retry only — 429 retries amplify Retrieve Bot usage under load.
      maxRetries: 1,
    });
    const lifecycle = parseRecallBotLifecycle(id, bot);
    setCachedLifecycle(lifecycle);
    return lifecycle;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const failed = emptyLifecycle(id, message);
    setCachedLifecycle(failed);
    return failed;
  }
}

export type FetchRecallBotLifecyclesResult = {
  lifecycles: Map<string, RecallBotLifecycle>;
  skippedIndividualFetch: number;
  fromListApi: number;
  fromCache: number;
};

/**
 * Prefer List Bots (date range) + cache; fall back to throttled Retrieve Bot.
 * Stays under Recall GET /api/v1/bot/{id} limit (~300/min).
 */
export async function fetchRecallBotLifecycles(
  botIds: string[],
  options?: {
    joinAtAfter?: string;
    joinAtBefore?: string;
    maxIndividualFetches?: number;
  },
): Promise<FetchRecallBotLifecyclesResult> {
  const unique = [...new Set(botIds.map((id) => String(id || "").trim()).filter(Boolean))];
  const out = new Map<string, RecallBotLifecycle>();
  let fromCache = 0;
  let fromListApi = 0;
  const pending: string[] = [];

  for (const id of unique) {
    const cached = getCachedLifecycle(id);
    if (cached) {
      out.set(id, cached);
      fromCache += 1;
    } else {
      pending.push(id);
    }
  }

  if (pending.length && options?.joinAtAfter && options?.joinAtBefore) {
    try {
      const listed = await listRecallBotsInJoinRange({
        joinAtAfter: options.joinAtAfter,
        joinAtBefore: options.joinAtBefore,
      });
      const pendingSet = new Set(pending);
      for (const bot of listed) {
        const o = (bot && typeof bot === "object" ? bot : {}) as Record<string, unknown>;
        const id = String(o.id || o.bot_id || "").trim();
        if (!id || !pendingSet.has(id) || out.has(id)) continue;
        const lifecycle = parseRecallBotLifecycle(id, bot);
        setCachedLifecycle(lifecycle);
        out.set(id, lifecycle);
        fromListApi += 1;
      }
    } catch {
      // Fall through to throttled individual fetch for remaining ids.
    }
  }

  const remaining = pending.filter((id) => !out.has(id));
  const maxIndividual = options?.maxIndividualFetches ?? MAX_INDIVIDUAL_BOT_FETCHES;
  const toFetch = remaining.slice(0, maxIndividual);
  const skippedIndividualFetch = Math.max(0, remaining.length - toFetch.length);

  for (let i = 0; i < toFetch.length; i++) {
    const id = toFetch[i]!;
    const lifecycle = await fetchRecallBotLifecycle(id);
    out.set(id, lifecycle);
    if (i < toFetch.length - 1 && BOT_FETCH_DELAY_MS > 0) {
      await sleep(BOT_FETCH_DELAY_MS);
    }
  }

  for (const id of remaining.slice(maxIndividual)) {
    out.set(
      id,
      emptyLifecycle(id, "Recall fetch skipped (rate-limit protection — refresh in a few minutes)"),
    );
  }

  return { lifecycles: out, skippedIndividualFetch, fromListApi, fromCache };
}
