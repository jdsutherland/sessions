// Data contract for `sessions wrapped` — a Spotify-Wrapped-style year in review.
// Assembled from two sources with different truths: the report pipeline's raw
// UsageEvent[] (full timestamps: durations, rhythm, model adoption) and the
// search index (message content: phrase censuses, mined vocabulary). Each stat
// notes its source so the two never silently disagree.

import type { ToolId } from '../report/types.ts';
import type { PricingWarning } from '../report/schema.ts';

export interface WrappedTotals {
  /** input + output + cacheWrite — same rule as `sessions report` (cacheRead excluded). */
  tokens: number;
  cacheReadTokens: number;
  costUSD: number;
  /** Distinct `${tool}|${sessionId}` over raw events — no cross-midnight double count. */
  sessions: number;
  messages: number;
  activeDays: number;
  longestStreak: { days: number; from: string; to: string } | null;
}

export interface WrappedRhythm {
  /** [weekday 0=Sun][hour 0-23] message counts, local tz. */
  heat: number[][];
  peakHour: number;
  peakWeekday: number;
  /** Distinct local dates with any event in hours 0-4. */
  nightsPastMidnight: number;
  /** The latest small-hours moment of the year (closest to 5 AM). */
  latestNight: { date: string; clock: string; weekday: number } | null;
}

export interface WrappedDay {
  date: string;
  tokens: number;
  messages: number;
}

export interface WrappedProject {
  name: string;
  tokens: number;
  costUSD: number;
  sessions: number;
  /** Share of total tokens, 0-1. */
  share: number;
}

export interface WrappedModel {
  id: string;
  label: string;
  messages: number;
  tokens: number;
  /** Share of total messages, 0-1. */
  share: number;
  firstSeen: string;
  /** First local date this model was the day's most-used — the adoption story. */
  firstTopDay: string | null;
}

export interface WrappedTool {
  id: ToolId;
  label: string;
  sessions: number;
  tokens: number;
  share: number;
}

export interface WrappedLongestSession {
  /** Longest continuous sitting (events ≤ 30 min apart), not wall-clock session span. */
  durationMs: number;
  /** Assistant replies within that sitting. */
  replies: number;
  date: string;
  project: string;
}

export interface WrappedSessionOfYear {
  title: string;
  project: string;
  date: string;
  messageCount: number;
  filesTouched: number;
  /** Closing text contains a PR/commit artifact (significance.ts). */
  shipped: boolean;
}

export interface PhraseStat {
  id: string;
  /** Messages containing the phrase (rows, not occurrences). */
  count: number;
  role: 'user' | 'assistant';
}

export interface WrappedContentStats {
  indexedSessions: number;
  phrases: PhraseStat[];
  monologue: { userAvg: number; assistantAvg: number; longestUser: number } | null;
  driveBys: { count: number; total: number } | null;
  abandoned: { name: string; sessions: number; lastSeen: string } | null;
  errors: { sessionsErrored: number; totalErrors: number; cursedWeekday: number | null; cursedCount: number } | null;
  topFiles: { name: string; sessions: number }[];
  topCommands: { name: string; sessions: number }[];
  /** Mined from genuine user prompts: distinctive vocabulary, not stopwords. */
  words: { word: string; count: number; sessions: number }[];
  /** Median raw message_count per engaged session (drive-bys excluded) — the persona depth axis. */
  depthMedian: number | null;
}

export interface FunStat {
  big: string;
  label: string;
  sub?: string;
}

/** A themed fun slide assembled from the highest-scoring candidates — only
 *  notable stats render, so nobody sees "0 times" filler. */
export interface FunCard {
  id: string;
  kicker: string;
  title: string;
  stats: FunStat[];
  footnote?: string;
  score: number;
}

export interface PersonaAxis {
  label: string;
  value: string;
  lean: string;
}

export interface WrappedPersona {
  name: string;
  tagline: string;
  axes: PersonaAxis[];
  flavor: string | null;
}

/** Extra slides injected via --extras — the hook for agent-authored roasts. */
export interface WrappedExtra {
  title?: string;
  headline: string;
  subline?: string;
  footnote?: string;
}

export interface WrappedData {
  generator: 'sessions';
  version: 1;
  generatedAt: string;
  year: number;
  period: { from: string; to: string };
  /** First event's local date — disclosed when transcript retention truncates the year. */
  dataBegins: string | null;
  tz: string;
  warnings: PricingWarning[];
  totals: WrappedTotals;
  rhythm: WrappedRhythm;
  daily: WrappedDay[];
  biggestDay: (WrappedDay & { medianTokens: number }) | null;
  /** Longest run of consecutive silent days between two active days. */
  longestGap: { days: number; from: string; to: string } | null;
  projects: WrappedProject[];
  models: WrappedModel[];
  /** Distinct model ids seen all year — the top-5 list is the cast, this is the audition count. */
  modelsTried: number;
  tools: WrappedTool[];
  cacheHitRate: number | null;
  longestSession: WrappedLongestSession | null;
  sessionOfYear: WrappedSessionOfYear | null;
  content: WrappedContentStats | null;
  fun: FunCard[];
  wordOfYear: { word: string; count: number; sessions: number; runnersUp: string[] } | null;
  persona: WrappedPersona | null;
  extras: WrappedExtra[];
}
