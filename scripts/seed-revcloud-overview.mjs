import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const rosterPath = join(__dirname, "../src/data/revcloud-roster.tsv");
const TSV = readFileSync(rosterPath, "utf8");

function norm(s) {
  return String(s ?? "").trim();
}

function slug(s) {
  return norm(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const lines = TSV.split(/\r?\n/).filter(Boolean);
const header = lines.shift().split("\t").map((x) => x.trim());
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
const rows = lines.map((l) => l.split("\t"));

const teams = new Map();
for (const r of rows) {
  const team = norm(r[idx["Team"]] ?? "General") || "General";
  teams.set(team, `dept_${slug(team)}`);
}

const departments = Array.from(teams.entries())
  .map(([name, id]) => ({ id, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

departments.unshift({ id: "dept_leadership", name: "Leadership" });

const employees = rows.map((r, i) => {
  const name = norm(r[idx["Name"]] ?? `Employee ${i + 1}`) || `Employee ${i + 1}`;
  const officialEmail = norm(r[idx["Official Email"]]);
  const email =
    officialEmail && officialEmail !== "No email found" ? officialEmail : `user${i + 1}@revcloud.com`;
  const team = norm(r[idx["Team"]] ?? "General") || "General";
  const manager = norm(r[idx["Manager"]]);

  return {
    id: `rev_${slug(officialEmail || name)}_${String(i + 1).padStart(3, "0")}`,
    full_name: name,
    email,
    role: team,
    level: "1",
    department_id: teams.get(team) ?? "dept_general",
    hire_date: "2026-01-01",
    performance_score: 3.6,
    manager_name: manager || null,
  };
});

employees.unshift({
  id: "rev_exec_bill",
  full_name: "Bill",
  email: "bill@revcloud.com",
  role: "Leadership",
  level: "1",
  department_id: "dept_leadership",
  hire_date: "2026-01-01",
  performance_score: 4.5,
  manager_name: null,
});

const compensation = employees.map((e, i) => ({
  id: `comp_${e.id}`,
  employee_id: e.id,
  base_salary: 65000 + (i % 8) * 4500,
  bonus_pct: 10 + (i % 5) * 2,
  equity_grant: i % 4 === 0 ? 3000 : 0,
  benefits: 2500,
  effective_date: "2026-01-01",
}));

const history = ["2026-01", "2026-02", "2026-03", "2026-04"].map((period, i) => ({
  id: `hist_${period}`,
  period,
  total_compensation: 5_000_000 + i * 250_000,
  total_bonus: 300_000 + i * 25_000,
  headcount: employees.length,
  avg_performance: 3.6,
}));

const snapshot = {
  version: 1,
  generatedAt: new Date().toISOString(),
  source: "revcloud",
  departments,
  employees,
  compensation,
  history,
};

const Bucket = process.env.ALYSON_HR_S3_BUCKET || "alyson-hr-dummy-datas";
const Key = process.env.ALYSON_HR_S3_KEY || "alyson-hr/overview.json";

const s3 = new S3Client({
  region: requireEnv("AWS_REGION"),
  credentials: {
    accessKeyId: requireEnv("AWS_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY"),
  },
});

await s3.send(
  new PutObjectCommand({
    Bucket,
    Key,
    Body: JSON.stringify(snapshot, null, 2),
    ContentType: "application/json; charset=utf-8",
  }),
);

console.log(`Seeded HR overview to s3://${Bucket}/${Key}`);
console.log(`employees=${employees.length} departments=${departments.length}`);
