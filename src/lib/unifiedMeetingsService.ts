import { google } from "googleapis";
import { JWT } from "google-auth-library";
import { promises as fs } from "node:fs";
import path from "node:path";

export type UnifiedBotStatus = "not_required" | "pending" | "scheduled" | "failed";
export type UnifiedMeetingPlatform = "google_meet" | "unknown";

export type UnifiedMeeting = {
  id: string;
  googleEventId: string;
  iCalUID: string;
  calendarUserEmail: string;
  title: string;
  startTime: string;
  endTime: string;
  timezone: string;
  meetingUrl: string | null;
  meetingPlatform: UnifiedMeetingPlatform;
  eventType: string;
  status: string;
  organizerEmail: string | null;
  attendees: string[];
  shouldBotJoin: boolean;
  botScheduled: boolean;
  botJoinAt: string | null;
  recallBotId: string | null;
  botStatus: UnifiedBotStatus;
  skipReason: string | null;
  createdAt: string;
  updatedAt: string;
};

type UnifiedMeetingsScanSummary = {
  usersScanned: number;
  eventsChecked: number;
  meetingsReturned: number;
  botScheduled: number;
  botSkipped: number;
  errors: string[];
};

type UnifiedScheduleSummary = {
  checked: number;
  scheduled: number;
  skipped: number;
  errors: string[];
};

type StateEntry = {
  dedupeKey: string;
  googleEventId: string;
  iCalUID: string;
  calendarUserEmail: string;
  title?: string;
  meetingUrl: string;
  startTime: string;
  endTime?: string;
  botJoinAt: string;
  recallBotId: string;
  creationSource?: "notetaker_managed" | "direct_recall_fallback";
  scheduledAt: string;
  status: "scheduled";
};

type ScheduledState = {
  scheduled: StateEntry[];
};

const CACHE_TTL_MS = 60_000;
const BOT_JOIN_OFFSET_MS = 2 * 60 * 1000;

let cache: { at: number; meetings: UnifiedMeeting[]; summary: UnifiedMeetingsScanSummary } | null = null;

function stateFilePath(): string {
  const configured = process.env.ALYSON_SCHEDULED_STATE_PATH?.trim();
  if (configured) return configured;

  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  if (isServerless) {
    const tmpRoot = process.env.TMPDIR?.trim() || "/tmp";
    return path.join(tmpRoot, "alyson_scheduled_state.json");
  }

  return path.resolve(process.cwd(), "alyson_scheduled_state.json");
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function nowIso() {
  return new Date().toISOString();
}

function formatDateDDMMYYYY(isoLike: string): string {
  const d = new Date(isoLike);
  if (!Number.isFinite(d.getTime())) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  return `${dd}${mm}${yyyy}`;
}

function buildUnifiedTitle(title: string, startTime: string): string {
  const datePrefix = formatDateDDMMYYYY(startTime);
  const cleanTitle = String(title || "Meeting").trim() || "Meeting";
  return datePrefix ? `${datePrefix} ${cleanTitle}` : cleanTitle;
}

function encodeMeetingId(calendarUserEmail: string, googleEventId: string): string {
  return Buffer.from(`${calendarUserEmail}::${googleEventId}`).toString("base64url");
}

function decodeMeetingId(meetingId: string): { email: string; googleEventId: string } | null {
  try {
    const raw = Buffer.from(meetingId, "base64url").toString("utf8");
    const [email, googleEventId] = raw.split("::");
    if (!email || !googleEventId) return null;
    return { email, googleEventId };
  } catch {
    return null;
  }
}

function sanitizeUrl(url: string | null | undefined): string | null {
  const v = String(url || "").trim();
  return v || null;
}

export function getMeetingUrl(event: any): string | null {
  const hangout = sanitizeUrl(event?.hangoutLink);
  if (hangout) return hangout;

  const entryPoints = event?.conferenceData?.entryPoints;
  if (!Array.isArray(entryPoints)) return null;
  const video = entryPoints.find((ep: any) => String(ep?.entryPointType) === "video");
  return sanitizeUrl(video?.uri);
}

function containsSkipKeywords(title: string): boolean {
  const t = title.toLowerCase();
  return ["out of office", "ooo", "lunch", "break", "holiday"].some((k) => t.includes(k));
}

function computeSkipReason(event: any, meetingUrl: string | null): string | null {
  const status = String(event?.status || "");
  if (status === "cancelled") return "Event is cancelled";
  if (!meetingUrl) return "No meeting URL";
  if (!event?.start?.dateTime) return "Missing start dateTime";
  const eventType = String(event?.eventType || "");
  if (eventType === "outOfOffice" || eventType === "focusTime") return `Skipped eventType ${eventType}`;
  const title = String(event?.summary || "Untitled meeting");
  if (containsSkipKeywords(title)) return "Skipped by title keyword";
  const startMs = new Date(event.start.dateTime).getTime();
  if (!Number.isFinite(startMs) || startMs < Date.now()) return "Meeting start time is in the past";
  return null;
}

function computeBotJoinAt(startTime: string): string | null {
  const startMs = new Date(startTime).getTime();
  if (!Number.isFinite(startMs)) return null;
  const now = Date.now();
  if (startMs <= now) return null;
  const joinMs = startMs - BOT_JOIN_OFFSET_MS;
  return new Date(joinMs > now ? joinMs : now).toISOString();
}

async function loadServiceAccountJwtForSubject(subject: string, scopes: string[]) {
  let parsed: { client_email?: string; private_key?: string } | null = null;
  const inlineJson = process.env.GOOGLE_DWD_SERVICE_ACCOUNT_JSON?.trim();
  if (inlineJson) {
    try {
      parsed = JSON.parse(inlineJson) as { client_email?: string; private_key?: string };
    } catch {
      throw new Error("Invalid GOOGLE_DWD_SERVICE_ACCOUNT_JSON (must be valid JSON)");
    }
  } else {
    const credentialsPath = env("GOOGLE_APPLICATION_CREDENTIALS");
    const txt = await fs.readFile(credentialsPath, "utf8");
    parsed = JSON.parse(txt) as { client_email?: string; private_key?: string };
  }

  const clientEmail = parsed.client_email || env("GOOGLE_DWD_SERVICE_ACCOUNT_EMAIL");
  const privateKey = parsed.private_key;
  if (!privateKey) {
    throw new Error("Failed to load private_key from GOOGLE_DWD_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS");
  }
  return new JWT({
    email: clientEmail,
    key: privateKey,
    scopes,
    subject,
  });
}

async function listActiveWorkspaceUsers(): Promise<string[]> {
  const adminSubject = env("GOOGLE_WORKSPACE_ADMIN_SUBJECT_EMAIL");
  const domain = env("GOOGLE_WORKSPACE_DOMAIN");
  const auth = await loadServiceAccountJwtForSubject(adminSubject, [
    "https://www.googleapis.com/auth/admin.directory.user.readonly",
  ]);
  const admin = google.admin({ version: "directory_v1", auth });
  const out: string[] = [];
  let pageToken: string | undefined;
  do {
    const r = await admin.users.list({
      domain,
      maxResults: 500,
      orderBy: "email",
      pageToken,
      query: "isSuspended=false",
    });
    for (const u of r.data.users ?? []) {
      if (u.suspended) continue;
      const email = String(u.primaryEmail || "").trim().toLowerCase();
      if (email) out.push(email);
    }
    pageToken = r.data.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

async function listCalendarEventsForUser(email: string, timeMin: string, timeMax: string): Promise<any[]> {
  const auth = await loadServiceAccountJwtForSubject(email, [
    "https://www.googleapis.com/auth/calendar.events.readonly",
  ]);
  const calendar = google.calendar({ version: "v3", auth });
  const out: any[] = [];
  let pageToken: string | undefined;
  do {
    const r = await calendar.events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      showDeleted: false,
      pageToken,
      maxResults: 250,
    });
    out.push(...(r.data.items ?? []));
    pageToken = r.data.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

async function getCalendarEventForUser(email: string, googleEventId: string): Promise<any | null> {
  const auth = await loadServiceAccountJwtForSubject(email, [
    "https://www.googleapis.com/auth/calendar.events.readonly",
  ]);
  const calendar = google.calendar({ version: "v3", auth });
  try {
    const r = await calendar.events.get({
      calendarId: "primary",
      eventId: googleEventId,
    });
    return r.data ?? null;
  } catch (e: any) {
    const status = Number(e?.code || e?.status || 0);
    if (status === 404) return null;
    throw e;
  }
}

async function readState(): Promise<ScheduledState> {
  const file = stateFilePath();
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as ScheduledState;
    return { scheduled: Array.isArray(parsed?.scheduled) ? parsed.scheduled : [] };
  } catch {
    return { scheduled: [] };
  }
}

async function writeState(state: ScheduledState): Promise<void> {
  const file = stateFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function dedupeKey(meetingUrl: string, startTime: string): string {
  return `${meetingUrl}|${startTime}`;
}

// Legacy key included calendar user; keep for backward compatibility
// with already-written local state rows.
function dedupeKeyLegacy(meetingUrl: string, startTime: string, calendarUserEmail: string): string {
  return `${meetingUrl}|${startTime}|${calendarUserEmail.toLowerCase()}`;
}

async function createRecallBot(args: {
  meetingUrl: string;
  botJoinAt: string;
  meeting: UnifiedMeeting;
}): Promise<{ botId: string }> {
  const apiKey = env("RECALL_API_KEY");
  const rawBase = (process.env.RECALL_BASE_URL?.trim() || "https://ap-northeast-1.recall.ai").replace(/\/$/, "");
  const hostBase = rawBase.replace(/\/api\/v[0-9]+$/i, "");
  const botName = process.env.BOT_NAME?.trim() || "Alyson Notetaker";
  const url = `${hostBase}/api/v1/bot/`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      meeting_url: args.meetingUrl,
      bot_name: botName,
      join_at: args.botJoinAt,
      metadata: {
        source: "unified_meetings",
        google_event_id: args.meeting.googleEventId,
        ical_uid: args.meeting.iCalUID,
        calendar_user: args.meeting.calendarUserEmail,
        summary: args.meeting.title,
        meeting_url: args.meeting.meetingUrl,
        bot_join_offset_minutes: 2,
      },
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  const txt = await res.text();
  let body: any = null;
  try {
    body = txt ? JSON.parse(txt) : null;
  } catch {
    body = txt;
  }
  if (!res.ok) {
    const msg = body?.detail || body?.message || `Recall create bot failed (${res.status})`;
    throw new Error(String(msg));
  }
  const botId = String(body?.id || body?.bot_id || "");
  if (!botId) throw new Error("Recall bot creation succeeded but bot id was missing");
  return { botId };
}

async function createNotetakerManagedBot(args: {
  meetingUrl: string;
  botJoinAt: string;
  meeting: UnifiedMeeting;
}): Promise<{ botId: string }> {
  const raw =
    process.env.ALYSON_NOTETAKER_BASE_URL ||
    process.env.VITE_ALYSON_NOTETAKER_BASE_URL ||
    process.env.TEST_BOTV2_BASE_URL ||
    process.env.VITE_TEST_BOTV2_BASE_URL ||
    "http://localhost:3003";
  const base = String(raw).replace(/\/$/, "");
  const url = `${base}/api/create-bot`;
  const botName = process.env.BOT_NAME?.trim() || "Alyson Notetaker";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      meeting_url: args.meetingUrl,
      bot_name: botName,
      title: args.meeting.title,
      join_at: args.botJoinAt,
      metadata: {
        source: "unified_meetings",
        google_event_id: args.meeting.googleEventId,
        ical_uid: args.meeting.iCalUID,
        calendar_user: args.meeting.calendarUserEmail,
        summary: args.meeting.title,
        meeting_url: args.meeting.meetingUrl,
        bot_join_offset_minutes: 2,
      },
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  const txt = await res.text();
  let body: any = null;
  try {
    body = txt ? JSON.parse(txt) : null;
  } catch {
    body = txt;
  }
  if (!res.ok) {
    const msg =
      (body && typeof body === "object" && (body.error || body.message)) ||
      `Notetaker create bot failed (${res.status})`;
    throw new Error(String(msg));
  }
  const botId = String(body?.botId || body?.id || body?.bot_id || "");
  if (!botId) throw new Error("Notetaker create bot succeeded but bot id was missing");
  return { botId };
}

function normalizeMeetingEvent(userEmail: string, event: any, stateByKey: Map<string, StateEntry>): UnifiedMeeting {
  const startTime = String(event?.start?.dateTime || "");
  const endTime = String(event?.end?.dateTime || "");
  const meetingUrl = getMeetingUrl(event);
  const skipReason = computeSkipReason(event, meetingUrl);
  const title = String(event?.summary || "Untitled meeting");
  const iCalUID = String(event?.iCalUID || event?.id || "");
  const dedupe = meetingUrl ? dedupeKey(meetingUrl, startTime) : "";
  const legacyDedupe = meetingUrl ? dedupeKeyLegacy(meetingUrl, startTime, userEmail) : "";
  const stateEntry = dedupe ? (stateByKey.get(dedupe) || stateByKey.get(legacyDedupe)) : undefined;

  let shouldBotJoin = false;
  let botStatus: UnifiedBotStatus = "not_required";
  let reason: string | null = skipReason;
  if (!skipReason) {
    shouldBotJoin = true;
    botStatus = stateEntry ? "scheduled" : "pending";
    reason = null;
  }

  return {
    id: encodeMeetingId(userEmail, String(event?.id || "")),
    googleEventId: String(event?.id || ""),
    iCalUID,
    calendarUserEmail: userEmail,
    title,
    startTime,
    endTime,
    timezone: String(event?.start?.timeZone || event?.end?.timeZone || "UTC"),
    meetingUrl,
    meetingPlatform: meetingUrl?.includes("meet.google.com") ? "google_meet" : "unknown",
    eventType: String(event?.eventType || "default"),
    status: String(event?.status || "confirmed"),
    organizerEmail: event?.organizer?.email ? String(event.organizer.email) : null,
    attendees: Array.isArray(event?.attendees)
      ? event.attendees.map((a: any) => String(a?.email || "").trim()).filter(Boolean)
      : [],
    shouldBotJoin,
    botScheduled: Boolean(stateEntry),
    botJoinAt: shouldBotJoin ? computeBotJoinAt(startTime) : null,
    recallBotId: stateEntry?.recallBotId ? String(stateEntry.recallBotId) : null,
    botStatus,
    skipReason: reason,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function applyFilters(meetings: UnifiedMeeting[], filters: {
  email?: string | null;
  botStatus?: string | null;
  hasMeetLink?: string | null;
  shouldBotJoin?: string | null;
  search?: string | null;
}): UnifiedMeeting[] {
  let out = meetings;
  if (filters.email?.trim()) {
    const q = filters.email.trim().toLowerCase();
    out = out.filter((m) => m.calendarUserEmail.toLowerCase().includes(q));
  }
  if (filters.botStatus?.trim()) {
    const q = filters.botStatus.trim();
    out = out.filter((m) => m.botStatus === q);
  }
  if (filters.hasMeetLink === "true") out = out.filter((m) => Boolean(m.meetingUrl));
  if (filters.hasMeetLink === "false") out = out.filter((m) => !m.meetingUrl);
  if (filters.shouldBotJoin === "true") out = out.filter((m) => m.shouldBotJoin);
  if (filters.shouldBotJoin === "false") out = out.filter((m) => !m.shouldBotJoin);
  if (filters.search?.trim()) {
    const q = filters.search.trim().toLowerCase();
    out = out.filter((m) =>
      [m.title, m.calendarUserEmail, m.organizerEmail || "", m.meetingUrl || ""]
        .some((v) => v.toLowerCase().includes(q)),
    );
  }
  return out;
}

async function scanWorkspaceMeetings(): Promise<{ meetings: UnifiedMeeting[]; summary: UnifiedMeetingsScanSummary }> {
  const summary: UnifiedMeetingsScanSummary = {
    usersScanned: 0,
    eventsChecked: 0,
    meetingsReturned: 0,
    botScheduled: 0,
    botSkipped: 0,
    errors: [],
  };
  const users = await listActiveWorkspaceUsers().catch((e) => {
    throw new Error(`Failed to list Workspace users: ${e instanceof Error ? e.message : "Unknown error"}`);
  });

  const timeMin = new Date();
  const timeMax = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const state = await readState();
  const stateByKey = new Map(state.scheduled.map((s) => [s.dedupeKey, s]));

  const meetings: UnifiedMeeting[] = [];
  for (const userEmail of users) {
    summary.usersScanned += 1;
    let events: any[] = [];
    try {
      events = await listCalendarEventsForUser(userEmail, timeMin.toISOString(), timeMax.toISOString());
    } catch (e) {
      summary.errors.push(`Calendar read failed for ${userEmail}: ${e instanceof Error ? e.message : "Unknown error"}`);
      continue;
    }

    for (const event of events) {
      summary.eventsChecked += 1;
      const meeting = normalizeMeetingEvent(userEmail, event, stateByKey);
      meetings.push(meeting);
    }
  }

  summary.meetingsReturned = meetings.length;
  return { meetings, summary };
}

async function ensureCacheFresh(force = false): Promise<{ meetings: UnifiedMeeting[]; summary: UnifiedMeetingsScanSummary }> {
  if (!force && cache && Date.now() - cache.at <= CACHE_TTL_MS) {
    return { meetings: cache.meetings, summary: cache.summary };
  }
  const scanned = await scanWorkspaceMeetings();
  cache = { at: Date.now(), meetings: scanned.meetings, summary: scanned.summary };
  return scanned;
}

export async function getUnifiedMeetings(filters: {
  email?: string | null;
  botStatus?: string | null;
  hasMeetLink?: string | null;
  shouldBotJoin?: string | null;
  search?: string | null;
} = {}, options: { forceRefresh?: boolean } = {}): Promise<{ meetings: UnifiedMeeting[]; summary: UnifiedMeetingsScanSummary }> {
  const { meetings, summary } = await ensureCacheFresh(Boolean(options.forceRefresh));
  return { meetings: applyFilters(meetings, filters), summary };
}

export async function refreshUnifiedMeetings(): Promise<UnifiedMeetingsScanSummary> {
  const { summary } = await ensureCacheFresh(true);
  return summary;
}

async function scheduleMeetingInternal(meeting: UnifiedMeeting): Promise<{ scheduled: boolean; error?: string }> {
  if (!meeting.meetingUrl) return { scheduled: false, error: "No meeting URL" };
  const joinAt = computeBotJoinAt(meeting.startTime);
  if (!joinAt) return { scheduled: false, error: "Meeting start time is in the past" };

  const state = await readState();
  const key = dedupeKey(meeting.meetingUrl, meeting.startTime);
  const legacyKey = dedupeKeyLegacy(meeting.meetingUrl, meeting.startTime, meeting.calendarUserEmail);
  if (state.scheduled.some((s) => s.dedupeKey === key || s.dedupeKey === legacyKey)) {
    return { scheduled: false, error: "Already scheduled (dedupe)" };
  }

  try {
    let recall: { botId: string };
    let creationSource: StateEntry["creationSource"] = "notetaker_managed";
    try {
      // Preferred path: notetaker-managed creation (manual-like transcript flow).
      recall = await createNotetakerManagedBot({ meetingUrl: meeting.meetingUrl, botJoinAt: joinAt, meeting });
    } catch (managedErr) {
      // Fallback path: direct Recall scheduling if notetaker service cannot create bot
      // (e.g. provider-side credit/env mismatch).
      recall = await createRecallBot({ meetingUrl: meeting.meetingUrl, botJoinAt: joinAt, meeting });
      creationSource = "direct_recall_fallback";
    }
    state.scheduled.push({
      dedupeKey: key,
      googleEventId: meeting.googleEventId,
      iCalUID: meeting.iCalUID,
      calendarUserEmail: meeting.calendarUserEmail,
      title: buildUnifiedTitle(meeting.title, meeting.startTime),
      meetingUrl: meeting.meetingUrl,
      startTime: meeting.startTime,
      endTime: meeting.endTime,
      botJoinAt: joinAt,
      recallBotId: recall.botId,
      creationSource,
      scheduledAt: nowIso(),
      status: "scheduled",
    });
    await writeState(state);
    return { scheduled: true };
  } catch (e) {
    return {
      scheduled: false,
      error: e instanceof Error ? e.message : "Failed to schedule bot",
    };
  }
}

export async function scheduleEligibleUnifiedBots(): Promise<UnifiedScheduleSummary> {
  const { meetings } = await ensureCacheFresh(true);
  const out: UnifiedScheduleSummary = { checked: meetings.length, scheduled: 0, skipped: 0, errors: [] };
  for (const meeting of meetings) {
    if (!meeting.shouldBotJoin) {
      out.skipped += 1;
      continue;
    }
    const result = await scheduleMeetingInternal(meeting);
    if (result.scheduled) out.scheduled += 1;
    else {
      out.skipped += 1;
      if (result.error) out.errors.push(`${meeting.googleEventId}: ${result.error}`);
    }
  }
  cache = null;
  return out;
}

export async function scheduleUnifiedMeetingById(meetingId: string): Promise<{ ok: boolean; message: string }> {
  const decoded = decodeMeetingId(meetingId);
  if (!decoded) return { ok: false, message: "Invalid meeting id" };
  const state = await readState();
  const stateByKey = new Map(state.scheduled.map((s) => [s.dedupeKey, s]));
  const event = await getCalendarEventForUser(decoded.email, decoded.googleEventId);
  if (!event) return { ok: false, message: "Meeting not found in calendar" };
  const meeting = normalizeMeetingEvent(decoded.email, event, stateByKey);

  if (meeting.status === "cancelled") return { ok: false, message: "Cannot schedule cancelled meeting" };
  if (!meeting.meetingUrl) return { ok: false, message: "Cannot schedule: no meeting URL" };
  if (!meeting.startTime) return { ok: false, message: "Cannot schedule: missing start dateTime" };

  const result = await scheduleMeetingInternal(meeting);
  cache = null;
  if (!result.scheduled) return { ok: false, message: result.error || "Not scheduled" };
  return { ok: true, message: "Alyson scheduled" };
}
