/** Parse `Speaker: utterance` lines from S3 transcript.txt (same format as composeTranscript). */

export type ParsedUtterance = {
  speaker: string;
  text: string;
  wordCount: number;
};

export function parseTranscriptUtterances(transcriptText: string): ParsedUtterance[] {
  return String(transcriptText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([^:]+):\s*(.+)$/);
      const speaker = (m?.[1] || "Speaker").trim();
      const text = (m?.[2] || line).trim();
      const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
      return { speaker, text, wordCount };
    })
    .filter((u) => u.text.length > 0);
}

export type SpeakerRollup = {
  speaker: string;
  utterances: number;
  words: number;
};

export function rollupSpeakers(utterances: ParsedUtterance[]): SpeakerRollup[] {
  const m = new Map<string, { utterances: number; words: number }>();
  for (const u of utterances) {
    const key = u.speaker;
    const cur = m.get(key) ?? { utterances: 0, words: 0 };
    cur.utterances += 1;
    cur.words += u.wordCount;
    m.set(key, cur);
  }
  return Array.from(m.entries())
    .map(([speaker, stats]) => ({ speaker, ...stats }))
    .sort((a, b) => b.utterances - a.utterances || b.words - a.words);
}

export function normalizeSpeakerFilter(filter: string) {
  return String(filter || "")
    .trim()
    .toLowerCase();
}

export function speakerMatchesFilter(speaker: string, filter: string) {
  const f = normalizeSpeakerFilter(filter);
  if (!f) return true;
  return speaker.toLowerCase().includes(f);
}

/** Split legacy comma-separated input or normalize a list of chip values. */
export function normalizeSpeakerFilterList(raw: string[] | string | undefined): string[] {
  if (!raw) return [];
  const parts = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(/[,;]+/)
        .map((s) => s.trim());
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const n = p.trim();
    if (!n) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/** True if speaker name matches any filter token (substring, case-insensitive). */
export function speakerMatchesAnyFilter(speaker: string, filters: string[]) {
  const list = normalizeSpeakerFilterList(filters);
  if (list.length === 0) return true;
  const name = speaker.toLowerCase();
  return list.some((f) => name.includes(f.trim().toLowerCase()));
}

/** Meeting qualifies when at least one rolled-up speaker matches any filter (OR). */
export function meetingHasMatchingSpeaker(speakers: SpeakerRollup[], filters: string[]) {
  const list = normalizeSpeakerFilterList(filters);
  if (list.length === 0) return true;
  return speakers.some((s) => speakerMatchesAnyFilter(s.speaker, list));
}
