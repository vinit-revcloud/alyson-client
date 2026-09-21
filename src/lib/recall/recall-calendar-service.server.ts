import { randomUUID } from "node:crypto";
import {
  bootstrapRecallCalendarFromEnv,
  buildGoogleCalendarOAuthUrl,
  exchangeGoogleOAuthCode,
  recallCalendarOAuthRedirectUri,
  recallCalendarWebhookUrl,
} from "@/lib/recall/google-calendar-oauth.server";
import { createRecallCalendar, deleteRecallCalendar, getRecallCalendar } from "@/lib/recall/recall-calendar-v2.server";
import {
  getConnectedRecallCalendars,
  readRecallCalendarState,
  removeRecallCalendarConnection,
  upsertRecallCalendarConnection,
} from "@/lib/recall/recall-calendar-state-s3.server";
import {
  previewRecallCalendarPending,
  signOAuthState,
  syncRecallCalendarEvents,
  verifyOAuthState,
  MAX_NEW_BOTS_PER_SYNC,
} from "@/lib/recall/recall-calendar-sync.server";
import type { RecallCalendarWebhookPayload } from "@/lib/recall/recall-calendar-types";
import { googleOAuthClientId, googleOAuthClientSecret } from "@/lib/recall/google-calendar-oauth.server";
import {
  assertCalendarConnectEmailAllowed,
  calendarConnectAllowedDomains,
  getRecallCalendarAllowlist,
  isCalendarConnectEmailAllowed,
} from "@/lib/recall/recall-calendar-allowlist.server";

/** Initial sync on Connect: bots for the next 48h right away; the rest comes from webhooks + heartbeat. */
const CONNECT_INITIAL_LOOKAHEAD_MS = 48 * 60 * 60 * 1000;
const CONNECT_INITIAL_MAX_BOTS = 15;
const CONNECT_INITIAL_TIMEOUT_MS = 20_000;
import { autoSyncRecallCalendarIfPending } from "@/lib/recall/recall-calendar-sync-cron.server";

export async function getRecallCalendarStatus() {
  const state = await readRecallCalendarState();
  const allowlisted = getConnectedRecallCalendars(state).filter((c) => isCalendarConnectEmailAllowed(c.email));
  const connected: Array<
    (typeof allowlisted)[number] & {
      pending?: Awaited<ReturnType<typeof previewRecallCalendarPending>>;
    }
  > = [];
  for (const c of allowlisted) {
    try {
      await getRecallCalendar(c.recallCalendarId);
      let pending: Awaited<ReturnType<typeof previewRecallCalendarPending>> | undefined;
      try {
        pending = await previewRecallCalendarPending(c.recallCalendarId);
      } catch {
        // Non-fatal — UI can still sync manually.
      }
      connected.push({ ...c, pending });
    } catch {
      // Drop stale ids (e.g. old RECALL_CALENDAR_ID from env) so Sync targets a live calendar.
    }
  }
  return {
    webhookUrl: recallCalendarWebhookUrl(),
    oauthRedirectUri: recallCalendarOAuthRedirectUri(),
    connected,
    /** Calendars whose Google access lapsed — the owner must click Connect again. */
    disconnected: state.connections
      .filter((c) => c.status === "disconnected")
      .map((c) => ({ email: c.email, recallCalendarId: c.recallCalendarId })),
    total: state.connections.length,
    allowlist: getRecallCalendarAllowlist(),
    connectDomains: calendarConnectAllowedDomains(),
  };
}

export function startRecallCalendarConnect(origin?: string, returnTo?: string): string {
  const state = signOAuthState({ nonce: randomUUID(), returnTo });
  return buildGoogleCalendarOAuthUrl(state, origin);
}

async function resolveRecallCalendarForConnect(args: {
  email: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthRefreshToken: string;
}): Promise<{ cal: Awaited<ReturnType<typeof createRecallCalendar>>; reused: boolean }> {
  const normalizedEmail = args.email.trim().toLowerCase();
  const state = await readRecallCalendarState();
  const existingConn = state.connections.find(
    (c) => c.status === "connected" && c.email.trim().toLowerCase() === normalizedEmail,
  );
  if (existingConn?.recallCalendarId) {
    try {
      return { cal: await getRecallCalendar(existingConn.recallCalendarId), reused: true };
    } catch {
      // Stale connection row — create a fresh Recall calendar below.
    }
  }

  const cal = await createRecallCalendar({
    platform: "google_calendar",
    oauthClientId: args.oauthClientId,
    oauthClientSecret: args.oauthClientSecret,
    oauthRefreshToken: args.oauthRefreshToken,
    oauthEmail: args.email,
    metadata: { source: "alyson_oauth_connect" },
  });
  return { cal, reused: false };
}

export async function completeRecallCalendarConnect(code: string, stateToken: string, origin?: string) {
  const state = verifyOAuthState(stateToken);
  if (!state) throw new Error("Invalid OAuth state");

  const tokens = await exchangeGoogleOAuthCode(code, origin);
  const email = tokens.email || "";
  assertCalendarConnectEmailAllowed(email);

  const { cal, reused } = await resolveRecallCalendarForConnect({
    email,
    oauthClientId: googleOAuthClientId(),
    oauthClientSecret: googleOAuthClientSecret(),
    oauthRefreshToken: tokens.refreshToken,
  });

  const connectedEmail = email || String(cal.platform_email || cal.oauth_email || "connected");
  assertCalendarConnectEmailAllowed(connectedEmail);

  await upsertRecallCalendarConnection({
    recallCalendarId: cal.id,
    platform: "google_calendar",
    email: connectedEmail,
    connectedAt: new Date().toISOString(),
    status: "connected",
  });

  // Attach Alyson to the next 48h of meetings immediately (bounded so the OAuth redirect stays fast).
  // Later meetings are covered by Recall calendar webhooks + the 5-minute heartbeat sweep.
  const empty: Awaited<ReturnType<typeof syncRecallCalendarEvents>> = {
    calendarId: cal.id,
    processed: 0,
    scheduled: 0,
    skipped: 0,
    deleted: 0,
    errors: [],
    ownerEmail: connectedEmail,
  };
  let sync = empty;
  try {
    sync = await Promise.race([
      syncRecallCalendarEvents({
        calendarId: cal.id,
        ownerEmail: connectedEmail,
        scheduleAll: true,
        maxNewBots: CONNECT_INITIAL_MAX_BOTS,
        lookaheadMs: CONNECT_INITIAL_LOOKAHEAD_MS,
      }),
      new Promise<typeof empty>((resolve) =>
        setTimeout(
          () => resolve({ ...empty, reason: "Initial sync still running — remaining meetings schedule automatically" }),
          CONNECT_INITIAL_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (e) {
    // Recall may still be importing the calendar right after creation — webhook/heartbeat will catch up.
    sync = { ...empty, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!sync.reason) {
    sync.reason = reused
      ? "Linked existing Recall calendar — Alyson auto-joins every meeting with a video link"
      : "Connected — Alyson auto-joins every meeting with a video link";
  }
  return { calendarId: cal.id, email: connectedEmail, sync, returnTo: state.returnTo };
}

export async function disconnectRecallCalendar(calendarId: string) {
  await deleteRecallCalendar(calendarId);
  await removeRecallCalendarConnection(calendarId);
  return { disconnected: true, calendarId };
}

export async function syncRecallCalendarNow(
  calendarId: string,
  options?: {
    updatedAtGte?: string;
    eventIds?: string[];
    scheduleAll?: boolean;
    maxNewBots?: number;
    refreshBotConfig?: boolean;
  },
) {
  let cal;
  try {
    cal = await getRecallCalendar(calendarId);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 404) {
      throw new Error(
        `Calendar not found in Recall (${calendarId}). Click Disconnect, then Connect Google Calendar again.`,
      );
    }
    throw e;
  }
  if (cal.status === "disconnected") {
    throw new Error("Calendar is disconnected on Recall — reconnect Google Calendar");
  }
  const ownerEmail = String(cal.platform_email || cal.oauth_email || "");
  assertCalendarConnectEmailAllowed(ownerEmail);
  const scheduleAll = Boolean(options?.scheduleAll);
  return syncRecallCalendarEvents({
    calendarId,
    // No updatedAtGte → sweep by meeting start time (includes old recurring series).
    updatedAtGte: options?.updatedAtGte,
    ownerEmail,
    refreshBotConfig: scheduleAll ? false : options?.refreshBotConfig !== false,
    eventIds: options?.eventIds,
    scheduleAll,
    maxNewBots: options?.maxNewBots,
  });
}

export async function handleRecallCalendarWebhook(payload: RecallCalendarWebhookPayload) {
  if (payload.event === "calendar.sync_events") {
    const { calendar_id, last_updated_ts } = payload.data;
    const ownerEmail = await resolveRecallCalendarOwnerEmail(calendar_id);
    if (!isCalendarConnectEmailAllowed(ownerEmail)) {
      return {
        action: "skipped_not_allowlisted",
        calendarId: calendar_id,
        ownerEmail,
        allowlist: getRecallCalendarAllowlist(),
      };
    }

    // Event-driven first: schedule bots for changed Google Calendar meetings immediately.
    // Do NOT block on company-wide Google DWD refresh — that can timeout the webhook.
    const auto = await autoSyncRecallCalendarIfPending({
      calendarId: calendar_id,
      ownerEmail,
      updatedAtGte: last_updated_ts,
      eventDriven: true,
    });

    // Keep the webhook fast: the old company-wide DWD refresh here could time out the handler and
    // make Recall retry. The Unified Meetings list refreshes on page load / cron instead.
    const meetingsRefreshed = false;
    const meetingsReturned = 0;

    if (auto.ran) {
      return {
        action: "auto_sync",
        calendarId: calendar_id,
        ownerEmail,
        lastUpdatedTs: last_updated_ts,
        pendingBefore: auto.pendingBefore,
        scheduled: auto.scheduled,
        skipped: auto.skipped,
        errors: auto.errors,
        meetingsRefreshed,
        meetingsReturned,
        mode: "event_driven",
      };
    }
    return {
      action: "sync_skipped",
      calendarId: calendar_id,
      ownerEmail,
      lastUpdatedTs: last_updated_ts,
      reason: auto.reason ?? "Sync not run",
      meetingsRefreshed,
      meetingsReturned,
      mode: "event_driven",
    };
  }

  if (payload.event === "calendar.update") {
    const cal = await getRecallCalendar(payload.data.calendar_id);
    if (cal.status === "disconnected") {
      const { markRecallCalendarDisconnected } = await import("@/lib/recall/recall-calendar-state-s3.server");
      await markRecallCalendarDisconnected(payload.data.calendar_id);
      return { action: "marked_disconnected", calendarId: payload.data.calendar_id };
    }
    return { action: "calendar_update_noted", calendarId: payload.data.calendar_id, status: cal.status };
  }

  return { action: "ignored" };
}

export async function registerRecallCalendarFromEnvIfNeeded() {
  const boot = await bootstrapRecallCalendarFromEnv();
  if (!boot) return null;
  assertCalendarConnectEmailAllowed(boot.email);

  await upsertRecallCalendarConnection({
    recallCalendarId: boot.recallCalendarId,
    platform: "google_calendar",
    email: boot.email,
    connectedAt: new Date().toISOString(),
    status: "connected",
  });

  return {
    ...boot,
    sync: {
      calendarId: boot.recallCalendarId,
      processed: 0,
      scheduled: 0,
      skipped: 0,
      deleted: 0,
      errors: [],
      ownerEmail: boot.email,
      reason: "Registered — click Sync to schedule bots for upcoming meetings",
    },
  };
}

async function resolveRecallCalendarOwnerEmail(calendarId: string): Promise<string> {
  const state = await readRecallCalendarState();
  const conn = state.connections.find((c) => c.recallCalendarId === calendarId);
  if (conn?.email) return conn.email;
  const cal = await getRecallCalendar(calendarId);
  return String(cal.platform_email || cal.oauth_email || "");
}
