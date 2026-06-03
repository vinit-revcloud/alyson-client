import { createServerFn } from "@tanstack/react-start";
import { format } from "date-fns";
import { google } from "googleapis";
import { JWT } from "google-auth-library";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { fetchTimeDoctorEmployeesTable, fetchUserWorklogEntriesForRange } from "@/lib/time-doctor-functions";

const SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.reports.audit.readonly",
];
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const IST = "Asia/Kolkata";
const MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

const Input = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
  userEmail: z.string().email(),
});

export type HourlyActivityRow = {
  day: string;
  hour: number;
  timeDoctorMinutes: number;
  activeMinutes: number;
  inactiveMinutes: number;
  meetingsAttended: number;
  chatMessages: number;
  emails: number;
  docsCreated: number;
  wordsTypedOrSpoken: number;
  working: "Yes" | "No";
  hoursCredit: number;
};

export type HourlyActivityResponse = {
  range: { start: string; end: string };
  userEmail: string;
  displayName: string;
  generatedAt: string;
  rows: HourlyActivityRow[];
  warnings: string[];
};

function env(name: string) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function isoZ(dt: Date) {
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function loadServiceAccountJwtForSubject(subject: string, scopes: string[]) {
  let parsed: { client_email?: string; private_key?: string } | null = null;
  const inlineJson = process.env.GOOGLE_DWD_SERVICE_ACCOUNT_JSON?.trim();
  if (inlineJson) {
    parsed = JSON.parse(inlineJson) as { client_email?: string; private_key?: string };
  } else {
    const credentialsPath = env("GOOGLE_APPLICATION_CREDENTIALS");
    const txt = await fs.readFile(credentialsPath, "utf8");
    parsed = JSON.parse(txt) as { client_email?: string; private_key?: string };
  }
  const clientEmail = parsed.client_email || env("GOOGLE_DWD_SERVICE_ACCOUNT_EMAIL");
  const privateKey = parsed.private_key;
  if (!privateKey) throw new Error("Missing service account private_key");
  return new JWT({ email: clientEmail, key: privateKey, scopes, subject });
}

function extractNestedParameterMap(event: { parameters?: unknown[] }) {
  const data: Record<string, string> = {};
  for (const parameter of (event.parameters ?? []) as Array<Record<string, unknown>>) {
    const name = String(parameter?.name || "");
    const direct = parameter?.value ?? parameter?.intValue ?? parameter?.boolValue;
    if (name && direct != null) data[name] = String(direct);
    if (name === "event_info" || name === "message_info") {
      const nested = (parameter.messageValue as { parameter?: Array<Record<string, unknown>> })?.parameter ?? [];
      for (const entry of nested) {
        const key = String(entry?.name || "").trim();
        if (!key) continue;
        const raw = entry?.value ?? entry?.intValue ?? entry?.boolValue;
        if (raw == null) continue;
        data[key] = String(raw);
      }
    }
  }
  return data;
}

type BucketKey = string;

function istBucketKey(isoTime: string): BucketKey | null {
  const d = new Date(isoTime);
  if (!Number.isFinite(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    hour12: false,
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  const hour = parts.find((p) => p.type === "hour")?.value;
  if (!y || !m || !day || hour == null) return null;
  return `${y}-${m}-${day}|${Number(hour)}`;
}

function parseBucket(key: BucketKey): { dayIso: string; hour: number } {
  const [dayIso, hourStr] = key.split("|");
  return { dayIso: dayIso!, hour: Number(hourStr) };
}

/** Display day like spreadsheet: M/D/YYYY */
function formatDayUs(dayIso: string) {
  const [y, m, d] = dayIso.split("-");
  return `${Number(m)}/${Number(d)}/${y}`;
}

function estimateWords(args: {
  activeMinutes: number;
  emails: number;
  chat: number;
  docs: number;
  meetings: number;
}) {
  return (
    args.emails * 45 +
    args.chat * 30 +
    args.docs * 120 +
    args.meetings * 80 +
    args.activeMinutes * 3
  );
}

function addSecondsToBucket(map: Map<BucketKey, number>, isoTime: string | undefined, seconds: number) {
  if (!isoTime || seconds <= 0) return;
  const key = istBucketKey(isoTime);
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + seconds);
}

function incrementBucket(map: Map<BucketKey, number>, isoTime: string) {
  const key = istBucketKey(isoTime);
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

async function listUserTimedAuditCounts(args: {
  reports: ReturnType<typeof google.admin>;
  userEmail: string;
  applicationName: "gmail" | "drive" | "chat";
  eventName: string;
  startTime: string;
  endTime: string;
  includeEvent?: (metadata: Record<string, string>) => boolean;
}) {
  const counts = new Map<BucketKey, number>();
  let pageToken: string | undefined;
  do {
    const resp = await args.reports.activities().list({
      userKey: args.userEmail,
      applicationName: args.applicationName,
      eventName: args.eventName,
      startTime: args.startTime,
      endTime: args.endTime,
      maxResults: 1000,
      pageToken,
    });
    for (const item of resp.data.items ?? []) {
      const time = String((item.id as { time?: string })?.time ?? "");
      if (!time) continue;
      for (const event of item.events ?? []) {
        if (String(event.name || "") !== args.eventName) continue;
        const meta = extractNestedParameterMap(event as { parameters?: unknown[] });
        if (args.includeEvent && !args.includeEvent(meta)) continue;
        incrementBucket(counts, time);
      }
    }
    pageToken = resp.data.nextPageToken || undefined;
  } while (pageToken);
  return counts;
}

async function calendarMeetingsByHour(
  userEmail: string,
  startTime: string,
  endTime: string,
  warnings: string[],
) {
  const counts = new Map<BucketKey, number>();
  try {
    const auth = await loadServiceAccountJwtForSubject(userEmail, [CALENDAR_SCOPE]);
    const calendar = google.calendar({ version: "v3", auth });
    let pageToken: string | undefined;
    do {
      const r = await calendar.events.list({
        calendarId: "primary",
        timeMin: startTime,
        timeMax: endTime,
        singleEvents: true,
        orderBy: "startTime",
        showDeleted: false,
        pageToken,
        maxResults: 250,
        fields: "items(status,start/date,start/dateTime),nextPageToken",
      });
      for (const e of r.data.items ?? []) {
        if (String(e?.status || "").toLowerCase() === "cancelled") continue;
        const start = e?.start?.dateTime ?? (e?.start?.date ? `${e.start.date}T00:00:00Z` : null);
        if (!start) continue;
        incrementBucket(counts, start);
      }
      pageToken = r.data.nextPageToken || undefined;
    } while (pageToken);
  } catch (e) {
    warnings.push(`calendar: ${e instanceof Error ? e.message : String(e)}`);
  }
  return counts;
}

export const getHourlyActivityReport = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }): Promise<HourlyActivityResponse> => {
    const startMs = new Date(data.start).getTime();
    const endMs = new Date(data.end).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      throw new Error("Start time must be earlier than end time.");
    }
    if (endMs - startMs > MAX_RANGE_MS) {
      throw new Error("Hourly report supports up to 7 days per request.");
    }

    const startTime = isoZ(new Date(data.start));
    const endTime = isoZ(new Date(data.end));
    const userEmail = data.userEmail.trim().toLowerCase();
    const warnings: string[] = [];

    const tdStart = format(new Date(data.start), "yyyy-MM-dd");
    const tdEnd = format(new Date(data.end), "yyyy-MM-dd");

    const tdTable = await fetchTimeDoctorEmployeesTable({ data: { start: tdStart, end: tdEnd } }).catch(
      (e) => {
        warnings.push(`time_doctor: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      },
    );

    const tdUser = tdTable?.employees?.find((e) => e.email.trim().toLowerCase() === userEmail);
    const displayName = tdUser?.name?.trim() || userEmail.split("@")[0] || userEmail;

    const activeSecondsByHour = new Map<BucketKey, number>();
    const poorSecondsByHour = new Map<BucketKey, number>();

    if (tdUser?.id) {
      const segments = await fetchUserWorklogEntriesForRange({
        data: { userId: tdUser.id, start: tdStart, end: tdEnd },
      }).catch((e) => {
        warnings.push(`worklogs: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      if (segments) {
        for (const w of segments.worklogs) {
          addSecondsToBucket(activeSecondsByHour, w.startedAt, w.totalSeconds);
        }
        for (const p of segments.poorTime) {
          addSecondsToBucket(poorSecondsByHour, p.startedAt, p.totalSeconds);
        }
      }
    } else {
      warnings.push(`No Time Doctor user matched ${userEmail}`);
    }

    const adminSubject = env("GOOGLE_WORKSPACE_ADMIN_SUBJECT_EMAIL");
    const auth = await loadServiceAccountJwtForSubject(adminSubject, SCOPES);
    const reports = google.admin({ version: "reports_v1", auth });

    const [emailCounts, docsCounts, chatCounts, meetingCounts] = await Promise.all([
      listUserTimedAuditCounts({
        reports,
        userEmail,
        applicationName: "gmail",
        eventName: "delivery",
        startTime,
        endTime,
        includeEvent: (meta) =>
          String(meta.flattened_destinations || "")
            .toLowerCase()
            .includes("smtp-outbound"),
      }).catch((e) => {
        warnings.push(`gmail: ${e instanceof Error ? e.message : String(e)}`);
        return new Map<BucketKey, number>();
      }),
      listUserTimedAuditCounts({
        reports,
        userEmail,
        applicationName: "drive",
        eventName: "create",
        startTime,
        endTime,
        includeEvent: (meta) => {
          const docType = String(meta.doc_type || "").toLowerCase();
          const mimeType = String(meta.mime_type || "").toLowerCase();
          return docType.includes("document") || mimeType.includes("application/vnd.google-apps.document");
        },
      }).catch((e) => {
        warnings.push(`drive: ${e instanceof Error ? e.message : String(e)}`);
        return new Map<BucketKey, number>();
      }),
      listUserTimedAuditCounts({
        reports,
        userEmail,
        applicationName: "chat",
        eventName: "message_posted",
        startTime,
        endTime,
      }).catch((e) => {
        warnings.push(`chat: ${e instanceof Error ? e.message : String(e)}`);
        return new Map<BucketKey, number>();
      }),
      calendarMeetingsByHour(userEmail, startTime, endTime, warnings),
    ]);

    const activityKeys = new Set<BucketKey>([
      ...activeSecondsByHour.keys(),
      ...poorSecondsByHour.keys(),
      ...emailCounts.keys(),
      ...docsCounts.keys(),
      ...chatCounts.keys(),
      ...meetingCounts.keys(),
    ]);

    const rows: HourlyActivityRow[] = Array.from(activityKeys)
      .sort((a, b) => {
        const pa = parseBucket(a);
        const pb = parseBucket(b);
        return pa.dayIso.localeCompare(pb.dayIso) || pa.hour - pb.hour;
      })
      .map((key) => {
        const { dayIso, hour } = parseBucket(key);
        const activeMinutes = Math.min(60, Math.round((activeSecondsByHour.get(key) ?? 0) / 60));
        const inactiveMinutes = Math.min(60, Math.round((poorSecondsByHour.get(key) ?? 0) / 60));
        const timeDoctorMinutes = Math.min(60, activeMinutes + inactiveMinutes);
        const meetings = meetingCounts.get(key) ?? 0;
        const chat = chatCounts.get(key) ?? 0;
        const emails = emailCounts.get(key) ?? 0;
        const docs = docsCounts.get(key) ?? 0;
        const working: "Yes" | "No" = activeMinutes > 0 ? "Yes" : "No";
        const hoursCredit = activeMinutes >= 30 ? 1 : 0;

        return {
          day: formatDayUs(dayIso),
          hour,
          timeDoctorMinutes,
          activeMinutes,
          inactiveMinutes,
          meetingsAttended: meetings,
          chatMessages: chat,
          emails,
          docsCreated: docs,
          wordsTypedOrSpoken: estimateWords({ activeMinutes, emails, chat, docs, meetings }),
          working,
          hoursCredit,
        };
      });

    return {
      range: { start: startTime, end: endTime },
      userEmail,
      displayName,
      generatedAt: new Date().toISOString(),
      rows,
      warnings,
    };
  });
