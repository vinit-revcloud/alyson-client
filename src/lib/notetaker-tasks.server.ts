import { z } from "zod";
import {
  extractJsonObject,
  groqApiKey,
  groqChat,
  isGroqRateLimitError,
} from "@/lib/groq-chat.server";
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
const MEETING_EXTRACT_DELAY_MS = 2_000;
const DEFAULT_MAX_MEETINGS = 8;

/** Lighter model for task extraction — avoids burning 70b daily quota. */
function tasksGroqModel(): string {
  return (
    process.env.TASKS_GROQ_MODEL?.trim() ||
    process.env.ALYSON_MINI_MODULE_AI_MODEL?.trim() ||
    "llama-3.1-8b-instant"
  );
}

function tasksTokenBudget(): number {
  const n = Number(process.env.TASKS_MAX_ESTIMATED_TOKENS || 12_000);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 40_000) : 12_000;
}

function tasksMaxGroqCalls(): number {
  const n = Number(process.env.TASKS_MAX_GROQ_CALLS || 5);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 12) : 5;
}

function estimateGroqTokens(system: string, user: string): number {
  return Math.ceil((system.length + user.length) / 4) + 256;
}

function extractActionItemsSection(notesMd: string): string | null {
  const md = notesMd.trim();
  if (!md) return null;
  const patterns = [
    /(?:^|\n)#+\s*Action items?\s*\n([\s\S]*?)(?=\n#+\s|$)/i,
    /(?:^|\n)\*\*Action items?\*\*\s*\n([\s\S]*?)(?=\n#+\s|\n\*\*|$)/i,
    /(?:^|\n)Action items?\s*\n([\s\S]*?)(?=\n#+\s|$)/i,
  ];
  for (const re of patterns) {
    const m = md.match(re);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return null;
}

function bulletLineTargetsFocus(
  line: string,
  focus: FocusPerson,
  identity: SpeakerIdentityIndex,
): boolean {
  const bullet = line.replace(/^[-*•]\s*\[[xX]\]\s*/, "").replace(/^[-*•]\s*/, "").trim();
  if (!bullet) return false;

  const ownerMatch = bullet.match(/^([^:–—-]{2,48})\s*[:–—-]\s*(.+)$/);
  if (ownerMatch) {
    return personMatchesSpeakerLabel(ownerMatch[1].trim(), focus, identity);
  }

  const lower = bullet.toLowerCase();
  const email = focus.email.toLowerCase();
  if (email && lower.includes(email)) return true;

  const name = focus.name.trim();
  if (name && lower.includes(name.toLowerCase())) return true;

  const canonical = resolveCanonicalSpeaker(name, identity).toLowerCase();
  if (canonical && lower.includes(canonical)) return true;

  const first = normalizePersonName(name).split(" ")[0];
  if (first && first.length >= 3 && new RegExp(`\\b${first}\\b`, "i").test(bullet)) return true;

  return false;
}

/** Returns null when notes have no Action items section (Groq may be needed). */
function parseTasksFromNotes(
  notesMd: string,
  focus: FocusPerson,
  identity: SpeakerIdentityIndex,
): z.infer<typeof ExtractedTaskSchema>[] | null {
  const section = extractActionItemsSection(notesMd);
  if (section === null) return null;

  const tasks: z.infer<typeof ExtractedTaskSchema>[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !/^[-*•]/.test(trimmed)) continue;
    if (!bulletLineTargetsFocus(trimmed, focus, identity)) continue;

    let title = trimmed.replace(/^[-*•]\s*\[[xX]\]\s*/, "").replace(/^[-*•]\s*/, "").trim();
    const ownerMatch = title.match(/^([^:–—-]{2,48})\s*[:–—-]\s*(.+)$/);
    let ownerLabel: string | null = focus.name;
    if (ownerMatch) {
      ownerLabel = ownerMatch[1].trim();
      title = ownerMatch[2].trim();
    }
    if (!title) continue;
    tasks.push({
      title,
      ownerLabel,
      priority: "medium",
      status: /\[[xX]\]/.test(trimmed) ? "done" : "open",
      sourceQuote: trimmed,
    });
  }
  return tasks.slice(0, 8);
}

type GroqBudget = {
  groqCalls: number;
  estimatedTokens: number;
  maxCalls: number;
  maxTokens: number;
};
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

/** True only when the focus person appears as a speaker in the transcript. */
function personParticipatedInMeeting(args: {
  focus: FocusPerson;
  transcriptText: string;
  identity: SpeakerIdentityIndex;
}): boolean {
  const utterances = parseTranscriptUtterances(args.transcriptText);
  return utterances.some((u) => personMatchesSpeakerLabel(u.speaker, args.focus, args.identity));
}

function buildPersonScopedTranscript(
  transcriptText: string,
  focus: FocusPerson,
  identity: SpeakerIdentityIndex,
): string {
  const lines = parseTranscriptUtterances(transcriptText)
    .filter((u) => personMatchesSpeakerLabel(u.speaker, focus, identity))
    .map((u) => `${u.speaker}: ${u.text}`);
  return lines.join("\n").slice(0, 4_000);
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
  const notes = notesMd.trim().slice(0, 4_000);
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
    parts.push("", "Transcript excerpt (focus person had no direct lines):", transcriptText.trim().slice(0, 2_500));
  }

  return parts.join("\n");
}

type ExtractResult = {
  tasks: z.infer<typeof ExtractedTaskSchema>[];
  usedGroq: boolean;
  usedNotesOnly: boolean;
  estimatedTokens: number;
  skippedReason?: string;
};

async function extractMeetingTasks(
  args: {
    meeting: S3Meeting;
    notesMd: string;
    transcriptText: string;
    speakers: string[];
    focus: FocusPerson;
    identity: SpeakerIdentityIndex;
  },
  budget: GroqBudget,
): Promise<ExtractResult> {
  const fromNotes = parseTasksFromNotes(args.notesMd, args.focus, args.identity);
  if (fromNotes !== null) {
    return { tasks: fromNotes, usedGroq: false, usedNotesOnly: true, estimatedTokens: 0 };
  }

  const personLines = buildPersonScopedTranscript(args.transcriptText, args.focus, args.identity);
  if (!personLines.trim() && !args.notesMd.trim()) {
    return { tasks: [], usedGroq: false, usedNotesOnly: false, estimatedTokens: 0 };
  }

  if (budget.groqCalls >= budget.maxCalls) {
    return {
      tasks: [],
      usedGroq: false,
      usedNotesOnly: false,
      estimatedTokens: 0,
      skippedReason: "Skipped — Groq call budget reached for this crawl.",
    };
  }

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

  const est = estimateGroqTokens(sys, context);
  if (budget.estimatedTokens + est > budget.maxTokens) {
    return {
      tasks: [],
      usedGroq: false,
      usedNotesOnly: false,
      estimatedTokens: 0,
      skippedReason: "Skipped — token budget reached for this crawl.",
    };
  }

  if (!groqApiKey()) {
    throw new Error("GROQ_API_KEY is required for task extraction.");
  }

  const messages: { role: "system" | "user"; content: string }[] = [
    { role: "system", content: sys },
    { role: "user", content: context },
  ];

  let lastJsonError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await groqChat(messages, 0.1, {
      model: tasksGroqModel(),
      maxRetries: 2,
      maxRetryWaitMs: 30_000,
    });
    budget.groqCalls += 1;
    budget.estimatedTokens += est;
    try {
      const parsed = MeetingTasksSchema.parse(extractJsonObject(raw));
      return {
        tasks: parsed.tasks.slice(0, 8),
        usedGroq: true,
        usedNotesOnly: false,
        estimatedTokens: est,
      };
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

  const maxMeetings = Math.min(Math.max(args.maxMeetings ?? DEFAULT_MAX_MEETINGS, 1), 20);
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
  const withTranscripts = allMeetings
    .filter((m) => Boolean(m.transcriptKey))
    .sort((a, b) => b.day.localeCompare(a.day) || b.startedAt?.localeCompare(a.startedAt ?? "") || 0);

  type LoadedMeeting = { meeting: S3Meeting; notesMd: string; transcriptText: string };
  const personMeetings: LoadedMeeting[] = [];
  for (const meeting of withTranscripts) {
    if (personMeetings.length >= maxMeetings) break;
    if (!meeting.transcriptKey) continue;

    let transcriptText = "";
    try {
      transcriptText = await getTranscriptTextFromS3({ transcriptKey: meeting.transcriptKey });
    } catch {
      continue;
    }
    if (!transcriptText.trim()) continue;
    if (!personParticipatedInMeeting({ focus, transcriptText, identity: speakerIdentity })) {
      continue;
    }

    let notesMd = "";
    try {
      if (meeting.notesKey) notesMd = await getNotesMdFromS3({ notesKey: meeting.notesKey });
    } catch {
      // ignore — notes are optional once attendance is confirmed
    }

    personMeetings.push({ meeting, notesMd, transcriptText });
  }

  if (personMeetings.length === 0) {
    warnings.push(
      `No meetings found where ${focus.name} spoke in the transcript for this date range.`,
    );
  }

  const budget: GroqBudget = {
    groqCalls: 0,
    estimatedTokens: 0,
    maxCalls: tasksMaxGroqCalls(),
    maxTokens: tasksTokenBudget(),
  };

  let groqCallsUsed = 0;
  let notesOnlyMeetings = 0;
  let estimatedTokensUsed = 0;

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
      const result = await extractMeetingTasks(
        {
          meeting,
          notesMd,
          transcriptText,
          speakers,
          focus,
          identity: speakerIdentity,
        },
        budget,
      );

      if (result.skippedReason) {
        warnings.push(`${meeting.title}: ${result.skippedReason}`);
        extracted.push({ meeting, tasks: [], skipped: true });
        warnings.push(
          `Stopped early — Groq budget cap (${budget.maxCalls} calls, ~${budget.maxTokens.toLocaleString()} est. tokens). Meetings with Action items in notes skip Groq.`,
        );
        break;
      }

      if (result.usedGroq) {
        groqCallsUsed += 1;
        estimatedTokensUsed += result.estimatedTokens;
      } else if (result.usedNotesOnly) {
        notesOnlyMeetings += 1;
      }

      const llmTasks = result.tasks;
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
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`${meeting.title}: ${msg}`);
      extracted.push({ meeting, tasks: [], skipped: true });
      if (isGroqRateLimitError(msg)) {
        warnings.push(
          "Stopped early — Groq rate limit hit. Shrink the date window, wait a few minutes, or set TASKS_GROQ_MODEL=llama-3.1-8b-instant in .env.",
        );
        break;
      }
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
    model: tasksGroqModel(),
    focusPerson: focus,
    meetingCount: allMeetings.length,
    personMeetingCount: personMeetings.length,
    analyzedMeetings,
    skippedMeetings,
    totalTasks: allTasks.length,
    groqCallsUsed,
    notesOnlyMeetings,
    estimatedTokensUsed,
    users,
    unassigned,
    warnings: warnings.slice(0, 12),
  };

  reportCache.set(cacheKey, { at: Date.now(), report });
  return report;
}

export async function generateNotetakerTasksInsights(report: NotetakerTasksReport) {
  if (report.groqCallsUsed >= tasksMaxGroqCalls()) {
    return {
      insightsMd:
        "Insights skipped — this crawl already used the full Groq call budget. Review the extracted tasks below.",
      model: tasksGroqModel(),
    };
  }

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
    { model: tasksGroqModel(), maxRetries: 1, maxRetryWaitMs: 30_000 },
  );

  return { insightsMd: insightsMd || "No insights generated.", model: tasksGroqModel() };
}
