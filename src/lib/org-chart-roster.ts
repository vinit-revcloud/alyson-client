import { canonicalOfficialEmail } from "@/lib/cintara-email";

export { canonicalOfficialEmail } from "@/lib/cintara-email";

export type OrgChartRosterEntry = {
  name: string;
  email: string;
  personalEmail?: string;
  location: string;
  team: string;
  managerLabel: string;
};

export type OrgChartManagerInfo = {
  managerName: string | null;
  managerEmail: string | null;
};

export type OrgChartRosterLookup = {
  byEmail: Map<string, OrgChartRosterEntry>;
  byLocalPart: Map<string, OrgChartRosterEntry>;
  byNormalizedName: Map<string, OrgChartRosterEntry>;
  emailByNormalizedName: Map<string, string>;
};

const MANAGER_EMAIL_SHORTCUTS: Record<string, string> = {
  bill: "alysonclient@cintara.ai",
  omer: "omer@cintara.ai",
  zaman: "zaman@cintara.ai",
  mohita: "mohita@cintara.ai",
  arman: "arman@cintara.ai",
  atif: "atif@cintara.ai",
  "atif ali": "atif@cintara.ai",
  sabtain: "sabtain@cintara.ai",
  kumail: "kumail@cintara.ai",
};

/** Hard-coded manager labels when roster email/name matching is ambiguous. */
const EMPLOYEE_MANAGER_OVERRIDES: Record<string, string> = {
  owais: "Mohita",
  awais: "Mohita",
  anila: "Mohita",
  aneela: "Mohita",
  prashansa: "Mohita",
  saif: "Arman",
  sahil: "Arman",
  aryaman: "Arman",
  ahmadbilal: "Bill",
  bilal: "Bill",
  abdulhanan: "Omer",
  hanan: "Omer",
  tehreem: "Omer",
  "ahmad.farooq": "Omer",
  ahmadfarooq: "Omer",
  hashimfarooq: "Omer",
  hashim: "Omer",
  abdullahwaseem: "Omer",
  abdullahsaleem: "Omer",
  saleem: "Omer",
  shumailzehra: "Omer",
  shumail: "Omer",
  vinit: "Omer",
  adil: "Bill",
  adilahmed: "Bill",
  aryan: "Omer",
  farhan: "Bill",
};

function norm(s: string) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normEmail(email: string) {
  return String(email || "").trim().toLowerCase();
}

/** True when two roster display names likely refer to the same person. */
function rosterNamesLikelySame(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const aFirst = na.split(" ")[0] ?? "";
  const bFirst = nb.split(" ")[0] ?? "";
  if (!aFirst || aFirst !== bFirst) return false;
  const aRest = na.split(" ").slice(1).join(" ");
  const bRest = nb.split(" ").slice(1).join(" ");
  return Boolean(aRest && bRest && (aRest.includes(bRest) || bRest.includes(aRest)));
}

function emailLocal(email: string) {
  const e = normEmail(email);
  const at = e.indexOf("@");
  return at > 0 ? e.slice(0, at) : e;
}

function isValidOfficialEmail(email: string) {
  const e = normEmail(email);
  return Boolean(e && e.includes("@") && e !== "no email found");
}

/** Parse org chart CSV (Name, Location, Email ID, Official Email, Team, Manager). */
export function parseOrgChartRosterCsv(csv: string): OrgChartRosterEntry[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0]!.split(",").map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const entries: OrgChartRosterEntry[] = [];

  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const name = String(cols[idx["Name"] ?? 0] ?? "").trim();
    const personalEmail = normEmail(String(cols[idx["Email ID"] ?? 2] ?? ""));
    const officialEmail = String(cols[idx["Official Email"] ?? 3] ?? "").trim();
    if (!isValidOfficialEmail(officialEmail)) continue;
    entries.push({
      name: name || officialEmail.split("@")[0] || officialEmail,
      email: canonicalOfficialEmail(officialEmail),
      personalEmail: personalEmail.includes("@") ? personalEmail : undefined,
      location: String(cols[idx["Location"] ?? 1] ?? "").trim(),
      team: String(cols[idx["Team"] ?? 4] ?? "").trim(),
      managerLabel: String(cols[idx["Manager"] ?? 5] ?? "").trim(),
    });
  }

  if (!entries.some((e) => e.email === "alysonclient@cintara.ai")) {
    entries.unshift({
      name: "Bill",
      email: "alysonclient@cintara.ai",
      location: "",
      team: "Leadership",
      managerLabel: "",
    });
  }

  return entries;
}

export function buildOrgChartRosterLookup(entries: OrgChartRosterEntry[]): OrgChartRosterLookup {
  const byEmail = new Map<string, OrgChartRosterEntry>();
  const byLocalPart = new Map<string, OrgChartRosterEntry>();
  const byNormalizedName = new Map<string, OrgChartRosterEntry>();
  const emailByNormalizedName = new Map<string, string>();

  for (const e of entries) {
    byEmail.set(e.email, e);
    const local = emailLocal(e.email);
    if (local) byLocalPart.set(local, e);
    if (e.personalEmail) {
      byEmail.set(e.personalEmail, e);
      const personalLocal = emailLocal(e.personalEmail);
      if (personalLocal) byLocalPart.set(personalLocal, e);
    }
    const nn = norm(e.name);
    if (nn) {
      byNormalizedName.set(nn, e);
      emailByNormalizedName.set(nn, e.email);
    }
  }

  return { byEmail, byLocalPart, byNormalizedName, emailByNormalizedName };
}

function resolveManagerPart(part: string, lookup: OrgChartRosterLookup): OrgChartManagerInfo | null {
  const raw = String(part || "").trim();
  if (!raw) return null;

  const key = norm(raw);
  const shortcutEmail = MANAGER_EMAIL_SHORTCUTS[key];
  if (shortcutEmail) {
    const entry = lookup.byEmail.get(shortcutEmail);
    return { managerName: entry?.name || raw, managerEmail: shortcutEmail };
  }

  const byName = lookup.byNormalizedName.get(key);
  if (byName) return { managerName: byName.name, managerEmail: byName.email };

  const first = key.split(" ")[0] ?? "";
  if (first && MANAGER_EMAIL_SHORTCUTS[first]) {
    const email = MANAGER_EMAIL_SHORTCUTS[first]!;
    const entry = lookup.byEmail.get(email);
    return { managerName: entry?.name || raw, managerEmail: email };
  }

  const candidates = [...lookup.byNormalizedName.entries()].filter(
    ([nn]) => nn === key || nn.startsWith(`${key} `) || nn.split(" ").includes(first),
  );
  if (candidates.length === 1) {
    const entry = candidates[0]![1];
    return { managerName: entry.name, managerEmail: entry.email };
  }

  return { managerName: raw, managerEmail: null };
}

function splitManagerLabel(label: string): string[] {
  return String(label || "")
    .split(/\s*(?:\/|&|,|\band\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function resolveManagersFromLabel(
  managerLabel: string,
  lookup: OrgChartRosterLookup,
): OrgChartManagerInfo {
  const parts = splitManagerLabel(managerLabel);
  if (!parts.length) return { managerName: null, managerEmail: null };

  const resolved = parts
    .map((p) => resolveManagerPart(p, lookup))
    .filter((r): r is OrgChartManagerInfo => Boolean(r?.managerName));

  if (!resolved.length) {
    return { managerName: managerLabel.trim() || null, managerEmail: null };
  }

  const emails = [...new Set(resolved.map((r) => r.managerEmail).filter(Boolean))] as string[];
  return {
    managerName: managerLabel.trim() || resolved.map((r) => r.managerName).join(" / "),
    managerEmail: emails[0] ?? null,
  };
}

export function findRosterEntry(email: string, lookup: OrgChartRosterLookup): OrgChartRosterEntry | null {
  const raw = normEmail(email);
  if (raw) {
    const byRaw = lookup.byEmail.get(raw);
    if (byRaw) return byRaw;
    const rawLocal = emailLocal(raw);
    const byRawLocal = rawLocal ? lookup.byLocalPart.get(rawLocal) : undefined;
    if (byRawLocal) return byRawLocal;
  }

  const e = canonicalOfficialEmail(email);
  if (!e) return null;
  const direct = lookup.byEmail.get(e);
  if (direct) return direct;
  const local = emailLocal(e);
  return lookup.byLocalPart.get(local) ?? null;
}

export function findRosterEntryByName(name: string, lookup: OrgChartRosterLookup): OrgChartRosterEntry | null {
  const key = norm(name);
  if (!key) return null;

  const direct = lookup.byNormalizedName.get(key);
  if (direct) return direct;

  const tokens = key.split(" ").filter((t) => t.length > 2);
  if (!tokens.length) return null;

  const candidates = [...lookup.byNormalizedName.entries()].filter(([nn]) =>
    tokens.every((t) => nn.includes(t)),
  );
  if (candidates.length === 1) return candidates[0]![1];
  return null;
}

export function resolveManagerForEmployeeEmail(
  email: string,
  lookup: OrgChartRosterLookup,
): OrgChartManagerInfo {
  const local = emailLocal(canonicalOfficialEmail(email));
  const overrideLabel = local ? EMPLOYEE_MANAGER_OVERRIDES[local] : undefined;
  if (overrideLabel) return resolveManagersFromLabel(overrideLabel, lookup);

  const entry = findRosterEntry(email, lookup);
  if (!entry?.managerLabel) return { managerName: null, managerEmail: null };
  return resolveManagersFromLabel(entry.managerLabel, lookup);
}

/** Resolve org roster row from Time Doctor email and/or display name. */
export function findRosterEntryForEmployee(
  email: string,
  name: string,
  lookup: OrgChartRosterLookup,
): OrgChartRosterEntry | null {
  const trimmedName = String(name || "").trim();
  const byName = trimmedName ? findRosterEntryByName(trimmedName, lookup) : null;
  const byEmail = findRosterEntry(email, lookup);

  if (byName && byEmail && !rosterNamesLikelySame(byName.name, byEmail.name)) {
    return byName;
  }

  return byEmail ?? byName;
}

export type OrgChartPacingFields = OrgChartManagerInfo & {
  location: string | null;
  team: string | null;
};

export function attachManagerToPacingRow<T extends { email: string; name?: string }>(
  row: T,
  lookup: OrgChartRosterLookup,
): T & OrgChartPacingFields {
  let mgr = resolveManagerForEmployeeEmail(row.email, lookup);
  const rosterEntry = findRosterEntryForEmployee(row.email, row.name ?? "", lookup);
  if (!mgr.managerEmail && row.name) {
    if (rosterEntry?.managerLabel) {
      mgr = resolveManagersFromLabel(rosterEntry.managerLabel, lookup);
    }
  }
  const empCanon = normEmail(canonicalOfficialEmail(row.email));
  if (mgr.managerEmail && normEmail(mgr.managerEmail) === empCanon) {
    mgr = resolveManagersFromLabel("Bill", lookup);
  }
  return {
    ...row,
    ...mgr,
    location: rosterEntry?.location?.trim() || null,
    team: rosterEntry?.team?.trim() || null,
  };
}

/** Merge onboarding / org-chart supplemental rows by official email. */
export function mergeOrgChartRosterEntries(
  primary: OrgChartRosterEntry[],
  supplemental: OrgChartRosterEntry[],
): OrgChartRosterEntry[] {
  const byEmail = new Map(primary.map((e) => [e.email, { ...e }]));
  for (const row of supplemental) {
    if (!row.email) continue;
    const existing = byEmail.get(row.email);
    if (existing) {
      if (!rosterNamesLikelySame(existing.name, row.name)) {
        // Legacy email aliases can map two people to one mailbox — keep both rows.
        const personalKey = normEmail(row.personalEmail || "");
        if (personalKey.includes("@")) byEmail.set(personalKey, row);
        continue;
      }
      if (row.location) existing.location = row.location;
      if (row.team) existing.team = row.team;
      if (row.managerLabel) existing.managerLabel = row.managerLabel;
      if (row.name) existing.name = existing.name || row.name;
      if (row.personalEmail) existing.personalEmail = existing.personalEmail || row.personalEmail;
    } else {
      byEmail.set(row.email, row);
    }
  }
  return [...byEmail.values()];
}
