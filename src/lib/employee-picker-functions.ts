import { createServerFn } from "@tanstack/react-start";
import { google } from "googleapis";
import { JWT } from "google-auth-library";
import { promises as fs } from "node:fs";
import { listTimeDoctorUsersLight } from "@/lib/time-doctor-functions";

const DIRECTORY_SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";

export type EmployeePickerEntry = {
  email: string;
  name: string;
};

export type EmployeePickerResponse = {
  employees: EmployeePickerEntry[];
  warnings: string[];
};

const CACHE_TTL_MS = 5 * 60_000;
let cache: { at: number; data: EmployeePickerResponse } | null = null;

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
  if (!privateKey) throw new Error("Missing service account private_key");
  return new JWT({ email: clientEmail, key: privateKey, scopes, subject });
}

async function listGoogleWorkspaceUsers(): Promise<EmployeePickerEntry[]> {
  const adminSubject = env("GOOGLE_WORKSPACE_ADMIN_SUBJECT_EMAIL");
  const auth = await loadServiceAccountJwtForSubject(adminSubject, [DIRECTORY_SCOPE]);
  const directory = google.admin({ version: "directory_v1", auth });
  const out: EmployeePickerEntry[] = [];
  let pageToken: string | undefined;

  do {
    const resp = await directory.users.list({
      customer: "my_customer",
      maxResults: 500,
      orderBy: "email",
      pageToken,
      projection: "full",
    });
    for (const u of resp.data.users ?? []) {
      const email = String(u.primaryEmail || "").trim().toLowerCase();
      if (!email) continue;
      const name =
        u.name?.fullName?.trim() ||
        [u.name?.givenName, u.name?.familyName].filter(Boolean).join(" ").trim() ||
        email.split("@")[0] ||
        email;
      out.push({ email, name });
    }
    pageToken = resp.data.nextPageToken || undefined;
  } while (pageToken);

  return out;
}

export const getEmployeePickerDirectory = createServerFn({ method: "GET" }).handler(
  async (): Promise<EmployeePickerResponse> => {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return cache.data;
    }

    const warnings: string[] = [];
    const byEmail = new Map<string, EmployeePickerEntry>();

    const [googleR, tdR] = await Promise.allSettled([
      listGoogleWorkspaceUsers(),
      listTimeDoctorUsersLight(),
    ]);

    if (googleR.status === "fulfilled") {
      for (const e of googleR.value) {
        byEmail.set(e.email, e);
      }
    } else {
      warnings.push(`google_directory: ${String(googleR.reason)}`);
    }

    if (tdR.status === "fulfilled") {
      for (const u of tdR.value) {
        const email = u.email.trim().toLowerCase();
        if (!email) continue;
        const existing = byEmail.get(email);
        const name = u.name?.trim() || existing?.name || email.split("@")[0] || email;
        byEmail.set(email, { email, name });
      }
    } else {
      warnings.push(`time_doctor: ${String(tdR.reason)}`);
    }

    const employees = Array.from(byEmail.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

    const result = { employees, warnings: warnings.slice(0, 4) };
    cache = { at: Date.now(), data: result };
    return result;
  },
);
