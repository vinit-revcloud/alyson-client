/** Column headers from Org Chart onboarding roster (Sheet1). */
export const ONBOARDING_COLUMNS = [
  "Employee ID",
  "Name",
  "Location",
  "Personal Email",
  "Official Email",
  "Team",
  "Manager",
  "Employment Status",
  "Last Woking Date",
  "Contact Phone Number",
  "Emergency Contact Phone Number",
  "Job Title",
  "Employment Type",
  "HR",
  "Shared",
  "Age",
  "DOB",
  "National ID Number",
  "Home Address",
  "Permanent Address",
  "Bank Account Information",
  "Base Salary",
  "Benefits",
  "Gender",
  "Shares/Equity",
  "Shares Awarded Date",
  "Company Property",
  "Access",
] as const;

export type OnboardingColumn = (typeof ONBOARDING_COLUMNS)[number];

export type OnboardingRow = Record<OnboardingColumn, string> & {
  _rowId: string;
};

export type OnboardingOperation =
  | "bootstrap"
  | "create"
  | "update"
  | "delete"
  | "bulk_replace";

export type OnboardingLogEntry = {
  ts: string;
  op: OnboardingOperation;
  employeeId: string | null;
  actor: string | null;
  rowCount?: number;
  details?: string;
};

export type OnboardingDataFile = {
  version: 1;
  updatedAt: string;
  rows: OnboardingRow[];
};

export function generateOnboardingEmployeeId(name?: string): string {
  const slug = String(name ?? "user")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  const suffix = Date.now().toString(36);
  return `onb_${slug || "user"}_${suffix}`;
}

export function blankOnboardingRow(name = ""): OnboardingRow {
  const employeeId = generateOnboardingEmployeeId(name);
  const row = { _rowId: employeeId } as OnboardingRow;
  for (const col of ONBOARDING_COLUMNS) {
    row[col] = col === "Employee ID" ? employeeId : col === "Name" ? name : "";
  }
  return row;
}
