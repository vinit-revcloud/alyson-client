import { ensureMeetingNotesByPrefix } from "../src/lib/notetaker-auto-persist.server";

const prefix = process.argv[2] || "-alyson-hr-onboarding-flow_2026-06-09_14-28-14";
console.log("Testing prefix:", prefix);
const r = await ensureMeetingNotesByPrefix(prefix);
console.log(JSON.stringify(r, null, 2));
