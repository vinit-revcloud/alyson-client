import { canonicalOfficialEmail, emailLookupKeys } from "@/lib/cintara-email";

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

function emailLocal(email: string) {
  const e = norm(email).toLowerCase();
  const at = e.indexOf("@");
  return at > 0 ? e.slice(0, at) : e;
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

function matchActiveByName(name: string, entries: CintaraDomainEntry[]): boolean {
  const nn = normPersonName(name);
  if (!nn) return false;
  if (entries.some((e) => normPersonName(`${e.firstName} ${e.lastName}`) === nn)) return true;

  return entries.some((e) => {
    const cName = normPersonName(`${e.firstName} ${e.lastName}`);
    if (!cName) return false;
    if (nn.includes(cName) || cName.includes(nn)) return true;
    const parts = cName.split(" ").filter(Boolean);
    return parts.length >= 2 && parts.every((p) => nn.includes(p));
  });
}

export function isCintaraActiveMember(
  lookup: CintaraActiveMemberLookup,
  args: { email?: string; name?: string },
): boolean {
  const email = norm(args.email ?? "").toLowerCase();
  if (email && email !== "no email found") {
    for (const key of emailLookupKeys(email)) {
      if (key.includes("@") && lookup.byEmail.has(key)) return true;
      if (!key.includes("@") && lookup.byLocalPart.has(key)) return true;
    }
    const canonical = canonicalOfficialEmail(email);
    if (lookup.byEmail.has(canonical) || lookup.byLocalPart.has(emailLocal(canonical))) {
      return true;
    }
  }

  return matchActiveByName(args.name ?? "", lookup.entries);
}

export function formatActiveLabel(active: boolean): "Yes" | "No" {
  return active ? "Yes" : "No";
}
