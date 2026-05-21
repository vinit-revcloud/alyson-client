import { getTranscriptTextFromS3, listMeetingsFromS3 } from "@/lib/notetaker-s3-calendar.server";
import {
  meetingHasMatchingSpeaker,
  normalizeSpeakerFilterList,
  parseTranscriptUtterances,
  rollupSpeakers,
  speakerMatchesAnyFilter,
  type SpeakerRollup,
} from "@/lib/notetaker-transcript-parse.server";

export type MeetingSpeakerAnalytics = {
  prefix: string;
  day: string;
  title: string;
  startedAt: string | null;
  transcriptKey: string;
  totalUtterances: number;
  totalWords: number;
  uniqueSpeakers: number;
  speakers: SpeakerRollup[];
};

export type NotetakerAnalyticsReport = {
  range: { start: string; end: string };
  generatedAt: string;
  filters: { speakers: string[]; meetingTitle: string };
  meetingCount: number;
  analyzedCount: number;
  skippedNoTranscript: number;
  totalUtterances: number;
  totalWords: number;
  uniqueSpeakersGlobal: number;
  meetings: MeetingSpeakerAnalytics[];
  topSpeakers: Array<SpeakerRollup & { meetingsSpoken: number }>;
  meetingsByDay: Array<{ day: string; meetings: number }>;
  speakerByMeeting: Array<{ meeting: string; day: string; speaker: string; utterances: number; words: number }>;
};

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

export async function buildNotetakerAnalyticsReport(args: {
  start: string;
  end: string;
  speakerFilters?: string[] | string;
  meetingTitleFilter?: string;
  maxMeetings?: number;
}): Promise<NotetakerAnalyticsReport> {
  const speakerFilters = normalizeSpeakerFilterList(args.speakerFilters);
  const meetingTitleFilter = String(args.meetingTitleFilter || "").trim().toLowerCase();
  const maxMeetings = Math.min(Math.max(args.maxMeetings ?? 100, 1), 100);

  const allMeetings = await listMeetingsFromS3({ start: args.start, end: args.end });
  let candidates = allMeetings.filter((m) => Boolean(m.transcriptKey));
  if (meetingTitleFilter) {
    candidates = candidates.filter((m) => m.title.toLowerCase().includes(meetingTitleFilter));
  }
  candidates = candidates.slice(0, maxMeetings);

  const analyzed = await mapPool(candidates, 5, async (m) => {
    const transcriptKey = m.transcriptKey!;
    let transcriptText = "";
    try {
      transcriptText = await getTranscriptTextFromS3({ transcriptKey });
    } catch {
      return null;
    }
    const utterances = parseTranscriptUtterances(transcriptText);
    const allSpeakers = rollupSpeakers(utterances);
    if (speakerFilters.length > 0 && !meetingHasMatchingSpeaker(allSpeakers, speakerFilters)) {
      return null;
    }
    let speakers = allSpeakers;
    if (speakerFilters.length > 0) {
      speakers = allSpeakers.filter((s) => speakerMatchesAnyFilter(s.speaker, speakerFilters));
    }
    const totalUtterances = speakers.reduce((n, s) => n + s.utterances, 0);
    const totalWords = speakers.reduce((n, s) => n + s.words, 0);
    return {
      prefix: m.prefix,
      day: m.day,
      title: m.title,
      startedAt: m.startedAt,
      transcriptKey,
      totalUtterances,
      totalWords,
      uniqueSpeakers: speakers.length,
      speakers,
    } satisfies MeetingSpeakerAnalytics;
  });

  const meetings = analyzed.filter(Boolean) as MeetingSpeakerAnalytics[];

  const speakerGlobal = new Map<string, { utterances: number; words: number; meetings: Set<string> }>();
  const dayCounts = new Map<string, number>();
  const speakerByMeeting: NotetakerAnalyticsReport["speakerByMeeting"] = [];

  for (const m of meetings) {
    dayCounts.set(m.day, (dayCounts.get(m.day) ?? 0) + 1);
    for (const s of m.speakers) {
      const g = speakerGlobal.get(s.speaker) ?? { utterances: 0, words: 0, meetings: new Set<string>() };
      g.utterances += s.utterances;
      g.words += s.words;
      g.meetings.add(m.prefix);
      speakerGlobal.set(s.speaker, g);
      speakerByMeeting.push({
        meeting: m.title,
        day: m.day,
        speaker: s.speaker,
        utterances: s.utterances,
        words: s.words,
      });
    }
  }

  const topSpeakers = Array.from(speakerGlobal.entries())
    .map(([speaker, g]) => ({
      speaker,
      utterances: g.utterances,
      words: g.words,
      meetingsSpoken: g.meetings.size,
    }))
    .sort((a, b) => b.utterances - a.utterances || b.words - a.words);

  const meetingsByDay = Array.from(dayCounts.entries())
    .map(([day, count]) => ({ day, meetings: count }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    range: { start: args.start, end: args.end },
    generatedAt: new Date().toISOString(),
    filters: { speakers: speakerFilters, meetingTitle: meetingTitleFilter },
    meetingCount: allMeetings.length,
    analyzedCount: meetings.length,
    skippedNoTranscript: allMeetings.length - allMeetings.filter((m) => m.transcriptKey).length,
    totalUtterances: meetings.reduce((n, m) => n + m.totalUtterances, 0),
    totalWords: meetings.reduce((n, m) => n + m.totalWords, 0),
    uniqueSpeakersGlobal: speakerGlobal.size,
    meetings,
    topSpeakers,
    meetingsByDay,
    speakerByMeeting,
  };
}
