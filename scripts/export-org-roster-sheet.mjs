import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const rosterPath = join(root, "src/data/revcloud-roster.tsv");
const outDir = join(root, "exports");

function norm(s) {
  return String(s ?? "").trim();
}

function slug(s) {
  return norm(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const tsv = readFileSync(rosterPath, "utf8");
const lines = tsv.split(/\r?\n/).filter(Boolean);
const header = lines.shift().split("\t").map((x) => x.trim());
const idx = Object.fromEntries(header.map((h, i) => [h, i]));

const rows = lines.map((line, i) => {
  const r = line.split("\t");
  const name = norm(r[idx["Name"]] ?? `Employee ${i + 1}`) || `Employee ${i + 1}`;
  const officialEmail = norm(r[idx["Official Email"]]);
  const email =
    officialEmail && officialEmail !== "No email found" ? officialEmail : `user${i + 1}@revcloud.com`;
  const team = norm(r[idx["Team"]] ?? "General") || "General";
  const manager = norm(r[idx["Manager"]]);

  return {
    "Employee ID": `rev_${slug(officialEmail || name)}_${String(i + 1).padStart(3, "0")}`,
    Name: name,
    Location: norm(r[idx["Location"]]),
    "Personal Email": norm(r[idx["Email ID"]]),
    "Official Email": email,
    Team: team,
    Manager: manager || "",
  };
});

const hasBill = rows.some((r) => norm(r.Name).toLowerCase() === "bill");
if (!hasBill) {
  rows.unshift({
    "Employee ID": "rev_exec_bill",
    Name: "Bill",
    Location: "",
    "Personal Email": "",
    "Official Email": "bill@revcloud.com",
    Team: "Leadership",
    Manager: "",
  });
}

mkdirSync(outDir, { recursive: true });

const sheetRows = rows;
const wb = XLSX.utils.book_new();
const ws = XLSX.utils.json_to_sheet(sheetRows);
XLSX.utils.book_append_sheet(wb, ws, "Org Roster");

const xlsxPath = join(outDir, "alyson-org-roster.xlsx");
const csvPath = join(outDir, "alyson-org-roster.csv");

XLSX.writeFile(wb, xlsxPath);
writeFileSync(csvPath, XLSX.utils.sheet_to_csv(ws), "utf8");

console.log(`Wrote ${xlsxPath}`);
console.log(`Wrote ${csvPath}`);
console.log(`rows=${sheetRows.length}`);
