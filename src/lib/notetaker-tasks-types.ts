export type TaskPriority = "low" | "medium" | "high";
export type TaskStatus = "open" | "done" | "unclear";

export type MeetingTask = {
  id: string;
  title: string;
  ownerLabel: string | null;
  assigneeEmail: string | null;
  assigneeName: string | null;
  dueHint: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  sourceQuote: string | null;
  meetingPrefix: string;
  meetingTitle: string;
  meetingDay: string;
  transcriptKey: string | null;
  notesKey: string | null;
};

export type UserTaskRollup = {
  assigneeEmail: string;
  assigneeName: string;
  openCount: number;
  tasks: MeetingTask[];
};

export type NotetakerTasksReport = {
  range: { start: string; end: string };
  generatedAt: string;
  model: string;
  focusPerson: { email: string; name: string };
  meetingCount: number;
  /** Meetings where the focus person participated (LLM candidates). */
  personMeetingCount: number;
  analyzedMeetings: number;
  skippedMeetings: number;
  totalTasks: number;
  users: UserTaskRollup[];
  unassigned: MeetingTask[];
  warnings: string[];
};
