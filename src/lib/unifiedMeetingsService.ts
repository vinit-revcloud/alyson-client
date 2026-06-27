import { google } from "googleapis";
import { JWT } from "google-auth-library";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dispatchBotWithLiveTranscripts, ensureBotTranscriptPipeline } from "@/lib/notetaker-bot-dispatch.server";
import { resolveRecallTranscriptWebhookUrl } from "@/lib/recall/recall-bot-config.server";
import { registerScheduledBotInSessionsCatalog } from "@/lib/notetaker-scheduled-catalog.server";
import { unifiedScheduledStatusForUi } from "@/lib/unified-scheduled-lifecycle.server";
import {
  readUnifiedScheduledStateFromS3,
  unifiedScheduledStateUsesS3,
  writeUnifiedScheduledStateToS3,
  type UnifiedScheduledStateEntry,
} from "@/lib/unified-scheduled-s3.server";

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

type StateEntry = UnifiedScheduledStateEntry;

type ScheduledState = {
  scheduled: StateEntry[];
};

const CACHE_TTL_MS = 60_000;
const BOT_JOIN_OFFSET_MS = 2 * 60 * 1000;
/** Recall needs join_at slightly in the future for "join now". */
const IMMEDIATE_JOIN_DELAY_MS = 20 * 1000;
const MEETING_END_GRACE_MS = 20 * 60 * 1000;

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

function computeSkipReason(
  event: any,
  meetingUrl: string | null,
  options?: { allowInProgress?: boolean },
): string | null {
  const status = String(event?.status || "");
  if (status === "cancelled") return "Event is cancelled";
  if (!meetingUrl) return "No meeting URL";
  if (!event?.start?.dateTime) return "Missing start dateTime";
  const eventType = String(event?.eventType || "");
  if (eventType === "outOfOffice" || eventType === "focusTime") return `Skipped eventType ${eventType}`;
  const title = String(event?.summary || "Untitled meeting");
  if (containsSkipKeywords(title)) return "Skipped by title keyword";
  const startMs = new Date(event.start.dateTime).getTime();
  const endMs = event?.end?.dateTime ? new Date(event.end.dateTime).getTime() : NaN;
  const effectiveEnd = Number.isFinite(endMs)
    ? endMs + MEETING_END_GRACE_MS
    : startMs + 3 * 60 * 60 * 1000;
  if (options?.allowInProgress) {
    if (!Number.isFinite(startMs)) return "Missing start dateTime";
    if (Date.now() > effectiveEnd) return "Meeting has ended";
    return null;
  }
  if (!Number.isFinite(startMs) || startMs < Date.now()) return "Meeting start time is in the past";
  return null;
}

/**
 * Smart schedule / calendar: reserve the bot for start − offset — never join immediately while the
 * meeting has not started (avoids waiting-room timeout before the call begins).
 */
export function resolvePlannedCalendarJoinAt(
  startTime: string,
  endTime?: string,
  joinOffsetMs: number = BOT_JOIN_OFFSET_MS,
): string | null {
  const startMs = new Date(startTime).getTime();
  if (!Number.isFinite(startMs)) return null;
  const now = Date.now();
  const endMs = endTime ? new Date(endTime).getTime() : NaN;
  const effectiveEnd = Number.isFinite(endMs) ? endMs + MEETING_END_GRACE_MS : startMs + 3 * 60 * 60 * 1000;

  if (now > effectiveEnd) return null;

  const plannedJoinMs = startMs - joinOffsetMs;
  /** Recall rejects join_at in the past; keep at least ~90s ahead when still before meeting start. */
  const MIN_SCHEDULE_AHEAD_MS = 90 * 1000;

  if (now < startMs) {
    const joinMs = Math.max(plannedJoinMs, now + MIN_SCHEDULE_AHEAD_MS);
    const cappedJoinMs = Math.min(joinMs, startMs - 30_000);
    if (!Number.isFinite(cappedJoinMs) || cappedJoinMs <= now) return null;
    return new Date(cappedJoinMs).toISOString();
  }

  if (now <= effectiveEnd) {
    return new Date(now + IMMEDIATE_JOIN_DELAY_MS).toISOString();
  }

  return null;
}

/**
 * When the meeting is in progress, schedule join ASAP (not only at calendar start − 2 min).
 * Returns null only after the meeting window has ended.
 */
export function resolveBotJoinAt(
  startTime: string,
  endTime?: string,
  joinOffsetMs: number = BOT_JOIN_OFFSET_MS,
): string | null {
  const startMs = new Date(startTime).getTime();
  if (!Number.isFinite(startMs)) return null;
  const now = Date.now();
  const endMs = endTime ? new Date(endTime).getTime() : NaN;
  const effectiveEnd = Number.isFinite(endMs) ? endMs + MEETING_END_GRACE_MS : startMs + 3 * 60 * 60 * 1000;

  if (now > effectiveEnd) return null;

  const plannedJoinMs = startMs - joinOffsetMs;
  const inMeetingWindow = now >= plannedJoinMs && now <= effectiveEnd;

  if (inMeetingWindow) {
    return new Date(now + IMMEDIATE_JOIN_DELAY_MS).toISOString();
  }

  if (startMs <= now) return null;

  const joinMs = plannedJoinMs;
  return new Date(joinMs > now ? joinMs : now + IMMEDIATE_JOIN_DELAY_MS).toISOString();
}

/** @deprecated Use resolveBotJoinAt */
function computeBotJoinAt(startTime: string, endTime?: string) {
  return resolveBotJoinAt(startTime, endTime);
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
  if (unifiedScheduledStateUsesS3()) {
    try {
      const fromS3 = await readUnifiedScheduledStateFromS3();
      return { scheduled: fromS3.scheduled };
    } catch {
      // fall through to local file
    }
  }
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
  if (unifiedScheduledStateUsesS3()) {
    try {
      await writeUnifiedScheduledStateToS3({
        version: 1,
        updatedAt: nowIso(),
        scheduled: state.scheduled,
      });
    } catch (e) {
      console.error("[unified-schedule] S3 write failed:", e);
      throw e;
    }
  }
  const file = stateFilePath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    if (!unifiedScheduledStateUsesS3()) throw new Error("Failed to write unified scheduled state");
  }
}

export type UnifiedScheduledBotSession = {
  botId: string;
  title: string;
  meetingUrl?: string;
  createdAt: string;
  status: string;
  creationSource?: StateEntry["creationSource"];
};

/**
 * All bots recorded in unified scheduling state (no time-window filter).
 * Used so Alyson Notetaker sessions list keeps scheduled meetings after they end.
 */
export async function listAllUnifiedScheduledBotSessions(): Promise<UnifiedScheduledBotSession[]> {
  const state = await readState();
  const out: UnifiedScheduledBotSession[] = [];
  const seen = new Set<string>();

  for (const row of state.scheduled) {
    const botId = String(row.recallBotId || "").trim();
    if (!botId || seen.has(botId)) continue;
    seen.add(botId);
    out.push({
      botId,
      title: String(row.title || "Unified meeting"),
      meetingUrl: row.meetingUrl ? String(row.meetingUrl) : undefined,
      createdAt: String(row.scheduledAt || row.startTime || new Date().toISOString()),
      status: unifiedScheduledStatusForUi(row),
      creationSource: row.creationSource,
    });
  }

  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function dedupeKey(meetingUrl: string, startTime: string): string {
  return `${meetingUrl}|${startTime}`;
}

// Legacy key included calendar user; keep for backward compatibility
// with already-written local state rows.
function dedupeKeyLegacy(meetingUrl: string, startTime: string, calendarUserEmail: string): string {
  return `${meetingUrl}|${startTime}|${calendarUserEmail.toLowerCase()}`;
}

function normalizeMeetingEvent(
  userEmail: string,
  event: any,
  stateByKey: Map<string, StateEntry>,
  options?: { allowInProgress?: boolean; joinOffsetMs?: number },
): UnifiedMeeting {
  const startTime = String(event?.start?.dateTime || "");
  const endTime = String(event?.end?.dateTime || "");
  const meetingUrl = getMeetingUrl(event);
  const skipReason = computeSkipReason(event, meetingUrl, options);
  const joinOffsetMs = options?.joinOffsetMs ?? BOT_JOIN_OFFSET_MS;
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
    botJoinAt: shouldBotJoin ? resolvePlannedCalendarJoinAt(startTime, endTime, joinOffsetMs) : null,
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

async function dispatchBotForMeeting(
  meeting: UnifiedMeeting,
  joinAt: string,
  joinOffsetMinutes?: number,
): Promise<{ botId: string; creationSource: StateEntry["creationSource"] }> {
  const { botId, creationSource } = await dispatchBotWithLiveTranscripts({
    meetingUrl: meeting.meetingUrl!,
    botJoinAt: joinAt,
    title: meeting.title,
    joinOffsetMinutes,
    metadata: {
      source: "unified_meetings",
      google_event_id: meeting.googleEventId,
      ical_uid: meeting.iCalUID,
      calendar_user: meeting.calendarUserEmail,
      summary: meeting.title,
      meeting_url: meeting.meetingUrl,
    },
  });
  return { botId, creationSource };
}

async function scheduleMeetingInternal(
  meeting: UnifiedMeeting,
  options?: { forceRedispatch?: boolean; joinOffsetMs?: number },
): Promise<{ scheduled: boolean; error?: string; redispatched?: boolean; botJoinAt?: string }> {
  if (!meeting.meetingUrl) return { scheduled: false, error: "No meeting URL" };
  const joinOffsetMs = options?.joinOffsetMs ?? BOT_JOIN_OFFSET_MS;
  const joinOffsetMinutes = Math.round(joinOffsetMs / 60_000);
  const joinAt = resolvePlannedCalendarJoinAt(meeting.startTime, meeting.endTime, joinOffsetMs);
  if (!joinAt) {
    return {
      scheduled: false,
      error: "Meeting has ended or is not joinable. Pick a future meeting or join while the event is still active.",
    };
  }

  const state = await readState();
  const key = dedupeKey(meeting.meetingUrl, meeting.startTime);
  const legacyKey = dedupeKeyLegacy(meeting.meetingUrl, meeting.startTime, meeting.calendarUserEmail);
  const existingIdx = state.scheduled.findIndex(
    (s) => s.dedupeKey === key || s.dedupeKey === legacyKey,
  );

  const priorJoinPassed = existingIdx >= 0 && new Date(state.scheduled[existingIdx]!.botJoinAt).getTime() < Date.now() - 60_000;
  const inWindow = resolvePlannedCalendarJoinAt(meeting.startTime, meeting.endTime, joinOffsetMs) != null;
  const shouldRedispatch =
    Boolean(options?.forceRedispatch) || (existingIdx >= 0 && inWindow && priorJoinPassed);

  if (existingIdx >= 0 && !shouldRedispatch) {
    const existing = state.scheduled[existingIdx]!;
    if (existing.recallBotId) {
      await ensureBotTranscriptPipeline({
        botId: existing.recallBotId,
        title: buildUnifiedTitle(meeting.title, meeting.startTime),
        meetingUrl: meeting.meetingUrl!,
        botJoinAt: existing.botJoinAt || joinAt,
        metadata: { source: "unified_meetings", google_event_id: meeting.googleEventId },
      });
    }
    return { scheduled: false, error: "Already scheduled (dedupe). Bot id is stored in S3 state." };
  }

  try {
    const { botId, creationSource } = await dispatchBotForMeeting(meeting, joinAt, joinOffsetMinutes);
    const entry: StateEntry = {
      dedupeKey: key,
      googleEventId: meeting.googleEventId,
      iCalUID: meeting.iCalUID,
      calendarUserEmail: meeting.calendarUserEmail,
      title: buildUnifiedTitle(meeting.title, meeting.startTime),
      meetingUrl: meeting.meetingUrl,
      startTime: meeting.startTime,
      endTime: meeting.endTime,
      botJoinAt: joinAt,
      recallBotId: botId,
      creationSource,
      scheduledAt: nowIso(),
      lastStatusAt: nowIso(),
      transcriptWebhookUrl: resolveRecallTranscriptWebhookUrl(),
      status: "scheduled",
    };

    if (existingIdx >= 0) {
      state.scheduled[existingIdx] = entry;
    } else {
      state.scheduled.push(entry);
    }
    await writeState(state);

    const catalogTitle = buildUnifiedTitle(meeting.title, meeting.startTime);
    await registerScheduledBotInSessionsCatalog({
      botId,
      title: catalogTitle,
      meetingUrl: meeting.meetingUrl,
      createdAt: nowIso(),
      status: "scheduled",
    });

    return { scheduled: true, redispatched: shouldRedispatch && existingIdx >= 0, botJoinAt: joinAt };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to schedule bot";
    if (existingIdx >= 0) {
      state.scheduled[existingIdx] = {
        ...state.scheduled[existingIdx]!,
        status: "failed",
        lastError: message,
      };
      try {
        await writeState(state);
      } catch {
        // ignore
      }
    }
    return { scheduled: false, error: message };
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

export async function scheduleUnifiedMeetingById(
  meetingId: string,
  options?: { forceRedispatch?: boolean },
): Promise<{ ok: boolean; message: string; botId?: string; redispatched?: boolean }> {
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

  const result = await scheduleMeetingInternal(meeting, options);
  cache = null;
  if (!result.scheduled) return { ok: false, message: result.error || "Not scheduled" };
  const updated = await readState();
  const key = dedupeKey(meeting.meetingUrl!, meeting.startTime);
  const row = updated.scheduled.find((s) => s.dedupeKey === key);
  return {
    ok: true,
    message: result.redispatched
      ? "Alyson bot re-dispatched to join now (prior join time had passed)"
      : "Alyson scheduled",
    botId: row?.recallBotId,
    redispatched: result.redispatched,
  };
}
