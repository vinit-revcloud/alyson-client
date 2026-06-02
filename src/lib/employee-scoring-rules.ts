/**
 * Rule-based employee scoring for a single time window.
 * Each dimension is scored 0–100 via cohort percentile rank, then combined with fixed weights.
 */

export const SCORING_WEIGHTS = {
  workHours: 0.4,
  meetings: 0.25,
  emails: 0.15,
  chat: 0.12,
  docs: 0.08,
} as const;

export type ScoringWeights = typeof SCORING_WEIGHTS;

export type EmployeeScoreInput = {
  userEmail: string;
  displayName: string;
  emailsSent: number;
  meetingsCreated: number;
  docsCreated: number;
  chatMessagesSent: number;
  workSeconds: number;
  windowDays: number;
};

export type EmployeeScoreBreakdown = {
  workHours: number;
  meetings: number;
  emails: number;
  chat: number;
  docs: number;
};

export type EmployeeScoreRow = EmployeeScoreInput & {
  rank: number;
  workHours: number;
  hoursPerDay: number;
  percentile: EmployeeScoreBreakdown;
  compositeScore: number;
  grade: "A" | "B" | "C" | "D" | "F";
};

/** Mid-rank percentile: 0 when everyone is 0; 100 when highest in cohort. */
export function percentileRank(values: number[], value: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return value > 0 ? 100 : 0;
  const below = values.filter((v) => v < value).length;
  const equal = values.filter((v) => v === value).length;
  return Math.round(((below + equal * 0.5) / values.length) * 1000) / 10;
}

export function scoreToGrade(score: number): EmployeeScoreRow["grade"] {
  if (score >= 80) return "A";
  if (score >= 65) return "B";
  if (score >= 50) return "C";
  if (score >= 35) return "D";
  return "F";
}

export function compositeFromPercentiles(p: EmployeeScoreBreakdown, weights: ScoringWeights = SCORING_WEIGHTS): number {
  const raw =
    p.workHours * weights.workHours +
    p.meetings * weights.meetings +
    p.emails * weights.emails +
    p.chat * weights.chat +
    p.docs * weights.docs;
  return Math.round(raw * 10) / 10;
}

export function computeEmployeeScores(
  inputs: EmployeeScoreInput[],
  weights: ScoringWeights = SCORING_WEIGHTS,
): EmployeeScoreRow[] {
  if (!inputs.length) return [];

  const emails = inputs.map((r) => r.emailsSent);
  const meetings = inputs.map((r) => r.meetingsCreated);
  const docs = inputs.map((r) => r.docsCreated);
  const chat = inputs.map((r) => r.chatMessagesSent);
  const hours = inputs.map((r) => r.workSeconds / 3600);

  const scored: EmployeeScoreRow[] = inputs.map((row) => {
    const workHours = row.workSeconds / 3600;
    const hoursPerDay = row.windowDays > 0 ? workHours / row.windowDays : 0;
    const percentile: EmployeeScoreBreakdown = {
      workHours: percentileRank(hours, workHours),
      meetings: percentileRank(meetings, row.meetingsCreated),
      emails: percentileRank(emails, row.emailsSent),
      chat: percentileRank(chat, row.chatMessagesSent),
      docs: percentileRank(docs, row.docsCreated),
    };
    const compositeScore = compositeFromPercentiles(percentile, weights);
    return {
      ...row,
      workHours: Math.round(workHours * 100) / 100,
      hoursPerDay: Math.round(hoursPerDay * 100) / 100,
      percentile,
      compositeScore,
      grade: scoreToGrade(compositeScore),
      rank: 0,
    };
  });

  scored.sort(
    (a, b) =>
      b.compositeScore - a.compositeScore ||
      b.workHours - a.workHours ||
      a.userEmail.localeCompare(b.userEmail),
  );
  scored.forEach((row, i) => {
    row.rank = i + 1;
  });
  return scored;
}

export const SCORING_RULES_SUMMARY = [
  "One scoring window applies to Google Workspace activity and Time Doctor hours.",
  "Time Doctor uses calendar dates derived from the same window (start date → end date, inclusive).",
  "Each metric is scored 0–100 as a percentile vs all users in the cohort (fair across scales).",
  `Composite = ${SCORING_WEIGHTS.workHours * 100}% work hours + ${SCORING_WEIGHTS.meetings * 100}% meetings + ${SCORING_WEIGHTS.emails * 100}% emails + ${SCORING_WEIGHTS.chat * 100}% chat + ${SCORING_WEIGHTS.docs * 100}% docs.`,
  "Grades: A ≥ 80, B ≥ 65, C ≥ 50, D ≥ 35, F < 35.",
] as const;
