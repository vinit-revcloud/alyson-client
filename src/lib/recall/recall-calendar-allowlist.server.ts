const DEFAULT_ALLOWED = ["alysonclient@cintara.ai", "mohita@cintara.ai", "thirumalai@cintara.ai"];

function normalizeEmail(email: string): string {
  return String(email || "")
    .trim()
    .toLowerCase();
}

/** Calendars for these accounts get Recall auto-scheduling; all others are ignored. */
export function getRecallCalendarAllowlist(): string[] {
  const raw = process.env.RECALL_CALENDAR_AUTO_SCHEDULE_EMAILS?.trim();
  if (raw) {
    return raw
      .split(/[,;\s]+/)
      .map(normalizeEmail)
      .filter(Boolean);
  }
  return DEFAULT_ALLOWED.map(normalizeEmail);
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
