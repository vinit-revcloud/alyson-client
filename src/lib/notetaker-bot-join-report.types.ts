export const DEFAULT_BOT_JOIN_REPORT_EMAIL = "alysonclient@cintara.ai";

/** Rolling window preset for the bot join report UI. */
export const BOT_JOIN_REPORT_24H_WINDOW_HOURS = 24;

export type BotJoinReportRange = {
  start: string;
  end: string;
  /** When set, metrics use a rolling window ending now (not full calendar days). */
  windowHours?: number;
  windowStart?: string;
  windowEnd?: string;
};

export type CalendarMeetingRef = {
  googleEventId: string;
  title: string;
  startTime: string;
  endTime: string | null;
  meetingUrl: string;
  dedupeKey: string;
};

export type BotJoinDailyPoint = {
  day: string;
  eligibleMeetings: number;
  meetingsJoined: number;
  meetingsMissed: number;
  joinRatePercent: number | null;
  avgLateMinutes: number | null;
  maxLateMinutes: number | null;
};

export type BotJoinReportRow = {
  botId: string;
  title: string;
  meetingUrl: string | null;
  scheduledStart: string | null;
  /** Calendar meeting start used for lateness (when reliable). */
  meetingStartAt?: string | null;
  meetingStartReliable?: boolean;
  calendarUserEmail: string;
  googleEventId?: string;
  source: "unified_scheduled" | "s3_index" | "notetaker_session" | "recall_calendar" | "unknown";
  creationSource?: string;
  scheduledAt?: string;
  botJoinAt?: string;
  joiningCallAt: string | null;
  waitingRoomEnteredAt: string | null;
  admittedAt: string | null;
  waitingRoomSeconds: number | null;
  waitingRoomLabel: string;
  /** Seconds after scheduled start when admitted (negative = early). */
  lateToStartSeconds: number | null;
  lateToStartLabel: string;
  lateMinutes: number | null;
  finalStatus: string;
  joinedMeeting: boolean;
  stuckInWaitingRoom: boolean;
  fatalSubCode: string | null;
  recallFetchError?: string;
};

export type BotJoinCriticalMetrics = {
  /** Eligible calendar meetings (Meet link, not skipped). */
  totalEligibleMeetings: number;
  /** Bot successfully admitted to the call. */
  meetingsJoined: number;
  /** Eligible meetings with no successful join. */
  meetingsMissed: number;
  /** meetingsJoined / totalEligibleMeetings */
  joinRatePercent: number | null;
  /** Avg minutes late to scheduled start (joined meetings only, when late). */
  avgLateMinutes: number | null;
  /** Worst admission delay vs scheduled start. */
  maxLateMinutes: number | null;
  /** Joined meetings admitted more than 2 min after start. */
  meetingsJoinedLate: number;
  /** Never admitted from waiting room. */
  stuckInWaitingRoom: number;
  /** Recall fatal status. */
  failedJoins: number;
  /** Bots scheduled but join unknown / no Recall data. */
  scheduledNotJoined: number;
};

export type BotJoinReportDiagnostics = {
  botsFromNotetakerSessions: number;
  botsFromUnifiedState: number;
  botsFromS3Index: number;
  botsFromRecallCalendar: number;
  warnings: string[];
  recallBotsFromListApi?: number;
  recallBotsFromCache?: number;
  recallBotsSkippedFetch?: number;
};

export type BotJoinReport = {
  range: BotJoinReportRange;
  calendarEmail: string;
  generatedAt: string;
  recallConfigured: boolean;
  calendarAvailable: boolean;
  calendarError?: string;
  diagnostics: BotJoinReportDiagnostics;
  critical: BotJoinCriticalMetrics;
  /** Calendar-eligible meetings the bot successfully joined. */
  joinedMeetings: BotJoinReportRow[];
  /** Eligible calendar meetings with no successful bot join. */
  missedMeetings: CalendarMeetingRef[];
  /** Per-day join rate and lateness trends. */
  daily: BotJoinDailyPoint[];
  rows: BotJoinReportRow[];
};
