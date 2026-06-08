import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCintaraActiveMemberLookup,
  parseCintaraDomainCsv,
  type CintaraActiveMemberLookup,
} from "@/lib/cintara-active-members";

let cachedLookup: CintaraActiveMemberLookup | null = null;

export function getCintaraActiveMemberLookup(): CintaraActiveMemberLookup {
  if (cachedLookup) return cachedLookup;
  const csvPath =
    process.env.CINTARA_DOMAIN_EMAILS_CSV?.trim() ||
    join(dirname(fileURLToPath(import.meta.url)), "../data/cintara-domain-emails.csv");
  const csv = readFileSync(csvPath, "utf8");
  cachedLookup = buildCintaraActiveMemberLookup(parseCintaraDomainCsv(csv));
  return cachedLookup;
}
