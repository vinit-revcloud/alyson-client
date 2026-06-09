import { createHmac, timingSafeEqual } from "node:crypto";
import { appBaseUrl } from "@/lib/recall/recall-client.server";

const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export function googleOAuthClientId(): string {
  const v = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  if (!v) throw new Error("Missing GOOGLE_OAUTH_CLIENT_ID");
  return v;
}

export function googleOAuthClientSecret(): string {
  const v = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!v) throw new Error("Missing GOOGLE_OAUTH_CLIENT_SECRET");
  return v;
}

export function recallCalendarOAuthRedirectUri(origin?: string): string {
  const explicit = process.env.RECALL_CALENDAR_OAUTH_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  // Must match an Authorized redirect URI in Google Cloud Console exactly.
  if (origin?.trim()) return `${origin.replace(/\/$/, "")}/api/recall/calendar/callback`;
  return `${appBaseUrl()}/api/recall/calendar/callback`;
}

export function buildGoogleCalendarOAuthUrl(state: string, origin?: string): string {
  const params = new URLSearchParams({
    client_id: googleOAuthClientId(),
    redirect_uri: recallCalendarOAuthRedirectUri(origin),
    response_type: "code",
    scope: GOOGLE_CALENDAR_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleOAuthCode(code: string, origin?: string): Promise<{
  refreshToken: string;
  accessToken?: string;
  email?: string;
}> {
  const body = new URLSearchParams({
    code,
    client_id: googleOAuthClientId(),
    client_secret: googleOAuthClientSecret(),
    redirect_uri: recallCalendarOAuthRedirectUri(origin),
    grant_type: "authorization_code",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as {
    refresh_token?: string;
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok) {
    throw new Error(json.error_description || json.error || `Google token exchange failed (${res.status})`);
  }
  if (!json.refresh_token?.trim()) {
    throw new Error("Google did not return a refresh_token — revoke app access and reconnect with prompt=consent");
  }

  let email: string | undefined;
  if (json.access_token) {
    try {
      const profile = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${json.access_token}` },
      });
      const p = (await profile.json()) as { email?: string };
      email = p.email?.trim();
    } catch {
      // optional
    }
  }

  return { refreshToken: json.refresh_token.trim(), accessToken: json.access_token, email };
}

export function recallCalendarWebhookUrl(origin?: string): string {
  return `${appBaseUrl(origin)}/api/recall/webhooks/calendar`;
}

/** Best-effort Svix signature verification for Recall Calendar V2 webhooks. */
export function verifyRecallCalendarWebhook(rawBody: string, headers: Headers): boolean {
  const secret = process.env.RECALL_CALENDAR_WEBHOOK_SECRET?.trim() || process.env.RECALL_VERIFICATION_SECRET?.trim();
  if (!secret) return true;

  const msgId = headers.get("svix-id") || headers.get("webhook-id");
  const timestamp = headers.get("svix-timestamp") || headers.get("webhook-timestamp");
  const signatureHeader = headers.get("svix-signature") || headers.get("webhook-signature");
  if (!msgId || !timestamp || !signatureHeader) return false;

  const signed = `${msgId}.${timestamp}.${rawBody}`;
  const key = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const expected = createHmac("sha256", Buffer.from(key, "base64"))
    .update(signed)
    .digest("base64");

  for (const part of signatureHeader.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

export async function bootstrapRecallCalendarFromEnv(): Promise<{
  recallCalendarId: string;
  email: string;
  created: boolean;
} | null> {
  const existingId = process.env.RECALL_CALENDAR_ID?.trim();
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim();
  if (!refreshToken) return null;

  const clientId = googleOAuthClientId();
  const clientSecret = googleOAuthClientSecret();

  if (existingId) {
    return { recallCalendarId: existingId, email: process.env.GOOGLE_WORKSPACE_ADMIN_SUBJECT_EMAIL?.trim() || "connected", created: false };
  }

  const { createRecallCalendar } = await import("@/lib/recall/recall-calendar-v2.server");
  const cal = await createRecallCalendar({
    platform: "google_calendar",
    oauthClientId: clientId,
    oauthClientSecret: clientSecret,
    oauthRefreshToken: refreshToken,
    oauthEmail: process.env.GOOGLE_WORKSPACE_ADMIN_SUBJECT_EMAIL?.trim(),
    metadata: { source: "alyson_env_bootstrap" },
  });
  return {
    recallCalendarId: cal.id,
    email: String(cal.platform_email || cal.oauth_email || "connected"),
    created: true,
  };
}
