import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import {
  buildCintaraActiveMemberLookup,
  formatActiveLabel,
  isCintaraActiveMember,
  parseCintaraDomainCsv,
} from "@/lib/cintara-active-members";
import { canonicalOfficialEmail } from "@/lib/cintara-email";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const rosterPath = join(root, "src/data/org-chart-roster.csv");
const defaultDomainCsv = join(root, "src/data/cintara-domain-emails.csv");
const outDir = join(root, "exports");

function norm(s: string) {
  return String(s ?? "").trim();
}

function slug(s: string) {
  return norm(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
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

function isValidOfficialEmail(email: string) {
  const e = norm(email).toLowerCase();
  return Boolean(e && e.includes("@") && e !== "no email found");
}

function buildCintaraEmailLookup(entries: ReturnType<typeof parseCintaraDomainCsv>) {
  const byEmail = new Map<string, string>();
  const byLocalPart = new Map<string, string>();

  for (const e of entries) {
    byEmail.set(e.email, e.email);
    byLocalPart.set(emailLocal(e.email), e.email);
  }

  return { byEmail, byLocalPart, entries };
}

function matchCintaraEmailByName(name: string, entries: ReturnType<typeof parseCintaraDomainCsv>) {
  const nn = normPersonName(name);
  if (!nn) return null;

  for (const e of entries) {
    const cName = normPersonName(`${e.firstName} ${e.lastName}`);
    if (!cName) continue;
    if (nn === cName || nn.includes(cName) || cName.includes(nn)) return e.email;

    const parts = cName.split(" ").filter(Boolean);
    if (parts.length >= 2 && parts.every((p) => nn.includes(p))) return e.email;
  }

  return null;
}

function resolveOfficialEmail(args: {
  rosterEmail: string;
  name: string;
  cintara: ReturnType<typeof buildCintaraEmailLookup>;
}) {
  const fromName = matchCintaraEmailByName(args.name, args.cintara.entries);
  if (fromName) return fromName;

  const rosterEmail = norm(args.rosterEmail);
  if (isValidOfficialEmail(rosterEmail)) {
    const canonical = canonicalOfficialEmail(rosterEmail);
    const local = emailLocal(canonical);
    const fromCintara =
      args.cintara.byEmail.get(canonical.toLowerCase()) ?? args.cintara.byLocalPart.get(local);
    if (fromCintara) return fromCintara;
    return canonical;
  }

  return rosterEmail;
}

function parseOrgRosterCsv(csv: string) {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0]!.split(",").map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  return lines.slice(1).map((line, i) => {
    const cols = line.split(",");
    const name = norm(cols[idx["Name"] ?? 0] ?? "") || `Employee ${i + 1}`;
    const location = norm(cols[idx["Location"] ?? 1] ?? "");
    const personalEmail = norm(cols[idx["Email ID"] ?? 2] ?? "");
    const officialEmailRaw = norm(cols[idx["Official Email"] ?? 3] ?? "");
    const team = norm(cols[idx["Team"] ?? 4] ?? "") || "General";
    const manager = norm(cols[idx["Manager"] ?? 5] ?? "");

    return { name, location, personalEmail, officialEmailRaw, team, manager };
  });
}

function main() {
  const domainCsvPath = process.env.CINTARA_DOMAIN_EMAILS_CSV?.trim() || defaultDomainCsv;
  if (!existsSync(domainCsvPath)) {
    throw new Error(`Cintara domain CSV not found: ${domainCsvPath}`);
  }

  const rosterCsv = readFileSync(rosterPath, "utf8");
  const domainCsv = readFileSync(domainCsvPath, "utf8");
  const cintaraEntries = parseCintaraDomainCsv(domainCsv);
  const cintara = buildCintaraEmailLookup(cintaraEntries);
  const activeLookup = buildCintaraActiveMemberLookup(cintaraEntries);

  const rows = parseOrgRosterCsv(rosterCsv).map((r, i) => {
    const officialEmail = resolveOfficialEmail({
      rosterEmail: r.officialEmailRaw,
      name: r.name,
      cintara,
    });
    const emailForId =
      isValidOfficialEmail(officialEmail) ? officialEmail : `user${i + 1}@cintara.ai`;
    const active = isCintaraActiveMember(activeLookup, { email: officialEmail, name: r.name });

    return {
      "Employee ID": `cint_${slug(emailForId || r.name)}_${String(i + 1).padStart(3, "0")}`,
      Name: r.name,
      Location: r.location,
      "Personal Email": r.personalEmail,
      "Official Email": officialEmail,
      Team: r.team,
      Manager: r.manager,
      Active: formatActiveLabel(active),
    };
  });

  const hasBill = rows.some((r) => norm(r.Name).toLowerCase() === "bill");
  if (!hasBill) {
    rows.unshift({
      "Employee ID": "cint_exec_bill",
      Name: "Bill",
      Location: "",
      "Personal Email": "",
      "Official Email": "alysonclient@cintara.ai",
      Team: "Leadership",
      Manager: "",
      Active: formatActiveLabel(
        isCintaraActiveMember(activeLookup, {
          email: "alysonclient@cintara.ai",
          name: "Bill",
        }),
      ),
    });
  }

  mkdirSync(outDir, { recursive: true });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Org Roster");

  const xlsxPath = join(outDir, "alyson-org-roster.xlsx");
  const csvPath = join(outDir, "alyson-org-roster.csv");

  XLSX.writeFile(wb, xlsxPath);
  writeFileSync(csvPath, XLSX.utils.sheet_to_csv(ws), "utf8");

  const activeCounts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.Active] = (acc[r.Active] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`Wrote ${xlsxPath}`);
  console.log(`Wrote ${csvPath}`);
  console.log(`rows=${rows.length}`);
  console.log("Active breakdown:", activeCounts);
}

main();
