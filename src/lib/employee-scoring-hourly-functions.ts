import { createServerFn } from "@tanstack/react-start";
import { google } from "googleapis";
import { JWT } from "google-auth-library";
import { format } from "date-fns";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { enumerateDays } from "@/lib/time-dashboard-range";
import { fetchTimeDoctorEmployeesTable, fetchUserWorkSegments } from "@/lib/time-doctor-functions";

const IST = "Asia/Kolkata";
const MAX_HOURLY_RANGE_DAYS = 14;

const Input = z.object({
  userEmail: z.string().min(3),
  start: z.string().datetime(),
  end: z.string().datetime(),
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

export type EmployeeHourlyActivityResponse = {
  userEmail: string;
  displayName: string;
  range: { start: string; end: string };
  timeDoctorRange: { start: string; end: string };
  rows: HourlyActivityRow[];
  warnings: string[];
};

const SCOPES = [
  "https://www.googleapis.com/auth/admin.reports.audit.readonly",
];
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";

type Slot = {
  dayIso: string;
  hour: number;
  workSeconds: number;
  poorSeconds: number;
  meetings: number;
  chat: number;
  emails: number;
  docs: number;
};

function env(name: string) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name}`);
  return v;
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
  if (!privateKey) throw new Error("Missing Google service account private_key");
  return new JWT({ email: clientEmail, key: privateKey, scopes, subject });
}

function istSlotKey(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    hour12: false,
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return `${y}-${m}-${day}|${hour}`;
}

function parseSlotKey(key: string): { dayIso: string; hour: number } {
  const [dayIso, h] = key.split("|");
  return { dayIso: dayIso!, hour: Number(h) || 0 };
}

function formatDayUs(dayIso: string) {
  const [y, m, d] = dayIso.split("-");
  return `${Number(m)}/${Number(d)}/${y}`;
}

function emptySlot(): Slot {
  return {
    dayIso: "",
    hour: 0,
    workSeconds: 0,
    poorSeconds: 0,
    meetings: 0,
    chat: 0,
    emails: 0,
    docs: 0,
  };
}

function getSlot(map: Map<string, Slot>, key: string) {
  let slot = map.get(key);
  if (!slot) {
    const { dayIso, hour } = parseSlotKey(key);
    slot = { ...emptySlot(), dayIso, hour };
    map.set(key, slot);
  }
  return slot;
}

function addSecondsToHour(iso: string | undefined, seconds: number, map: Map<string, Slot>, field: "workSeconds" | "poorSeconds") {
  if (!iso || seconds <= 0) return;
  const start = new Date(iso);
  if (!Number.isFinite(start.getTime())) return;
  const slot = getSlot(map, istSlotKey(start));
  slot[field] += seconds;
}

function extractNestedParameterMap(event: unknown) {
  const ev = event as { parameters?: Array<Record<string, unknown>> };
  const data: Record<string, string> = {};
  for (const parameter of ev?.parameters ?? []) {
    const name = String(parameter?.name || "");
    const direct = parameter?.value ?? parameter?.intValue ?? parameter?.boolValue;
    if (name && direct != null) data[name] = String(direct);
    if (name === "event_info" || name === "message_info") {
      const nested = (parameter?.messageValue as { parameter?: Array<Record<string, unknown>> })?.parameter ?? [];
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

function estimateWords(slot: Slot) {
  const activeMin = Math.round(slot.workSeconds / 60);
  return (
    slot.emails * 45 +
    slot.chat * 30 +
    slot.docs * 120 +
    slot.meetings * 80 +
    activeMin * 3
  );
}

function slotToRow(slot: Slot): HourlyActivityRow {
  const activeMinutes = Math.round(slot.workSeconds / 60);
  const inactiveMinutes = Math.round(slot.poorSeconds / 60);
  const timeDoctorMinutes = activeMinutes + inactiveMinutes;
  const working = activeMinutes > 0 ? "Yes" : "No";
  const hoursCredit = activeMinutes >= 30 ? 1 : 0;
  return {
    day: formatDayUs(slot.dayIso),
    hour: slot.hour,
    timeDoctorMinutes,
    activeMinutes,
    inactiveMinutes,
    meetingsAttended: slot.meetings,
    chatMessages: slot.chat,
    emails: slot.emails,
    docsCreated: slot.docs,
    wordsTypedOrSpoken: estimateWords(slot),
    working,
    hoursCredit,
  };
}

async function bucketWorkspaceEvents(args: {
  userEmail: string;
  startTime: string;
  endTime: string;
  map: Map<string, Slot>;
  warnings: string[];
}) {
  const email = args.userEmail.trim().toLowerCase();
  const adminSubject = env("GOOGLE_WORKSPACE_ADMIN_SUBJECT_EMAIL");
  const auth = await loadServiceAccountJwtForSubject(adminSubject, SCOPES);
  const reports = google.admin({ version: "reports_v1", auth });

  const auditApps: Array<{
    app: "gmail" | "chat" | "drive";
    event: string;
    field: "emails" | "chat" | "docs";
    filter?: (meta: Record<string, string>) => boolean;
  }> = [
    {
      app: "gmail",
      event: "delivery",
      field: "emails",
      filter: (meta) => String(meta.flattened_destinations || "").toLowerCase().includes("smtp-outbound"),
    },
    { app: "chat", event: "message_posted", field: "chat" },
    {
      app: "drive",
      event: "create",
      field: "docs",
      filter: (meta) => {
        const docType = String(meta.doc_type || meta.docType || "").toLowerCase();
        const itemType = String(meta.item_type || meta.itemType || "").toLowerCase();
        const mimeType = String(meta.mime_type || meta.mimeType || "").toLowerCase();
        return (
          docType.includes("document") ||
          docType.includes("docs") ||
          itemType.includes("document") ||
          mimeType.includes("application/vnd.google-apps.document")
        );
      },
    },
  ];

  for (const spec of auditApps) {
    let pageToken: string | undefined;
    try {
      do {
        const resp = await reports.activities.list({
          userKey: "all",
          applicationName: spec.app,
          eventName: spec.event,
          startTime: args.startTime,
          endTime: args.endTime,
          maxResults: 1000,
          pageToken,
        });
        for (const item of resp.data.items ?? []) {
          const actor = String(item.actor?.email || "").trim().toLowerCase();
          if (actor !== email) continue;
          const when = item.id?.time;
          if (!when) continue;
          const d = new Date(when);
          if (!Number.isFinite(d.getTime())) continue;
          for (const event of item.events ?? []) {
            if (String(event.name || "") !== spec.event) continue;
            const meta = extractNestedParameterMap(event);
            if (spec.filter && !spec.filter(meta)) continue;
            const slot = getSlot(args.map, istSlotKey(d));
            slot[spec.field] += 1;
          }
        }
        pageToken = resp.data.nextPageToken || undefined;
      } while (pageToken);
    } catch (e) {
      args.warnings.push(`${spec.app} ${spec.event}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function bucketCalendarMeetings(args: {
  userEmail: string;
  startTime: string;
  endTime: string;
  map: Map<string, Slot>;
  warnings: string[];
}) {
  const email = args.userEmail.trim().toLowerCase();
  try {
    const auth = await loadServiceAccountJwtForSubject(email, [CALENDAR_SCOPE]);
    const calendar = google.calendar({ version: "v3", auth });
    let pageToken: string | undefined;
    const events: Array<{ start: Date; end: Date }> = [];
    do {
      const r = await calendar.events.list({
        calendarId: "primary",
        timeMin: args.startTime,
        timeMax: args.endTime,
        singleEvents: true,
        showDeleted: false,
        pageToken,
        maxResults: 250,
        fields: "items(status,start/dateTime,start/date,end/dateTime,end/date),nextPageToken",
      });
      for (const e of r.data.items ?? []) {
        if (String(e?.status || "").toLowerCase() === "cancelled") continue;
        const startRaw = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00` : null);
        const endRaw = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T23:59:59` : null);
        if (!startRaw) continue;
        const start = new Date(startRaw);
        const end = endRaw ? new Date(endRaw) : new Date(start.getTime() + 60 * 60 * 1000);
        if (!Number.isFinite(start.getTime())) continue;
        events.push({ start, end });
      }
      pageToken = r.data.nextPageToken || undefined;
    } while (pageToken);

    for (const ev of events) {
      const slot = getSlot(args.map, istSlotKey(ev.start));
      slot.meetings += 1;
    }
  } catch (e) {
    args.warnings.push(`calendar: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function isoToDate(iso: string) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) throw new Error("Invalid datetime");
  return format(d, "yyyy-MM-dd");
}

export const getEmployeeHourlyActivity = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }): Promise<EmployeeHourlyActivityResponse> => {
    const email = data.userEmail.trim().toLowerCase();
    const startIso = data.start;
    const endIso = data.end;
    if (new Date(startIso).getTime() >= new Date(endIso).getTime()) {
      throw new Error("Start time must be earlier than end time.");
    }

    const tdStart = isoToDate(startIso);
    const tdEnd = isoToDate(endIso);
    const dayCount = enumerateDays(tdStart, tdEnd).length;
    const warnings: string[] = [];
    if (dayCount > MAX_HOURLY_RANGE_DAYS) {
      warnings.push(`Hourly grid limited to ${MAX_HOURLY_RANGE_DAYS} days; narrow the scoring window for full detail.`);
    }

    const tdTable = await fetchTimeDoctorEmployeesTable({ data: { start: tdStart, end: tdEnd } });
    const emp = (tdTable.employees ?? []).find((e) => e.email.trim().toLowerCase() === email);
    const displayName = emp?.name?.trim() || email;

    const map = new Map<string, Slot>();

    if (emp?.id) {
      try {
        const segments = await fetchUserWorkSegments({
          data: { userId: emp.id, start: tdStart, end: tdEnd },
        });
        for (const w of segments.work ?? []) {
          addSecondsToHour(w.startedAt, w.totalSeconds, map, "workSeconds");
        }
        for (const p of segments.poor ?? []) {
          addSecondsToHour(p.startedAt, p.totalSeconds, map, "poorSeconds");
        }
      } catch (e) {
        warnings.push(`time_doctor: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      warnings.push(`time_doctor: no user found for ${email}`);
    }

    await Promise.all([
      bucketWorkspaceEvents({ userEmail: email, startTime: startIso, endTime: endIso, map, warnings }),
      bucketCalendarMeetings({ userEmail: email, startTime: startIso, endTime: endIso, map, warnings }),
    ]);

    const rows = Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, slot]) => slotToRow(slot))
      .filter(
        (r) =>
          r.timeDoctorMinutes > 0 ||
          r.meetingsAttended > 0 ||
          r.chatMessages > 0 ||
          r.emails > 0 ||
          r.docsCreated > 0,
      );

    return {
      userEmail: email,
      displayName,
      range: { start: startIso, end: endIso },
      timeDoctorRange: { start: tdStart, end: tdEnd },
      rows,
      warnings: warnings.slice(0, 12),
    };
  });
