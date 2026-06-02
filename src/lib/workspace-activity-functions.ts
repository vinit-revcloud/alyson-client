import { createServerFn } from "@tanstack/react-start";
import { google } from "googleapis";
import { JWT } from "google-auth-library";
import { promises as fs } from "node:fs";
import { z } from "zod";

const SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.reports.audit.readonly",
];
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";

const Input = z
  .object({
    start: z.string().datetime().optional(),
    end: z.string().datetime().optional(),
  })
  .optional();

export type WorkspaceActivityRow = {
  userEmail: string;
  emailsSent: number;
  meetingsCreated: number;
  docsCreated: number;
  chatMessagesSent: number;
};

export type WorkspaceActivityResponse = {
  range: { start: string; end: string };
  generatedAt: string;
  usersProcessed: number;
  rows: WorkspaceActivityRow[];
  warnings: string[];
};

const CACHE_TTL_MS = 90_000;
const activityCache = new Map<string, { at: number; data: WorkspaceActivityResponse }>();

function env(name: string) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function isoZ(dt: Date) {
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function normalizeEventIso(input: string | undefined, fallback: Date) {
  if (!input) return isoZ(fallback);
  const d = new Date(input);
  if (!Number.isFinite(d.getTime())) return isoZ(fallback);
  return isoZ(d);
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

async function buildDirectoryAndReportsClients() {
  const adminSubject = env("GOOGLE_WORKSPACE_ADMIN_SUBJECT_EMAIL");
  const auth = await loadServiceAccountJwtForSubject(adminSubject, SCOPES);
  return {
    directory: google.admin({ version: "directory_v1", auth }),
    reports: google.admin({ version: "reports_v1", auth }),
  };
}

async function countCalendarMeetingsForUser(email: string, startTime: string, endTime: string): Promise<number> {
  const auth = await loadServiceAccountJwtForSubject(email, [CALENDAR_SCOPE]);
  const calendar = google.calendar({ version: "v3", auth });
  let count = 0;
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
      // Reduce payload size for faster list calls.
      fields: "items(status,start/date,start/dateTime),nextPageToken",
    });
    for (const e of r.data.items ?? []) {
      if (String(e?.status || "").toLowerCase() === "cancelled") continue;
      if (e?.start?.dateTime || e?.start?.date) count += 1;
    }
    pageToken = r.data.nextPageToken || undefined;
  } while (pageToken);
  return count;
}

async function listAllUsers(directoryService: ReturnType<typeof google.admin>) {
  const users: string[] = [];
  let pageToken: string | undefined;
  do {
    const resp = await directoryService.users.list({
      customer: "my_customer",
      maxResults: 500,
      orderBy: "email",
      pageToken,
    });
    for (const u of resp.data.users ?? []) {
      const email = String(u.primaryEmail || "").trim().toLowerCase();
      if (email) users.push(email);
    }
    pageToken = resp.data.nextPageToken || undefined;
  } while (pageToken);
  return users;
}

function extractNestedParameterMap(event: any) {
  const data: Record<string, string> = {};
  for (const parameter of event?.parameters ?? []) {
    const name = String(parameter?.name || "");
    // Keep top-level parameter values too; Drive audit often reports doc_type here.
    const direct = parameter?.value ?? parameter?.intValue ?? parameter?.boolValue;
    if (name && direct != null) {
      data[name] = String(direct);
    }

    if (name === "event_info" || name === "message_info") {
      const nested = parameter?.messageValue?.parameter ?? [];
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

async function countAppEvents(args: {
  reports: ReturnType<typeof google.admin>;
  applicationName: "gmail" | "calendar" | "drive" | "chat";
  eventName: string;
  startTime: string;
  endTime: string;
  includeEvent?: (event: any, metadata: Record<string, string>) => boolean;
}) {
  const counts = new Map<string, number>();
  let pageToken: string | undefined;
  do {
    const resp = await args.reports.activities.list({
      userKey: "all",
      applicationName: args.applicationName,
      eventName: args.eventName,
      startTime: args.startTime,
      endTime: args.endTime,
      maxResults: 1000,
      pageToken,
    });

    for (const item of resp.data.items ?? []) {
      const actorEmail = String(item.actor?.email || "").trim().toLowerCase();
      if (!actorEmail) continue;
      for (const event of item.events ?? []) {
        if (String(event.name || "") !== args.eventName) continue;
        const meta = extractNestedParameterMap(event);
        if (args.includeEvent && !args.includeEvent(event, meta)) continue;
        counts.set(actorEmail, (counts.get(actorEmail) ?? 0) + 1);
      }
    }

    pageToken = resp.data.nextPageToken || undefined;
  } while (pageToken);
  return counts;
}

async function countCalendarMeetingsByUser(
  users: string[],
  startTime: string,
  endTime: string,
  warnings: string[],
) {
  const counts = new Map<string, number>();
  const concurrency = 16;
  let i = 0;

  async function worker() {
    while (i < users.length) {
      const idx = i++;
      const email = users[idx]!;
      try {
        counts.set(email, await countCalendarMeetingsForUser(email, startTime, endTime));
      } catch (e) {
        warnings.push(`calendar list(${email}): ${e instanceof Error ? e.message : String(e)}`);
        counts.set(email, 0);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, users.length) }, () => worker()));
  return counts;
}

export const getWorkspaceActivity = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }): Promise<WorkspaceActivityResponse> => {
    const now = new Date();
    const fallbackStart = new Date(now.getTime() - 23 * 60 * 60 * 1000);
    const startTime = normalizeEventIso(data?.start, fallbackStart);
    const endTime = normalizeEventIso(data?.end, now);

    if (new Date(startTime).getTime() >= new Date(endTime).getTime()) {
      throw new Error("Start time must be earlier than end time.");
    }

    const cacheKey = `${startTime}|${endTime}`;
    const cached = activityCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return {
        ...cached.data,
        warnings: [...cached.data.warnings, "served_from_cache"],
      };
    }

    const warnings: string[] = [];
    const { directory, reports } = await buildDirectoryAndReportsClients();

    const users = await listAllUsers(directory);
    const [emailCounts, meetingCounts, docsCounts, chatCounts] = await Promise.all([
      countAppEvents({
        reports,
        applicationName: "gmail",
        eventName: "delivery",
        startTime,
        endTime,
        includeEvent: (_event, metadata) =>
          String(metadata.flattened_destinations || "")
            .toLowerCase()
            .includes("smtp-outbound"),
      }).catch((e) => {
        warnings.push(`gmail delivery: ${e instanceof Error ? e.message : String(e)}`);
        return new Map<string, number>();
      }),
      countCalendarMeetingsByUser(users, startTime, endTime, warnings).catch((e) => {
        warnings.push(`calendar events(list): ${e instanceof Error ? e.message : String(e)}`);
        return new Map<string, number>();
      }),
      countAppEvents({
        reports,
        applicationName: "drive",
        eventName: "create",
        startTime,
        endTime,
        includeEvent: (_event, metadata) => {
          const docType = String(metadata.doc_type || metadata.docType || "").toLowerCase();
          const itemType = String(metadata.item_type || metadata.itemType || "").toLowerCase();
          const mimeType = String(metadata.mime_type || metadata.mimeType || "").toLowerCase();
          // Match common Google Docs values seen in Drive audit payloads.
          return (
            docType.includes("document") ||
            docType.includes("docs") ||
            itemType.includes("document") ||
            mimeType.includes("application/vnd.google-apps.document")
          );
        },
      }).catch((e) => {
        warnings.push(`drive create(doc_type=document): ${e instanceof Error ? e.message : String(e)}`);
        return new Map<string, number>();
      }),
      countAppEvents({
        reports,
        applicationName: "chat",
        eventName: "message_posted",
        startTime,
        endTime,
      }).catch((e) => {
        warnings.push(`chat message_posted: ${e instanceof Error ? e.message : String(e)}`);
        return new Map<string, number>();
      }),
    ]);

    const rows: WorkspaceActivityRow[] = users.map((email) => ({
      userEmail: email,
      emailsSent: emailCounts.get(email) ?? 0,
      meetingsCreated: meetingCounts.get(email) ?? 0,
      docsCreated: docsCounts.get(email) ?? 0,
      chatMessagesSent: chatCounts.get(email) ?? 0,
    }));
    rows.sort((a, b) => b.emailsSent - a.emailsSent || a.userEmail.localeCompare(b.userEmail));

    const result = {
      range: { start: startTime, end: endTime },
      generatedAt: new Date().toISOString(),
      usersProcessed: rows.length,
      rows,
      warnings,
    };
    activityCache.set(cacheKey, { at: Date.now(), data: result });
    return result;
  });
