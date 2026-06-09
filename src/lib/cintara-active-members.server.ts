import {
  buildCintaraActiveMemberLookup,
  parseCintaraDomainCsv,
  type CintaraActiveMemberLookup,
} from "@/lib/cintara-active-members";
import { BUNDLED_CINTARA_DOMAIN_EMAILS_CSV } from "@/lib/bundled-data";

let cachedLookup: CintaraActiveMemberLookup | null = null;

export function getCintaraActiveMemberLookup(): CintaraActiveMemberLookup {
  if (cachedLookup) return cachedLookup;
  cachedLookup = buildCintaraActiveMemberLookup(parseCintaraDomainCsv(BUNDLED_CINTARA_DOMAIN_EMAILS_CSV));
  return cachedLookup;
}
