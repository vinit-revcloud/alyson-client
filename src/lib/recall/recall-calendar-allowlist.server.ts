const DEFAULT_ALLOWED = [
  "alysonclient@cintara.ai",
  "mohita@cintara.ai",
  "arman@cintara.ai",
  "aditya@cintara.ai",
  "notetaker@cintara.ai",
  "thirumalai@cintara.ai",
  "vinit@cintara.ai",
];

function normalizeEmail(email: string): string {
  return String(email || "")
    .trim()
    .toLowerCase();
}

/**
 * Calendars for these accounts get Recall auto-scheduling (webhooks + cron Sync).
 * Primary operators: alysonclient, mohita, arman, aditya.
 * Bots still use timed 48h retention (cost save) via Recall-direct create.
 */
export function getRecallCalendarAllowlist(): string[] {
  const defaults = DEFAULT_ALLOWED.map(normalizeEmail);
  const raw = process.env.RECALL_CALENDAR_AUTO_SCHEDULE_EMAILS?.trim();
  if (!raw) return defaults;
  const fromEnv = raw
    .split(/[,;\s]+/)
    .map(normalizeEmail)
    .filter(Boolean);
  // Env extends (not replaces) defaults so new in-code emails work without a Vercel env edit.
  return [...new Set([...defaults, ...fromEnv])];
}

export function isRecallCalendarEmailAllowed(email: string | null | undefined): boolean {
  const normalized = normalizeEmail(email || "");
  if (!normalized) return false;
  return getRecallCalendarAllowlist().includes(normalized);
}

export function assertRecallCalendarEmailAllowed(email: string | null | undefined): void {
  if (isRecallCalendarEmailAllowed(email)) return;
  throw new Error(
    `Auto-schedule is only enabled for: ${getRecallCalendarAllowlist().join(", ")} (got ${email || "unknown"})`,
  );
}

export function recallCalendarAllowlistLabel(): string {
  return getRecallCalendarAllowlist().join(", ");
}

/**
 * Email domains whose users may Connect Google Calendar and get Alyson auto-attached to every meeting.
 * Connecting is the opt-in, so this is broader than the DWD allowlist above.
 * Env RECALL_CALENDAR_CONNECT_DOMAINS (comma list, or "*" for any account). Defaults to
 * GOOGLE_WORKSPACE_DOMAIN so outside Gmail accounts can't run up Recall usage.
 */
export function calendarConnectAllowedDomains(): string[] | "*" {
  const raw = process.env.RECALL_CALENDAR_CONNECT_DOMAINS?.trim();
  if (raw === "*") return "*";
  const list = (raw || process.env.GOOGLE_WORKSPACE_DOMAIN || "")
    .split(/[,;\s]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  return list;
}

/** True when this account may connect its calendar (explicit allowlist OR an allowed domain). */
export function isCalendarConnectEmailAllowed(email: string | null | undefined): boolean {
  const normalized = normalizeEmail(email || "");
  if (!normalized || !normalized.includes("@")) return false;
  if (isRecallCalendarEmailAllowed(normalized)) return true;
  const domains = calendarConnectAllowedDomains();
  if (domains === "*") return true;
  const domain = normalized.split("@")[1] || "";
  return domains.includes(domain);
}

export function assertCalendarConnectEmailAllowed(email: string | null | undefined): void {
  if (isCalendarConnectEmailAllowed(email)) return;
  const domains = calendarConnectAllowedDomains();
  const allowed = domains === "*" ? "any account" : domains.length ? domains.map((d) => `@${d}`).join(", ") : recallCalendarAllowlistLabel();
  throw new Error(`Calendar connect is limited to ${allowed} (got ${email || "unknown account"})`);
}
