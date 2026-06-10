import { canonicalOfficialEmail, emailLookupKeys } from "@/lib/cintara-email";
import {
  findRosterEntryForEmployee,
  type OrgChartRosterEntry,
  type OrgChartRosterLookup,
} from "@/lib/org-chart-roster";

export type CintaraDomainEntry = {
  firstName: string;
  lastName: string;
  email: string;
};

export type CintaraActiveMemberLookup = {
  byEmail: Set<string>;
  byLocalPart: Set<string>;
  byName: Set<string>;
  entries: CintaraDomainEntry[];
};

function norm(s: string) {
  return String(s ?? "").trim();
}

function normPersonName(name: string) {
  return norm(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameTokens(name: string): string[] {
  return normPersonName(name).split(" ").filter(Boolean);
}

/** Common roster vs workspace spelling variants for the same person. */
function nameTokenEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  if ((a === "fouad" && b === "fawad") || (a === "fawad" && b === "fouad")) return true;
  return false;
}

function allDomainNameTokensPresent(personName: string, domainName: string): boolean {
  const domainTokens = nameTokens(domainName);
  const personTokens = nameTokens(personName);
  if (domainTokens.length < 2 || !personTokens.length) return false;
  return domainTokens.every((dt) =>
    personTokens.some((pt) => nameTokenEquivalent(dt, pt)),
  );
}

function emailLocal(email: string) {
  const e = norm(email).toLowerCase();
  const at = e.indexOf("@");
  return at > 0 ? e.slice(0, at) : e;
}

/** Weekly pacing: force Active = No even when present on the Cintara domain list. */
const PACING_ACTIVE_NO_NAMES = new Set(
  [
    "Aaradhya Badal",
    "Hareem Farooq",
    "Hassan Ali",
    "Saba Imran",
    "Vyankatesh Pete",
    "Vyankatesh Dnyanoba Pete",
    "Swapnil Thorat",
    "Syed Muhammad Kumail",
    "Syed M Kumail",
  ].map(normPersonName),
);

const PACING_ACTIVE_NO_EMAILS = new Set(
  [
    "aaradhya@cintara.ai",
    "hareem@betterpeoplesupport.com",
    "hareem@cintara.ai",
    "hassan.ali@cintara.ai",
    "hassan@cintara.ai",
    "saba@cintara.ai",
    "vyankatesh@cintara.ai",
    "kumail@cintara.ai",
    "swapnil@cintara.ai",
  ].map((e) => e.toLowerCase()),
);

/** Sabtain Ashiq's sourcer team — only these show Active = Yes on weekly pacing. */
const PACING_SABTAIN_TEAM_ACTIVE_NAMES = new Set(
  [
    "Abdullah Raheem",
    "Arooj Fatima",
    "Iqra Rafique",
    "Mudassar Rafique",
    "Mudasir Rafique",
    "Muhammad Saqlain",
    "Sabtain Ashiq",
  ].map(normPersonName),
);

const PACING_SABTAIN_TEAM_ACTIVE_EMAILS = new Set(
  [
    "abdullah@cintara.ai",
    "arooj@cintara.ai",
    "iqra@cintara.ai",
    "mudassar@cintara.ai",
    "mudaser@cintara.ai",
    "muhammadsaqlain@cintara.ai",
    "saqlain@cintara.ai",
    "sabtain@cintara.ai",
  ].map((e) => e.toLowerCase()),
);

function managerIsSabtain(managerLabel: string): boolean {
  const m = normPersonName(managerLabel);
  return m === "sabtain" || m === "sabtain ashiq" || m.startsWith("sabtain ");
}

function isSabtainAshiqPerson(name: string): boolean {
  const n = normPersonName(name);
  return n === "sabtain ashiq" || (n.includes("sabtain") && n.includes("ashiq"));
}

function isSabtainTeamMember(
  rosterEntry: OrgChartRosterEntry | null,
  displayName: string,
): boolean {
  if (isSabtainAshiqPerson(displayName)) return true;
  if (rosterEntry && isSabtainAshiqPerson(rosterEntry.name)) return true;
  if (!rosterEntry) return false;
  return managerIsSabtain(rosterEntry.managerLabel);
}

function matchesSabtainTeamActiveAllowlist(args: { email?: string; name?: string }): boolean {
  const name = normPersonName(args.name ?? "");
  if (name) {
    if (PACING_SABTAIN_TEAM_ACTIVE_NAMES.has(name)) return true;
    for (const allowed of PACING_SABTAIN_TEAM_ACTIVE_NAMES) {
      if (name.includes(allowed) || allowed.includes(name)) return true;
    }
  }

  const email = norm(args.email ?? "").toLowerCase();
  if (email && PACING_SABTAIN_TEAM_ACTIVE_EMAILS.has(email)) return true;
  if (email) {
    const local = emailLocal(email);
    for (const allowed of PACING_SABTAIN_TEAM_ACTIVE_EMAILS) {
      if (emailLocal(allowed) === local) return true;
    }
  }

  return false;
}

function isHardcodedPacingInactive(args: { email?: string; name?: string }): boolean {
  const name = normPersonName(args.name ?? "");
  if (name) {
    if (PACING_ACTIVE_NO_NAMES.has(name)) return true;
    for (const blocked of PACING_ACTIVE_NO_NAMES) {
      if (name.includes(blocked) || blocked.includes(name)) return true;
    }
  }

  const email = norm(args.email ?? "").toLowerCase();
  if (email && PACING_ACTIVE_NO_EMAILS.has(email)) return true;
  if (email) {
    const local = emailLocal(email);
    for (const blocked of PACING_ACTIVE_NO_EMAILS) {
      if (emailLocal(blocked) === local) return true;
    }
  }

  return false;
}

export function parseCintaraDomainCsv(csv: string): CintaraDomainEntry[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0]!.split(",").map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const out: CintaraDomainEntry[] = [];

  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const firstName = norm(cols[idx["First Name [Required]"] ?? 0] ?? "");
    const lastName = norm(cols[idx["Last Name [Required]"] ?? 1] ?? "");
    const email = norm(cols[idx["Email Address [Required]"] ?? 2] ?? "").toLowerCase();
    if (!email) continue;
    out.push({ firstName, lastName, email });
  }

  return out;
}

export function buildCintaraActiveMemberLookup(entries: CintaraDomainEntry[]): CintaraActiveMemberLookup {
  const byEmail = new Set<string>();
  const byLocalPart = new Set<string>();
  const byName = new Set<string>();

  for (const e of entries) {
    byEmail.add(e.email);
    byLocalPart.add(emailLocal(e.email));
    const fullName = normPersonName(`${e.firstName} ${e.lastName}`);
    if (fullName) byName.add(fullName);
  }

  return { byEmail, byLocalPart, byName, entries };
}

export function matchActiveByName(name: string, entries: CintaraDomainEntry[]): boolean {
  const nn = normPersonName(name);
  if (!nn) return false;
  if (entries.some((e) => normPersonName(`${e.firstName} ${e.lastName}`) === nn)) return true;

  return entries.some((e) => {
    const cName = normPersonName(`${e.firstName} ${e.lastName}`);
    if (!cName) return false;
    if (nn.includes(cName) || cName.includes(nn)) return true;
    const parts = cName.split(" ").filter(Boolean);
    if (parts.length >= 2 && parts.every((p) => nn.includes(p))) return true;
    return allDomainNameTokensPresent(name, cName);
  });
}

function findDomainEntryByEmail(
  lookup: CintaraActiveMemberLookup,
  email: string,
): CintaraDomainEntry | undefined {
  for (const key of emailLookupKeys(email)) {
    if (key.includes("@")) {
      const entry = lookup.entries.find((e) => e.email === key);
      if (entry) return entry;
    } else if (lookup.byLocalPart.has(key)) {
      const entry = lookup.entries.find((e) => emailLocal(e.email) === key);
      if (entry) return entry;
    }
  }

  const canonical = canonicalOfficialEmail(email);
  return lookup.entries.find(
    (e) => e.email === canonical || emailLocal(e.email) === emailLocal(canonical),
  );
}

export function isCintaraActiveMember(
  lookup: CintaraActiveMemberLookup,
  args: { email?: string; name?: string },
): boolean {
  const name = norm(args.name ?? "");
  if (name && matchActiveByName(name, lookup.entries)) return true;

  const email = norm(args.email ?? "").toLowerCase();
  if (!email || email === "no email found") return false;

  const domainEntry = findDomainEntryByEmail(lookup, email);
  if (!domainEntry) return false;

  // Mailbox is on the domain — confirm identity when a name is available.
  if (!name) return true;
  return matchActiveByName(name, [domainEntry]);
}

/** Active flag for weekly pacing: match via Time Doctor identity and org roster official email. */
export function resolveCintaraActiveForPacing(
  activeLookup: CintaraActiveMemberLookup,
  rosterLookup: OrgChartRosterLookup,
  args: { email: string; name: string },
): boolean {
  const attempts: { email?: string; name?: string }[] = [
    { email: args.email, name: args.name },
  ];

  const rosterEntry = findRosterEntryForEmployee(args.email, args.name, rosterLookup);
  if (rosterEntry) {
    attempts.push({ email: rosterEntry.email, name: rosterEntry.name });
  }

  if (attempts.some((candidate) => isHardcodedPacingInactive(candidate))) return false;

  const displayName = rosterEntry?.name || args.name;
  if (isSabtainTeamMember(rosterEntry, displayName)) {
    return attempts.some((candidate) => matchesSabtainTeamActiveAllowlist(candidate));
  }

  return attempts.some((candidate) => isCintaraActiveMember(activeLookup, candidate));
}

export function formatActiveLabel(active: boolean): "Yes" | "No" {
  return active ? "Yes" : "No";
}
