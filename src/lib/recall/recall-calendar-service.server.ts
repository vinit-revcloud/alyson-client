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
import { signOAuthState, syncRecallCalendarEvents, verifyOAuthState } from "@/lib/recall/recall-calendar-sync.server";
import type { RecallCalendarWebhookPayload } from "@/lib/recall/recall-calendar-types";
import { googleOAuthClientId, googleOAuthClientSecret } from "@/lib/recall/google-calendar-oauth.server";
import {
  assertRecallCalendarEmailAllowed,
  getRecallCalendarAllowlist,
  isRecallCalendarEmailAllowed,
} from "@/lib/recall/recall-calendar-allowlist.server";

export async function getRecallCalendarStatus() {
  const state = await readRecallCalendarState();
  const allowlisted = getConnectedRecallCalendars(state).filter((c) => isRecallCalendarEmailAllowed(c.email));
  const connected: typeof allowlisted = [];
  for (const c of allowlisted) {
    try {
      await getRecallCalendar(c.recallCalendarId);
      connected.push(c);
    } catch {
      // Drop stale ids (e.g. old RECALL_CALENDAR_ID from env) so Sync targets a live calendar.
    }
  }
  return {
    webhookUrl: recallCalendarWebhookUrl(),
    oauthRedirectUri: recallCalendarOAuthRedirectUri(),
    connected,
    total: state.connections.length,
    allowlist: getRecallCalendarAllowlist(),
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
  assertRecallCalendarEmailAllowed(email);

  const { cal, reused } = await resolveRecallCalendarForConnect({
    email,
    oauthClientId: googleOAuthClientId(),
    oauthClientSecret: googleOAuthClientSecret(),
    oauthRefreshToken: tokens.refreshToken,
  });

  const connectedEmail = email || String(cal.platform_email || cal.oauth_email || "connected");
  assertRecallCalendarEmailAllowed(connectedEmail);

  await upsertRecallCalendarConnection({
    recallCalendarId: cal.id,
    platform: "google_calendar",
    email: connectedEmail,
    connectedAt: new Date().toISOString(),
    status: "connected",
  });

  // Return quickly — full sync can take minutes and times out on Vercel. Webhooks + Sync button handle scheduling.
  const sync: Awaited<ReturnType<typeof syncRecallCalendarEvents>> = {
    calendarId: cal.id,
    processed: 0,
    scheduled: 0,
    skipped: 0,
    deleted: 0,
    errors: [],
    ownerEmail: connectedEmail,
    reason: reused
      ? "Linked existing Recall calendar — click Sync to schedule bots"
      : "Connected — click Sync to schedule bots for upcoming meetings",
  };
  return { calendarId: cal.id, email: connectedEmail, sync, returnTo: state.returnTo };
}

export async function disconnectRecallCalendar(calendarId: string) {
  await deleteRecallCalendar(calendarId);
  await removeRecallCalendarConnection(calendarId);
  return { disconnected: true, calendarId };
}

export async function syncRecallCalendarNow(calendarId: string, updatedAtGte?: string) {
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
  assertRecallCalendarEmailAllowed(ownerEmail);
  const since = updatedAtGte ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return syncRecallCalendarEvents({
    calendarId,
    updatedAtGte: since,
    ownerEmail,
    refreshBotConfig: true,
  });
}

export async function handleRecallCalendarWebhook(payload: RecallCalendarWebhookPayload) {
  if (payload.event === "calendar.sync_events") {
    const { calendar_id, last_updated_ts } = payload.data;
    const ownerEmail = await resolveRecallCalendarOwnerEmail(calendar_id);
    if (!isRecallCalendarEmailAllowed(ownerEmail)) {
      return {
        action: "skipped_not_allowlisted",
        calendarId: calendar_id,
        ownerEmail,
        allowlist: getRecallCalendarAllowlist(),
      };
    }
    return syncRecallCalendarEvents({
      calendarId: calendar_id,
      updatedAtGte: last_updated_ts,
      ownerEmail,
    });
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
  assertRecallCalendarEmailAllowed(boot.email);

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
