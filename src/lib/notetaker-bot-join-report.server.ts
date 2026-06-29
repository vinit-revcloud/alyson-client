import { google } from "googleapis";
import { JWT } from "google-auth-library";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fetchRecallBotLifecycles } from "@/lib/recall/recall-bot-status.server";
import { eventTitleFromRaw, listAllRecallCalendarEvents } from "@/lib/recall/recall-calendar-v2.server";
import { buildNotetakerSessionsList } from "@/lib/notetaker-sessions-list.server";
import { getMeetingUrl, listAllUnifiedScheduledBotSessions } from "@/lib/unifiedMeetingsService";
import {
  readUnifiedScheduledStateFromS3,
  unifiedScheduledStateUsesS3,
  type UnifiedScheduledStateEntry,
} from "@/lib/unified-scheduled-s3.server";
import { listAllBotIndexDocs } from "@/lib/notetaker-sessions-history.server";
import { readRecallCalendarState } from "@/lib/recall/recall-calendar-state-s3.server";
import {
  DEFAULT_BOT_JOIN_REPORT_EMAIL,
  type BotJoinCriticalMetrics,
  type BotJoinDailyPoint,
  type BotJoinReport,
  type BotJoinReportDiagnostics,
  type BotJoinReportRow,
  type CalendarMeetingRef,
} from "@/lib/notetaker-bot-join-report.types";
import {
  applyAdmissionTimingToRow,
  computeAdmissionTiming,
  LATE_GRACE_SECONDS,
  resolveMeetingStartForCandidate,
} from "@/lib/notetaker-bot-join-timing.server";

export { DEFAULT_BOT_JOIN_REPORT_EMAIL };
export type {
  BotJoinReport,
  BotJoinReportRow,
  CalendarMeetingRef,
  BotJoinCriticalMetrics,
  BotJoinReportDiagnostics,
  BotJoinDailyPoint,
};

type ScheduledState = { scheduled: UnifiedScheduledStateEntry[] };

const reportCache = new Map<string, { at: number; report: BotJoinReport }>();
const REPORT_CACHE_TTL_MS = 10 * 60_000;

function reportCacheKey(calendarEmail: string, start: string, end: string, windowHours?: number) {
  return `${calendarEmail}|${start}|${end}|${windowHours ?? "days"}`;
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function recallConfigured(): boolean {
  return Boolean(process.env.RECALL_API_KEY?.trim());
}

function dwdConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_DWD_SERVICE_ACCOUNT_JSON?.trim() ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim(),
  );
}


function eventDay(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function inRangeDay(day: string | null, start: string, end: string): boolean {
  if (!day) return false;
  return day >= start && day <= end;
}

function rollingWindowBounds(windowHours: number): { windowStart: string; windowEnd: string; floorMs: number } {
  const windowEnd = new Date().toISOString();
  const floorMs = Date.now() - windowHours * 3600_000;
  return { windowStart: new Date(floorMs).toISOString(), windowEnd, floorMs };
}

function inReportWindow(
  iso: string | null | undefined,
  start: string,
  end: string,
  windowHours?: number,
  floorMs?: number,
): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  if (windowHours) {
    const floor = floorMs ?? Date.now() - windowHours * 3600_000;
    return ms >= floor && ms <= Date.now();
  }
  return inRangeDay(eventDay(iso), start, end);
}

function normalizeStartIso(iso: string): string {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(iso).trim();
}

function meetingDedupeKey(meetingUrl: string, startTime: string): string {
  return `${String(meetingUrl).trim()}|${normalizeStartIso(startTime)}`;
}

function containsSkipKeywords(title: string): boolean {
  const t = title.toLowerCase();
  return ["out of office", "ooo", "lunch", "break", "holiday"].some((k) => t.includes(k));
}

function historicalSkipReason(event: any, meetingUrl: string | null): string | null {
  const status = String(event?.status || "");
  if (status === "cancelled") return "Event is cancelled";
  if (!meetingUrl) return "No meeting URL";
  if (!event?.start?.dateTime) return "Missing start dateTime";
  const eventType = String(event?.eventType || "");
  if (eventType === "outOfOffice" || eventType === "focusTime") return `Skipped eventType ${eventType}`;
  const title = String(event?.summary || "Untitled meeting");
  if (containsSkipKeywords(title)) return "Skipped by title keyword";
  return null;
}

async function loadServiceAccountJwtForSubject(subject: string, scopes: string[]) {
  let parsed: { client_email?: string; private_key?: string };
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

async function readScheduledState(): Promise<ScheduledState> {
  if (unifiedScheduledStateUsesS3()) {
    try {
      const fromS3 = await readUnifiedScheduledStateFromS3();
      return { scheduled: fromS3.scheduled };
    } catch {
      // fall through
    }
  }
  const configured = process.env.ALYSON_SCHEDULED_STATE_PATH?.trim();
  const file =
    configured ||
    (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
      ? path.join(process.env.TMPDIR?.trim() || "/tmp", "alyson_scheduled_state.json")
      : path.resolve(process.cwd(), "alyson_scheduled_state.json"));
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as ScheduledState;
    return { scheduled: Array.isArray(parsed?.scheduled) ? parsed.scheduled : [] };
  } catch {
    return { scheduled: [] };
  }
}

function formatWaitingRoom(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function daysBetweenInclusive(start: string, end: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${start}T12:00:00Z`);
  const endMs = new Date(`${end}T12:00:00Z`).getTime();
  while (cur.getTime() <= endMs) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function buildDailySeries(args: {
  start: string;
  end: string;
  eligibleMeetings: CalendarMeetingRef[];
  joinedMeetings: BotJoinReportRow[];
  missedMeetings: CalendarMeetingRef[];
}): BotJoinDailyPoint[] {
  const days = daysBetweenInclusive(args.start, args.end);
  const eligibleByDay = new Map<string, number>();
  const joinedByDay = new Map<string, number>();
  const missedByDay = new Map<string, number>();
  const lateByDay = new Map<string, number[]>();

  for (const day of days) {
    eligibleByDay.set(day, 0);
    joinedByDay.set(day, 0);
    missedByDay.set(day, 0);
    lateByDay.set(day, []);
  }

  for (const m of args.eligibleMeetings) {
    const day = eventDay(m.startTime);
    if (day) eligibleByDay.set(day, (eligibleByDay.get(day) ?? 0) + 1);
  }

  for (const m of args.missedMeetings) {
    const day = eventDay(m.startTime);
    if (day) missedByDay.set(day, (missedByDay.get(day) ?? 0) + 1);
  }

  for (const row of args.joinedMeetings) {
    const day = eventDay(row.meetingStartAt || row.scheduledStart || "");
    if (!day) continue;
    joinedByDay.set(day, (joinedByDay.get(day) ?? 0) + 1);
    if (row.lateMinutes != null) {
      lateByDay.get(day)?.push(row.lateMinutes);
    }
  }

  return days.map((day) => {
    const eligible = eligibleByDay.get(day) ?? 0;
    const joined = joinedByDay.get(day) ?? 0;
    const missed = missedByDay.get(day) ?? 0;
    const lates = lateByDay.get(day) ?? [];
    return {
      day,
      eligibleMeetings: eligible,
      meetingsJoined: joined,
      meetingsMissed: missed,
      joinRatePercent: eligible > 0 ? Math.round((joined / eligible) * 1000) / 10 : null,
      avgLateMinutes:
        lates.length > 0
          ? Math.round((lates.reduce((a, b) => a + b, 0) / lates.length) * 10) / 10
          : null,
      maxLateMinutes: lates.length > 0 ? Math.max(...lates) : null,
    };
  });
}

type BotCandidate = {
  botId: string;
  title: string;
  meetingUrl: string | null;
  scheduledStart: string | null;
  calendarUserEmail: string;
  googleEventId?: string;
  dedupeKey?: string;
  source: BotJoinReportRow["source"];
  creationSource?: string;
  scheduledAt?: string;
  botJoinAt?: string;
};

function meetingDedupeKeyRaw(meetingUrl: string, startTime: string): string {
  return `${String(meetingUrl).trim()}|${String(startTime).trim()}`;
}

function dedupeKeysForMeeting(meetingUrl: string, startTime: string): string[] {
  return [...new Set([meetingDedupeKey(meetingUrl, startTime), meetingDedupeKeyRaw(meetingUrl, startTime)])];
}

async function collectBotCandidates(
  calendarEmail: string,
  start: string,
  end: string,
  windowHours?: number,
  floorMs?: number,
): Promise<{ candidates: BotCandidate[]; diagnostics: BotJoinReportDiagnostics }> {
  const normalizedEmail = calendarEmail.trim().toLowerCase();
  const allowedEmails = new Set([normalizedEmail]);
  const warnings: string[] = [];

  let recallCalendarIds = new Set<string>();
  try {
    const calState = await readRecallCalendarState();
    for (const conn of calState.connections) {
      if (allowedEmails.has(conn.email.trim().toLowerCase())) {
        recallCalendarIds.add(conn.recallCalendarId);
      }
    }
  } catch (e) {
    warnings.push(`Recall calendar state: ${e instanceof Error ? e.message : String(e)}`);
  }

  const byBotId = new Map<string, BotCandidate>();
  let botsFromNotetakerSessions = 0;
  let botsFromUnifiedState = 0;
  let botsFromS3Index = 0;
  let botsFromRecallCalendar = 0;

  const addCandidate = (candidate: BotCandidate, bucket: keyof Omit<BotJoinReportDiagnostics, "warnings">) => {
    const botId = String(candidate.botId || "").trim();
    if (!botId) return;
    const isNew = !byBotId.has(botId);
    if (isNew) {
      if (bucket === "botsFromNotetakerSessions") botsFromNotetakerSessions += 1;
      if (bucket === "botsFromUnifiedState") botsFromUnifiedState += 1;
      if (bucket === "botsFromS3Index") botsFromS3Index += 1;
      if (bucket === "botsFromRecallCalendar") botsFromRecallCalendar += 1;
    }
    const prev = byBotId.get(botId);
    byBotId.set(botId, { ...prev, ...candidate, botId });
  };

  try {
    const { sessions } = await buildNotetakerSessionsList();
    for (const s of sessions) {
      const botId = String(s.botId || "").trim();
      if (!botId) continue;
      const anchor = String(s.createdAt || "").trim();
      if (anchor && !inReportWindow(anchor, start, end, windowHours, floorMs)) continue;
      addCandidate(
        {
          botId,
          title: String(s.title || "Meeting").trim() || "Meeting",
          meetingUrl: s.meetingUrl || null,
          scheduledStart: null,
          calendarUserEmail: normalizedEmail,
          source: "notetaker_session",
        },
        "botsFromNotetakerSessions",
      );
    }
  } catch (e) {
    warnings.push(`Notetaker sessions: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const unifiedSessions = await listAllUnifiedScheduledBotSessions();
    const state = await readScheduledState();
    const stateByBot = new Map(state.scheduled.map((row) => [String(row.recallBotId), row]));

    for (const s of unifiedSessions) {
      const botId = String(s.botId || "").trim();
      if (!botId) continue;
      const row = stateByBot.get(botId);
      const anchor = row?.startTime || row?.botJoinAt || row?.scheduledAt || s.createdAt;
      if (anchor && !inReportWindow(anchor, start, end, windowHours, floorMs)) continue;

      const rowEmail = String(row?.calendarUserEmail || "").trim().toLowerCase();
      const matchesEmail = rowEmail
        ? allowedEmails.has(rowEmail)
        : Boolean(row?.recallCalendarEventId && recallCalendarIds.size > 0) || !rowEmail;
      if (rowEmail && !matchesEmail) continue;

      const meetingUrl = row?.meetingUrl || s.meetingUrl || null;
      const scheduledStart = row?.startTime || anchor || null;
      addCandidate(
        {
          botId,
          title: String(row?.title || s.title || "Meeting").trim() || "Meeting",
          meetingUrl,
          scheduledStart,
          calendarUserEmail: rowEmail || normalizedEmail,
          googleEventId: row?.googleEventId,
          dedupeKey:
            meetingUrl && scheduledStart ? meetingDedupeKey(meetingUrl, scheduledStart) : undefined,
          source: "unified_scheduled",
          creationSource: row?.creationSource || s.creationSource,
          scheduledAt: row?.scheduledAt,
          botJoinAt: row?.botJoinAt,
        },
        "botsFromUnifiedState",
      );
    }
  } catch (e) {
    warnings.push(`Unified schedule state: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (recallCalendarIds.size > 0 && recallConfigured()) {
    const updatedAtGte = new Date(`${start}T00:00:00.000Z`).getTime() - 7 * 86400000;
    for (const calendarId of recallCalendarIds) {
      try {
        const events = await listAllRecallCalendarEvents({
          calendarId,
          updatedAtGte: new Date(updatedAtGte).toISOString(),
        });
        for (const event of events) {
          if (!inReportWindow(event.start_time, start, end, windowHours, floorMs)) continue;
          const botId = String(event.bots?.[0]?.bot_id || "").trim();
          if (!botId) continue;
          const meetingUrl = String(event.meeting_url || "").trim() || null;
          addCandidate(
            {
              botId,
              title: eventTitleFromRaw(event),
              meetingUrl,
              scheduledStart: event.start_time,
              calendarUserEmail: normalizedEmail,
              dedupeKey: meetingUrl ? meetingDedupeKey(meetingUrl, event.start_time) : undefined,
              source: "recall_calendar",
              creationSource: "recall_calendar_v2",
            },
            "botsFromRecallCalendar",
          );
        }
      } catch (e) {
        warnings.push(`Recall calendar ${calendarId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  try {
    const docs = await listAllBotIndexDocs();
    for (const doc of docs) {
      const botId = String(doc.botId || "").trim();
      if (!botId) continue;
      const anchor = String(doc.finalizedAt || doc.cronFinalizedAt || "").trim();
      const prefixDay = String(doc.prefix || "").split("_").slice(-2, -1)[0];
      const day = eventDay(anchor) || (/^\d{4}-\d{2}-\d{2}$/.test(prefixDay) ? prefixDay : null);
      const anchorIso = anchor || (day ? `${day}T12:00:00.000Z` : null);
      if (!inReportWindow(anchorIso, start, end, windowHours, floorMs)) continue;

      addCandidate(
        {
          botId,
          title: String(doc.title || "Meeting").trim() || "Meeting",
          meetingUrl: null,
          scheduledStart: null,
          calendarUserEmail: normalizedEmail,
          source: "s3_index",
        },
        "botsFromS3Index",
      );
    }
  } catch (e) {
    warnings.push(`S3 bot index: ${e instanceof Error ? e.message : String(e)}`);
  }

  const candidates = [...byBotId.values()].sort(
    (a, b) => Date.parse(b.scheduledStart || b.botJoinAt || "") - Date.parse(a.scheduledStart || a.botJoinAt || ""),
  );

  if (candidates.length === 0) {
    warnings.push(
      "No bots found in this date range. Schedule meetings from Unified Meetings, or widen the period (Last 60 days).",
    );
  }

  return {
    candidates,
    diagnostics: {
      botsFromNotetakerSessions,
      botsFromUnifiedState,
      botsFromS3Index,
      botsFromRecallCalendar,
      warnings,
    },
  };
}

async function listEligibleCalendarMeetings(
  calendarEmail: string,
  start: string,
  end: string,
  windowHours?: number,
  floorMs?: number,
): Promise<CalendarMeetingRef[]> {
  const timeMin = windowHours
    ? new Date(floorMs ?? Date.now() - windowHours * 3600_000).toISOString()
    : `${start}T00:00:00.000Z`;
  const timeMax = windowHours ? new Date().toISOString() : `${end}T23:59:59.999Z`;
  const events = await listCalendarEventsForUser(calendarEmail, timeMin, timeMax);
  const out: CalendarMeetingRef[] = [];

  for (const event of events) {
    const startTime = String(event?.start?.dateTime || "");
    if (!inReportWindow(startTime, start, end, windowHours, floorMs)) continue;
    const meetingUrl = getMeetingUrl(event);
    if (historicalSkipReason(event, meetingUrl)) continue;
    if (!meetingUrl) continue;

    out.push({
      googleEventId: String(event?.id || ""),
      title: String(event?.summary || "Untitled meeting").trim() || "Untitled meeting",
      startTime,
      endTime: event?.end?.dateTime ? String(event.end.dateTime) : null,
      meetingUrl,
      dedupeKey: meetingDedupeKey(meetingUrl, startTime),
    });
  }

  out.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  return out;
}

function findBotForMeeting(
  meeting: CalendarMeetingRef,
  rows: BotJoinReportRow[],
): BotJoinReportRow | undefined {
  const keys = new Set(dedupeKeysForMeeting(meeting.meetingUrl, meeting.startTime));
  const byKey = rows.find((r) => {
    if (!r.meetingUrl || !r.scheduledStart) return false;
    return keys.has(meetingDedupeKey(r.meetingUrl, r.scheduledStart)) ||
      keys.has(meetingDedupeKeyRaw(r.meetingUrl, r.scheduledStart));
  });
  if (byKey) return byKey;

  const startMs = Date.parse(meeting.startTime);
  return rows.find((r) => {
    if (!r.meetingUrl || r.meetingUrl !== meeting.meetingUrl || !r.scheduledStart) return false;
    const delta = Math.abs(Date.parse(r.scheduledStart) - startMs);
    return delta <= 60_000;
  });
}

export async function buildBotJoinReport(args: {
  start: string;
  end: string;
  calendarEmail?: string;
  forceRefresh?: boolean;
  windowHours?: number;
}): Promise<BotJoinReport> {
  const calendarEmail = (args.calendarEmail || DEFAULT_BOT_JOIN_REPORT_EMAIL).trim().toLowerCase();
  const windowHours = args.windowHours;
  const rolling = windowHours ? rollingWindowBounds(windowHours) : null;
  const cacheKey = reportCacheKey(calendarEmail, args.start, args.end, windowHours);
  if (!args.forceRefresh) {
    const hit = reportCache.get(cacheKey);
    if (hit && Date.now() - hit.at < REPORT_CACHE_TTL_MS) {
      return hit.report;
    }
  }

  const { candidates, diagnostics } = await collectBotCandidates(
    calendarEmail,
    args.start,
    args.end,
    windowHours,
    rolling?.floorMs,
  );

  let calendarAvailable = false;
  let calendarError: string | undefined;
  let eligibleMeetings: CalendarMeetingRef[] = [];

  if (dwdConfigured()) {
    try {
      env("GOOGLE_WORKSPACE_ADMIN_SUBJECT_EMAIL");
      eligibleMeetings = await listEligibleCalendarMeetings(
        calendarEmail,
        args.start,
        args.end,
        windowHours,
        rolling?.floorMs,
      );
      calendarAvailable = true;
    } catch (e) {
      calendarError = e instanceof Error ? e.message : String(e);
    }
  } else {
    calendarError = "Google DWD credentials not configured";
  }

  const recallOk = recallConfigured();
  const joinAtAfter = rolling?.windowStart ?? `${args.start}T00:00:00.000Z`;
  const joinAtBefore = rolling?.windowEnd ?? `${args.end}T23:59:59.999Z`;
  const lifecycleResult = recallOk
    ? await fetchRecallBotLifecycles(candidates.map((c) => c.botId), {
        joinAtAfter,
        joinAtBefore,
      })
    : { lifecycles: new Map(), skippedIndividualFetch: 0, fromListApi: 0, fromCache: 0 };
  const lifecycles = lifecycleResult.lifecycles;

  if (lifecycleResult.skippedIndividualFetch > 0) {
    diagnostics.warnings.push(
      `${lifecycleResult.skippedIndividualFetch} bot(s) skipped individual Recall fetch (rate-limit protection). Cached/list: ${lifecycleResult.fromCache + lifecycleResult.fromListApi}. Retry in ~10 min.`,
    );
  }
  diagnostics.recallBotsFromListApi = lifecycleResult.fromListApi;
  diagnostics.recallBotsFromCache = lifecycleResult.fromCache;
  diagnostics.recallBotsSkippedFetch = lifecycleResult.skippedIndividualFetch;

  const rows: BotJoinReportRow[] = candidates.map((c) => {
    const life = lifecycles.get(c.botId);
    const joinedMeeting = Boolean(life?.joinedMeeting);
    const stuckInWaitingRoom = Boolean(life?.stuckInWaitingRoom);
    const finalStatus = life?.finalStatusCode ?? (recallOk ? "no_data" : "recall_not_configured");
    const admittedAt = life?.admittedAt ?? null;
    const joiningCallAt = life?.joiningCallAt ?? null;
    const botJoinAt = c.botJoinAt || life?.joinAt;

    const { meetingStartAt, reliable } = resolveMeetingStartForCandidate({
      meetingUrl: c.meetingUrl || life?.meetingUrl || null,
      scheduledStart: c.scheduledStart,
      source: c.source,
      botJoinAt,
      admittedAt,
      joiningCallAt,
      eligibleMeetings,
    });

    const timing = computeAdmissionTiming({
      meetingStartAt,
      meetingStartReliable: reliable,
      admittedAt,
      joiningCallAt,
      joinedMeeting,
    });

    return {
      botId: c.botId,
      title: c.title,
      meetingUrl: c.meetingUrl || life?.meetingUrl || null,
      scheduledStart: meetingStartAt || c.scheduledStart,
      meetingStartAt: timing.meetingStartAt,
      meetingStartReliable: timing.meetingStartReliable,
      calendarUserEmail: c.calendarUserEmail,
      googleEventId: c.googleEventId,
      source: c.source,
      creationSource: c.creationSource,
      scheduledAt: c.scheduledAt,
      botJoinAt,
      joiningCallAt,
      waitingRoomEnteredAt: life?.waitingRoomEnteredAt ?? null,
      admittedAt,
      waitingRoomSeconds: life?.waitingRoomSeconds ?? null,
      waitingRoomLabel: formatWaitingRoom(life?.waitingRoomSeconds ?? null),
      lateToStartSeconds: timing.lateToStartSeconds,
      lateToStartLabel: timing.lateToStartLabel,
      lateMinutes: timing.lateMinutes,
      finalStatus,
      joinedMeeting,
      stuckInWaitingRoom,
      fatalSubCode: life?.fatalSubCode ?? null,
      recallFetchError: life?.fetchError,
    };
  });

  const joinedMeetings: BotJoinReportRow[] = [];
  const missedMeetings: CalendarMeetingRef[] = [];
  const joinedDedupeKeys = new Set<string>();

  if (calendarAvailable) {
    for (const meeting of eligibleMeetings) {
      const bot = findBotForMeeting(meeting, rows);
      if (bot?.joinedMeeting) {
        const enriched = applyAdmissionTimingToRow(
          {
            ...bot,
            title: meeting.title,
            meetingUrl: meeting.meetingUrl,
            googleEventId: meeting.googleEventId,
            scheduledStart: meeting.startTime,
            meetingStartAt: meeting.startTime,
            meetingStartReliable: true,
          },
          eligibleMeetings,
        );
        joinedMeetings.push(enriched);
        joinedDedupeKeys.add(meeting.dedupeKey);
      } else {
        missedMeetings.push(meeting);
      }
    }
  }

  const joinedFromBots = rows.filter((r) => r.joinedMeeting);
  for (const row of joinedFromBots) {
    if (!row.meetingUrl || !row.scheduledStart) {
      joinedMeetings.push(applyAdmissionTimingToRow(row, eligibleMeetings));
      continue;
    }
    const key = meetingDedupeKey(row.meetingUrl, row.scheduledStart);
    if (!joinedDedupeKeys.has(key)) {
      joinedMeetings.push(applyAdmissionTimingToRow(row, eligibleMeetings));
      joinedDedupeKeys.add(key);
    }
  }

  joinedMeetings.sort(
    (a, b) => Date.parse(b.scheduledStart || "") - Date.parse(a.scheduledStart || ""),
  );

  const meetingsJoined = calendarAvailable ? joinedMeetings.length : joinedFromBots.length;
  const totalEligibleMeetings = calendarAvailable ? eligibleMeetings.length : rows.length;
  const meetingsMissed = calendarAvailable ? missedMeetings.length : Math.max(0, rows.length - joinedFromBots.length);

  const lateMinutesList = joinedMeetings
    .map((r) => r.lateMinutes)
    .filter((n): n is number => n != null && Number.isFinite(n));
  const lateSecondsList = joinedMeetings
    .map((r) => r.lateToStartSeconds)
    .filter((n): n is number => n != null && n > LATE_GRACE_SECONDS);

  const critical: BotJoinCriticalMetrics = {
    totalEligibleMeetings,
    meetingsJoined,
    meetingsMissed,
    joinRatePercent:
      totalEligibleMeetings > 0
        ? Math.round((meetingsJoined / totalEligibleMeetings) * 1000) / 10
        : null,
    avgLateMinutes:
      lateMinutesList.length > 0
        ? Math.round((lateMinutesList.reduce((a, b) => a + b, 0) / lateMinutesList.length) * 10) / 10
        : null,
    maxLateMinutes:
      lateMinutesList.length > 0 ? Math.max(...lateMinutesList) : null,
    meetingsJoinedLate: lateSecondsList.length,
    stuckInWaitingRoom: rows.filter((r) => r.stuckInWaitingRoom).length,
    failedJoins: rows.filter((r) => r.finalStatus === "fatal").length,
    scheduledNotJoined: rows.filter((r) => !r.joinedMeeting && !r.stuckInWaitingRoom && r.finalStatus !== "fatal").length,
  };

  const daily = buildDailySeries({
    start: args.start,
    end: args.end,
    eligibleMeetings,
    joinedMeetings,
    missedMeetings,
  });

  const report: BotJoinReport = {
    range: {
      start: args.start,
      end: args.end,
      ...(windowHours
        ? {
            windowHours,
            windowStart: rolling!.windowStart,
            windowEnd: rolling!.windowEnd,
          }
        : {}),
    },
    calendarEmail,
    generatedAt: new Date().toISOString(),
    recallConfigured: recallOk,
    calendarAvailable,
    calendarError,
    diagnostics,
    critical,
    joinedMeetings,
    missedMeetings,
    daily,
    rows,
  };

  reportCache.set(cacheKey, { at: Date.now(), report });
  return report;
}
