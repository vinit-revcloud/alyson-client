const OFFICIAL_EMAIL_DOMAIN = "cintara.ai";
const LEGACY_EMAIL_DOMAIN = "revcloud.com";

/** Map legacy roster local-parts → current Cintara mailbox. */
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
  ahsanzafar: "ahsan",
  "hassan.ali": "hassan",
  shumailzehra: "shumail",
};

const EMAIL_LOCAL_ALIASES_REVERSE = Object.fromEntries(
  Object.entries(EMAIL_LOCAL_ALIASES)
    .filter(([from, to]) => from !== to)
    .map(([from, to]) => [to, from]),
);

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

export function emailLocalPart(email: string): string {
  const e = normEmail(email);
  const at = e.indexOf("@");
  return at > 0 ? e.slice(0, at) : e;
}

/** Expand roster / Time Doctor emails for cross-system lookups. */
export function emailLookupKeys(email: string): string[] {
  const canonical = canonicalOfficialEmail(email);
  const raw = normEmail(email);
  const keys = new Set<string>();
  if (raw) keys.add(raw);
  if (canonical) keys.add(canonical);
  const rawLocal = emailLocalPart(raw);
  const canonicalLocal = emailLocalPart(canonical);
  if (rawLocal) keys.add(rawLocal);
  if (canonicalLocal) keys.add(canonicalLocal);
  const reverse = EMAIL_LOCAL_ALIASES_REVERSE[canonicalLocal];
  if (reverse) keys.add(reverse);
  const forward = EMAIL_LOCAL_ALIASES[rawLocal];
  if (forward) keys.add(forward);
  return [...keys];
}
