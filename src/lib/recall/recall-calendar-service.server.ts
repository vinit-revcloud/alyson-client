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
  const connected = getConnectedRecallCalendars(state).filter((c) => isRecallCalendarEmailAllowed(c.email));
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

export async function completeRecallCalendarConnect(code: string, stateToken: string, origin?: string) {
  const state = verifyOAuthState(stateToken);
  if (!state) throw new Error("Invalid OAuth state");

  const tokens = await exchangeGoogleOAuthCode(code, origin);
  const email = tokens.email || "";
  assertRecallCalendarEmailAllowed(email);

  const cal = await createRecallCalendar({
    platform: "google_calendar",
    oauthClientId: googleOAuthClientId(),
    oauthClientSecret: googleOAuthClientSecret(),
    oauthRefreshToken: tokens.refreshToken,
    oauthEmail: email || tokens.email,
    metadata: { source: "alyson_oauth_connect" },
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

  let sync: Awaited<ReturnType<typeof syncRecallCalendarEvents>>;
  try {
    sync = await syncRecallCalendarEvents({ calendarId: cal.id, ownerEmail: connectedEmail });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sync = {
      calendarId: cal.id,
      processed: 0,
      scheduled: 0,
      skipped: 0,
      deleted: 0,
      errors: [msg],
      ownerEmail: connectedEmail,
      reason: "Initial sync failed — use Sync in Unified Meetings to retry",
    };
  }
  return { calendarId: cal.id, email: connectedEmail, sync, returnTo: state.returnTo };
}

export async function disconnectRecallCalendar(calendarId: string) {
  await deleteRecallCalendar(calendarId);
  await removeRecallCalendarConnection(calendarId);
  return { disconnected: true, calendarId };
}

export async function syncRecallCalendarNow(calendarId: string, updatedAtGte?: string) {
  const cal = await getRecallCalendar(calendarId);
  if (cal.status === "disconnected") {
    throw new Error("Calendar is disconnected on Recall — reconnect Google Calendar");
  }
  const ownerEmail = String(cal.platform_email || cal.oauth_email || "");
  assertRecallCalendarEmailAllowed(ownerEmail);
  return syncRecallCalendarEvents({ calendarId, updatedAtGte, ownerEmail });
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

  const sync = await syncRecallCalendarEvents({ calendarId: boot.recallCalendarId, ownerEmail: boot.email });
  return { ...boot, sync };
}

async function resolveRecallCalendarOwnerEmail(calendarId: string): Promise<string> {
  const state = await readRecallCalendarState();
  const conn = state.connections.find((c) => c.recallCalendarId === calendarId);
  if (conn?.email) return conn.email;
  const cal = await getRecallCalendar(calendarId);
  return String(cal.platform_email || cal.oauth_email || "");
}
