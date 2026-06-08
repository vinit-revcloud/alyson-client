import rosterCsv from "@/data/org-chart-roster.csv?raw";

export type OrgChartRosterEntry = {
  name: string;
  email: string;
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

const OFFICIAL_EMAIL_DOMAIN = "cintara.ai";
const LEGACY_EMAIL_DOMAIN = "revcloud.com";

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

/** Legacy roster local-parts → current Cintara mailbox. */
const EMAIL_LOCAL_ALIASES: Record<string, string> = {
  omeraffan: "omer",
  atifali: "atif",
  bill: "alysonclient",
  awais: "owais",
  aneela: "anila",
  bilal: "ahmadbilal",
  "abdullah.saleem": "abdullahsaleem",
  saleem: "abdullahsaleem",
  "abdul.hanan": "abdulhanan",
  hanan: "abdulhanan",
  "abdullah.waseem": "abdullahwaseem",
  "tehreem.riaz": "tehreem",
  shumail: "shumailzehra",
  "shumail.zehra": "shumailzehra",
  ahmadfarooq: "ahmad.farooq",
  hashimfarooq: "ahmad.farooq",
  hashim: "ahmad.farooq",
  "adil.ahmed": "adil",
  adilahmed: "adil",
  "farhan.tariq": "farhan",
  "aryan.sawant": "aryan",
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

/** Map legacy @revcloud.com roster/Time Doctor emails to @cintara.ai. */
export function canonicalOfficialEmail(email: string): string {
  const e = normEmail(email);
  if (!e.includes("@")) return e;
  const [local, domain] = e.split("@");
  if (!local || !domain) return e;
  const canonicalLocal = EMAIL_LOCAL_ALIASES[local] ?? local;
  if (domain === LEGACY_EMAIL_DOMAIN || canonicalLocal !== local) {
    return `${canonicalLocal}@${OFFICIAL_EMAIL_DOMAIN}`;
  }
  return e;
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
    const officialEmail = String(cols[idx["Official Email"] ?? 3] ?? "").trim();
    if (!isValidOfficialEmail(officialEmail)) continue;
    entries.push({
      name: name || officialEmail.split("@")[0] || officialEmail,
      email: canonicalOfficialEmail(officialEmail),
      team: String(cols[idx["Team"] ?? 4] ?? "").trim(),
      managerLabel: String(cols[idx["Manager"] ?? 5] ?? "").trim(),
    });
  }

  if (!entries.some((e) => e.email === "alysonclient@cintara.ai")) {
    entries.unshift({
      name: "Bill",
      email: "alysonclient@cintara.ai",
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

function findRosterEntry(email: string, lookup: OrgChartRosterLookup): OrgChartRosterEntry | null {
  const e = canonicalOfficialEmail(email);
  if (!e) return null;
  const direct = lookup.byEmail.get(e);
  if (direct) return direct;
  const local = emailLocal(e);
  return lookup.byLocalPart.get(local) ?? null;
}

function findRosterEntryByName(name: string, lookup: OrgChartRosterLookup): OrgChartRosterEntry | null {
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

let cachedLookup: OrgChartRosterLookup | null = null;

export function getOrgChartRosterLookup(): OrgChartRosterLookup {
  if (!cachedLookup) {
    cachedLookup = buildOrgChartRosterLookup(parseOrgChartRosterCsv(rosterCsv));
  }
  return cachedLookup;
}

export function attachManagerToPacingRow<T extends { email: string; name?: string }>(
  row: T,
  lookup?: OrgChartRosterLookup,
): T & OrgChartManagerInfo {
  const l = lookup ?? getOrgChartRosterLookup();
  let mgr = resolveManagerForEmployeeEmail(row.email, l);
  if (!mgr.managerEmail && row.name) {
    const entry = findRosterEntryByName(row.name, l);
    if (entry?.managerLabel) {
      mgr = resolveManagersFromLabel(entry.managerLabel, l);
    }
  }
  return { ...row, ...mgr };
}
