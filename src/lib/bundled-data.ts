/**
 * CSV payloads bundled at build time — safe for Vercel/Lambda (no runtime fs reads).
 */
import orgChartRosterCsv from "@/data/org-chart-roster.csv?raw";
import cintaraDomainEmailsCsv from "@/data/cintara-domain-emails.csv?raw";
import onboardingRosterCsv from "@/data/onboarding-roster.csv?raw";

export const BUNDLED_ORG_CHART_ROSTER_CSV = orgChartRosterCsv;
export const BUNDLED_CINTARA_DOMAIN_EMAILS_CSV = cintaraDomainEmailsCsv;
export const BUNDLED_ONBOARDING_ROSTER_CSV = onboardingRosterCsv;
