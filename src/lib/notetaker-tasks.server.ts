import { z } from "zod";
import { extractJsonObject, groqApiKey, groqChat, groqModel } from "@/lib/groq-chat.server";
import { loadEmployeePickerDirectory } from "@/lib/employee-picker-directory.server";
import type { EmployeePickerEntry } from "@/lib/employee-picker-types";
import {
  getNotesMdFromS3,
  getTranscriptTextFromS3,
  listMeetingsFromS3,
  type S3Meeting,
} from "@/lib/notetaker-s3-calendar.server";
import { getSpeakerIdentityIndex } from "@/lib/speaker-identity.server";
import {
  looksLikeEmail,
  normalizePersonName,
  resolveCanonicalEmail,
  resolveCanonicalSpeaker,
  type SpeakerIdentityIndex,
} from "@/lib/speaker-identity";
import { parseTranscriptUtterances } from "@/lib/notetaker-transcript-parse.server";
import type { MeetingTask, NotetakerTasksReport, TaskPriority, TaskStatus, UserTaskRollup } from "@/lib/notetaker-tasks-types";

const ExtractedTaskSchema = z.object({
  title: z.string(),
  ownerLabel: z.string().optional().nullable(),
  dueHint: z.string().optional().nullable(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  status: z.enum(["open", "done", "unclear"]).optional(),
  sourceQuote: z.string().optional().nullable(),
});

const MeetingTasksSchema = z.object({
  tasks: z.array(ExtractedTaskSchema).default([]),
});

const REPORT_CACHE_MS = 10 * 60_000;
const MEETING_EXTRACT_DELAY_MS = 1_200;
const reportCache = new Map<string, { at: number; report: NotetakerTasksReport }>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskId(meetingPrefix: string, title: string, owner: string | null) {
  const raw = `${meetingPrefix}::${title}::${owner ?? ""}`.toLowerCase();
  return raw.replace(/[^a-z0-9]+/g, "-").slice(0, 120);
}

type FocusPerson = { email: string; name: string };

function personMatchesSpeakerLabel(
  speakerLabel: string,
  focus: FocusPerson,
  identity: SpeakerIdentityIndex,
): boolean {
  const focusEmail = resolveCanonicalEmail(focus.email, identity).toLowerCase();
  const raw = String(speakerLabel || "").trim();
  if (!raw) return false;

  if (looksLikeEmail(raw) && resolveCanonicalEmail(raw, identity).toLowerCase() === focusEmail) {
    return true;
  }

  const speakerCanonical = resolveCanonicalSpeaker(raw, identity);
  const focusCanonical = resolveCanonicalSpeaker(focus.name || focus.email, identity);
  if (speakerCanonical === focusCanonical) return true;

  const normSpeaker = normalizePersonName(speakerCanonical);
  const normFocus = normalizePersonName(focus.name);
  if (normFocus && normSpeaker === normFocus) return true;

  const firstFocus = normFocus.split(" ")[0] ?? "";
  const firstSpeaker = normSpeaker.split(" ")[0] ?? "";
  return Boolean(firstFocus && firstFocus.length >= 3 && firstFocus === firstSpeaker);
}

function personMentionedInText(text: string, focus: FocusPerson, identity: SpeakerIdentityIndex): boolean {
  const blob = String(text || "").toLowerCase();
  if (!blob.trim()) return false;

  const email = resolveCanonicalEmail(focus.email, identity).toLowerCase();
  if (email && blob.includes(email)) return true;
  if (focus.email && blob.includes(focus.email.toLowerCase())) return true;

  const name = focus.name.trim();
  if (name && blob.includes(name.toLowerCase())) return true;

  const canonical = resolveCanonicalSpeaker(name || focus.email, identity);
  if (canonical && blob.includes(canonical.toLowerCase())) return true;

  const first = normalizePersonName(name).split(" ")[0];
  return Boolean(first && first.length >= 3 && blob.includes(first));
}

function personParticipatedInMeeting(args: {
  focus: FocusPerson;
  transcriptText: string;
  notesMd: string;
  identity: SpeakerIdentityIndex;
}): boolean {
  const utterances = parseTranscriptUtterances(args.transcriptText);
  if (
    utterances.some((u) => personMatchesSpeakerLabel(u.speaker, args.focus, args.identity))
  ) {
    return true;
  }
  return personMentionedInText(`${args.notesMd}\n${args.transcriptText}`, args.focus, args.identity);
}

function buildPersonScopedTranscript(
  transcriptText: string,
  focus: FocusPerson,
  identity: SpeakerIdentityIndex,
): string {
  const lines = parseTranscriptUtterances(transcriptText)
    .filter((u) => personMatchesSpeakerLabel(u.speaker, focus, identity))
    .map((u) => `${u.speaker}: ${u.text}`);
  return lines.join("\n").slice(0, 8_000);
}

function resolveOwnerToAssignee(
  ownerLabel: string | null | undefined,
  identity: SpeakerIdentityIndex,
  roster: EmployeePickerEntry[],
): { email: string | null; name: string | null } {
  const raw = String(ownerLabel || "").trim();
  if (!raw) return { email: null, name: null };

  if (looksLikeEmail(raw)) {
    const email = resolveCanonicalEmail(raw, identity);
    const match = roster.find((e) => resolveCanonicalEmail(e.email, identity) === email);
    return { email, name: match?.name?.trim() || resolveCanonicalSpeaker(raw, identity) };
  }

  const canonical = resolveCanonicalSpeaker(raw, identity);
  for (const e of roster) {
    const eCanonical = resolveCanonicalSpeaker(e.name || e.email, identity);
    if (
      eCanonical === canonical ||
      normalizePersonName(e.name) === normalizePersonName(canonical) ||
      normalizePersonName(e.name).split(" ")[0] === normalizePersonName(canonical).split(" ")[0]
    ) {
      return { email: resolveCanonicalEmail(e.email, identity), name: e.name?.trim() || canonical };
    }
  }

  return { email: null, name: canonical };
}

function buildMeetingContext(args: {
  meeting: S3Meeting;
  notesMd: string;
  transcriptText: string;
  speakers: string[];
  focus: FocusPerson;
  identity: SpeakerIdentityIndex;
}) {
  const { meeting, notesMd, transcriptText, speakers, focus, identity } = args;
  const notes = notesMd.trim().slice(0, 6_000);
  const personTranscript = buildPersonScopedTranscript(transcriptText, focus, identity);
  const speakerLine = speakers.length ? `Known speakers: ${speakers.join(", ")}` : "Known speakers: (none parsed)";

  const parts = [
    `Meeting: ${meeting.title}`,
    `Date: ${meeting.day}`,
    `Focus person: ${focus.name} (${focus.email})`,
    speakerLine,
    "",
  ];

  if (notes) {
    parts.push("Meeting notes (markdown):", notes);
  }
  if (personTranscript) {
    parts.push("", "Transcript lines from focus person:", personTranscript);
  } else if (transcriptText.trim()) {
    parts.push("", "Transcript excerpt (focus person had no direct lines):", transcriptText.trim().slice(0, 4_000));
  }

  return parts.join("\n");
}

async function extractMeetingTasks(args: {
  meeting: S3Meeting;
  notesMd: string;
  transcriptText: string;
  speakers: string[];
  focus: FocusPerson;
  identity: SpeakerIdentityIndex;
}): Promise<z.infer<typeof ExtractedTaskSchema>[]> {
  const context = buildMeetingContext(args);
  const sys = [
    "You are Alyson Meeting Tasks.",
    `Extract actionable tasks and follow-ups for ONE person only: ${args.focus.name} (${args.focus.email}).`,
    "Return ONLY valid JSON with this shape:",
    '{"tasks":[{"title":"...","ownerLabel":"...","dueHint":"...","priority":"low|medium|high","status":"open|done|unclear","sourceQuote":"..."}]}',
    "Rules:",
    "- ONLY include action items assigned to or owned by the focus person.",
    "- Do NOT include tasks for other attendees.",
    "- ownerLabel must be the focus person's name or email when included.",
    "- Do not invent owners, deadlines, or tasks not supported by the text.",
    "- Prefer open items; mark done only when explicitly completed.",
    "- If no tasks for this person, return {\"tasks\":[]}.",
    "- Max 8 tasks per meeting.",
  ].join("\n");

  if (!groqApiKey()) {
    throw new Error("GROQ_API_KEY is required for task extraction.");
  }

  const messages: { role: "system" | "user"; content: string }[] = [
    { role: "system", content: sys },
    { role: "user", content: context },
  ];

  let lastJsonError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await groqChat(messages, 0.1);
    try {
      const parsed = MeetingTasksSchema.parse(extractJsonObject(raw));
      return parsed.tasks.slice(0, 8);
    } catch (e) {
      lastJsonError = e;
      messages[0] = {
        role: "system",
        content: `${sys}\nReturn strictly valid JSON only. No markdown fences, no commentary.`,
      };
    }
  }

  throw lastJsonError instanceof Error ? lastJsonError : new Error(String(lastJsonError));
}

function dedupeTasks(tasks: MeetingTask[]): MeetingTask[] {
  const seen = new Set<string>();
  const out: MeetingTask[] = [];
  for (const t of tasks) {
    const key = `${t.assigneeEmail ?? "unassigned"}::${t.meetingPrefix}::${t.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function rollupByUser(tasks: MeetingTask[]): { users: UserTaskRollup[]; unassigned: MeetingTask[] } {
  const byEmail = new Map<string, UserTaskRollup>();
  const unassigned: MeetingTask[] = [];

  for (const task of tasks) {
    if (!task.assigneeEmail) {
      unassigned.push(task);
      continue;
    }
    const key = task.assigneeEmail.toLowerCase();
    const existing = byEmail.get(key);
    if (existing) {
      existing.tasks.push(task);
      if (task.status === "open") existing.openCount += 1;
    } else {
      byEmail.set(key, {
        assigneeEmail: task.assigneeEmail,
        assigneeName: task.assigneeName || task.assigneeEmail,
        openCount: task.status === "open" ? 1 : 0,
        tasks: [task],
      });
    }
  }

  const users = [...byEmail.values()].sort(
    (a, b) => b.openCount - a.openCount || b.tasks.length - a.tasks.length || a.assigneeName.localeCompare(b.assigneeName),
  );
  for (const u of users) {
    u.tasks.sort((a, b) => b.meetingDay.localeCompare(a.meetingDay) || a.title.localeCompare(b.title));
  }
  unassigned.sort((a, b) => b.meetingDay.localeCompare(a.meetingDay) || a.title.localeCompare(b.title));

  return { users, unassigned };
}

export async function buildNotetakerTasksReport(args: {
  start: string;
  end: string;
  assigneeEmail: string;
  assigneeName?: string;
  maxMeetings?: number;
  forceRefresh?: boolean;
}): Promise<NotetakerTasksReport> {
  const assigneeFilter = String(args.assigneeEmail || "").trim().toLowerCase();
  if (!assigneeFilter) {
    throw new Error("Select a person before crawling — tasks are extracted per user to save tokens.");
  }

  const maxMeetings = Math.min(Math.max(args.maxMeetings ?? 25, 1), 40);
  const cacheKey = `${args.start}:${args.end}:${assigneeFilter}:${maxMeetings}`;
  if (!args.forceRefresh) {
    const hit = reportCache.get(cacheKey);
    if (hit && Date.now() - hit.at < REPORT_CACHE_MS) return hit.report;
  }

  const warnings: string[] = [];
  const { index: speakerIdentity, warnings: identityWarnings } = await getSpeakerIdentityIndex();
  warnings.push(...identityWarnings);

  let roster: EmployeePickerEntry[] = [];
  try {
    const dir = await loadEmployeePickerDirectory();
    roster = dir.employees;
    warnings.push(...dir.warnings.slice(0, 2));
  } catch (e) {
    warnings.push(`employee_directory: ${String(e)}`);
  }

  const rosterMatch = roster.find((e) => resolveCanonicalEmail(e.email, speakerIdentity).toLowerCase() === assigneeFilter);
  const focus: FocusPerson = {
    email: assigneeFilter,
    name: args.assigneeName?.trim() || rosterMatch?.name?.trim() || assigneeFilter.split("@")[0] || assigneeFilter,
  };

  const allMeetings = await listMeetingsFromS3({ start: args.start, end: args.end });
  const withArtifacts = allMeetings
    .filter((m) => Boolean(m.transcriptKey || m.notesKey))
    .sort((a, b) => b.day.localeCompare(a.day) || b.startedAt?.localeCompare(a.startedAt ?? "") || 0);

  type LoadedMeeting = { meeting: S3Meeting; notesMd: string; transcriptText: string };
  const personMeetings: LoadedMeeting[] = [];
  for (const meeting of withArtifacts) {
    if (personMeetings.length >= maxMeetings) break;

    let notesMd = "";
    let transcriptText = "";
    try {
      if (meeting.notesKey) notesMd = await getNotesMdFromS3({ notesKey: meeting.notesKey });
    } catch {
      // ignore
    }
    try {
      if (meeting.transcriptKey) {
        transcriptText = await getTranscriptTextFromS3({ transcriptKey: meeting.transcriptKey });
      }
    } catch {
      continue;
    }

    if (!notesMd.trim() && !transcriptText.trim()) continue;
    if (!personParticipatedInMeeting({ focus, transcriptText, notesMd, identity: speakerIdentity })) {
      continue;
    }
    personMeetings.push({ meeting, notesMd, transcriptText });
  }

  if (personMeetings.length === 0) {
    warnings.push(`No meetings found for ${focus.name} in this date range.`);
  }

  const extracted: Array<{ meeting: S3Meeting; tasks: MeetingTask[]; skipped: boolean }> = [];
  for (let i = 0; i < personMeetings.length; i++) {
    const { meeting, notesMd, transcriptText } = personMeetings[i]!;

    const speakers = [
      ...new Set(
        parseTranscriptUtterances(transcriptText)
          .map((u) => resolveCanonicalSpeaker(u.speaker, speakerIdentity))
          .filter(Boolean),
      ),
    ].slice(0, 20);

    try {
      const llmTasks = await extractMeetingTasks({
        meeting,
        notesMd,
        transcriptText,
        speakers,
        focus,
        identity: speakerIdentity,
      });
      const tasks: MeetingTask[] = llmTasks.map((t) => {
        const owner = t.ownerLabel?.trim() || null;
        const assignee = owner
          ? resolveOwnerToAssignee(owner, speakerIdentity, roster)
          : { email: focus.email, name: focus.name };
        const priority = (t.priority ?? "medium") as TaskPriority;
        const status = (t.status ?? "open") as TaskStatus;
        return {
          id: taskId(meeting.prefix, t.title, assignee.email ?? owner),
          title: t.title.trim(),
          ownerLabel: owner,
          assigneeEmail: assignee.email,
          assigneeName: assignee.name,
          dueHint: t.dueHint?.trim() || null,
          priority,
          status,
          sourceQuote: t.sourceQuote?.trim() || null,
          meetingPrefix: meeting.prefix,
          meetingTitle: meeting.title,
          meetingDay: meeting.day,
          transcriptKey: meeting.transcriptKey,
          notesKey: meeting.notesKey,
        };
      });
      const matchedTasks = tasks.filter((t) => t.assigneeEmail?.toLowerCase() === assigneeFilter);
      extracted.push({ meeting, tasks: matchedTasks, skipped: false });
    } catch (e) {
      warnings.push(`${meeting.title}: ${e instanceof Error ? e.message : String(e)}`);
      extracted.push({ meeting, tasks: [], skipped: true });
    }

    if (i < personMeetings.length - 1) {
      await sleep(MEETING_EXTRACT_DELAY_MS);
    }
  }

  const allTasks = dedupeTasks(
    extracted.flatMap((r) => r.tasks).filter((t) => t.assigneeEmail?.toLowerCase() === assigneeFilter),
  );

  const { users, unassigned } = rollupByUser(allTasks);
  const analyzedMeetings = extracted.filter((r) => !r.skipped && r.tasks.length > 0).length;
  const skippedMeetings = extracted.filter((r) => r.skipped || r.tasks.length === 0).length;

  const report: NotetakerTasksReport = {
    range: { start: args.start, end: args.end },
    generatedAt: new Date().toISOString(),
    model: groqModel(),
    focusPerson: focus,
    meetingCount: allMeetings.length,
    personMeetingCount: personMeetings.length,
    analyzedMeetings,
    skippedMeetings,
    totalTasks: allTasks.length,
    users,
    unassigned,
    warnings: warnings.slice(0, 12),
  };

  reportCache.set(cacheKey, { at: Date.now(), report });
  return report;
}

export async function generateNotetakerTasksInsights(report: NotetakerTasksReport) {
  const compact = {
    range: report.range,
    focusPerson: report.focusPerson,
    totalTasks: report.totalTasks,
    users: report.users.slice(0, 20).map((u) => ({
      name: u.assigneeName,
      email: u.assigneeEmail,
      openCount: u.openCount,
      tasks: u.tasks.slice(0, 8).map((t) => ({
        title: t.title,
        meeting: t.meetingTitle,
        day: t.meetingDay,
        priority: t.priority,
        status: t.status,
        dueHint: t.dueHint,
      })),
    })),
    unassigned: report.unassigned.slice(0, 8).map((t) => ({
      title: t.title,
      meeting: t.meetingTitle,
      day: t.meetingDay,
    })),
  };

  const sys = [
    "You are Alyson Meeting Tasks.",
    `Summarize meeting tasks for one person: ${report.focusPerson.name} (${report.focusPerson.email}).`,
    "Output concise Markdown with sections:",
    "- Overview",
    "- Open action items",
    "- Urgent or high-priority items",
    "- Suggested next steps",
    "Use only facts from the JSON. Do not invent tasks or people.",
  ].join("\n");

  const insightsMd = await groqChat(
    [
      { role: "system", content: sys },
      { role: "user", content: `Tasks rollup JSON:\n\n${JSON.stringify(compact, null, 2)}` },
    ],
    0.2,
  );

  return { insightsMd: insightsMd || "No insights generated.", model: groqModel() };
}
