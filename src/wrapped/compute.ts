// Event-pass aggregations for wrapped — everything aggregate() doesn't compute
// but raw UsageEvent timestamps make possible: session durations, small-hours
// census, the weekday×hour heatmap, model adoption dates, and cache efficiency.
// Pure and deterministic; tz-sensitive bucketing goes through the same
// localDate/localHour helpers as the report so the two always reconcile.

import type { UsageEvent } from '../report/parsers/types.ts';
import { localDate, localHour } from '../report/parsers/util.ts';
import { resolveProject } from '../report/project.ts';
import { isRealModel, canonicalModel } from './model-name.ts';
import type { WrappedLongestSession, WrappedRhythm } from './types.ts';

export interface ModelFirsts {
  firstSeen: string;
  firstTopDay: string | null;
}

export interface WrappedEventStats {
  distinctSessions: number;
  rhythm: WrappedRhythm;
  cacheReadTokens: number;
  /** cacheRead / (input + cacheRead), or null when nothing was cacheable. */
  cacheHitRate: number | null;
  longestSession: WrappedLongestSession | null;
  /** Median assistant replies per session — persona depth fallback when no index. */
  medianReplies: number;
  /** Distinct sessions per tool / resolved project — aggregate's per-day sums
   *  double-count cross-midnight sessions, so wrapped never uses them. */
  sessionsByTool: Map<string, number>;
  sessionsByProject: Map<string, number>;
  /** Keyed by canonical display name (snapshots/aliases merged; sentinels excluded),
   *  so `.size` is the distinct-models-tried count and adoption dates pool variants. */
  modelFirsts: Map<string, ModelFirsts>;
  /** Share of assistant replies in local hours 22:00–05:59 (22, 23, and 0–5) —
   *  the persona "clock" axis. Broader than nightsPastMidnight's deep-night 0–4. */
  nightShare: number;
}

/** Weekday (0=Sun) of a local YYYY-MM-DD without tz drift. */
export function weekdayOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

const clockFmtCache = new Map<string, Intl.DateTimeFormat>();
function clockFmt(tz: string): Intl.DateTimeFormat {
  let f = clockFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
    clockFmtCache.set(tz, f);
  }
  return f;
}

function localClock(isoUtc: string, tz: string): string {
  return clockFmt(tz).format(new Date(isoUtc)).replace(/\s/g, ' ');
}

function localMinute(isoUtc: string, tz: string): number {
  const m = clockFmt(tz)
    .formatToParts(new Date(isoUtc))
    .find((p) => p.type === 'minute')?.value;
  return Number(m ?? '0');
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function computeEventStats(events: UsageEvent[], tz: string): WrappedEventStats {
  const heat: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const nightDates = new Set<string>();
  // Latest small-hours moment = max clock time within hours 0-4 (closest to 5 AM).
  let latestNight: { date: string; clock: string; weekday: number; key: number } | null = null;
  let cacheRead = 0;
  let cacheableInput = 0;
  const sessions = new Map<string, { tool: string; timestamps: string[]; replies: number; project?: string }>();
  const dayModel = new Map<string, Map<string, number>>();
  const modelFirsts = new Map<string, ModelFirsts>();
  let nightMsgs = 0;

  for (const e of events) {
    const date = localDate(e.timestamp, tz);
    const hour = localHour(e.timestamp, tz);
    const wd = weekdayOf(date);
    heat[wd]![hour] = heat[wd]![hour]! + 1;
    if (hour >= 22 || hour <= 5) nightMsgs++;

    if (hour <= 4) {
      nightDates.add(date);
      const key = hour * 60 + localMinute(e.timestamp, tz);
      if (!latestNight || key > latestNight.key) {
        latestNight = { date, clock: localClock(e.timestamp, tz), weekday: wd, key };
      }
    }

    cacheRead += e.tokens.cacheRead;
    cacheableInput += e.tokens.input + e.tokens.cacheRead;

    const sk = `${e.tool}|${e.sessionId}`;
    const s = sessions.get(sk);
    if (!s) {
      sessions.set(sk, { tool: e.tool, timestamps: [e.timestamp], replies: 1, project: e.projectPath });
    } else {
      s.timestamps.push(e.timestamp);
      s.replies++;
      if (!s.project) s.project = e.projectPath;
    }

    // '<synthetic>' and other sentinel ids are turns with no real model — they
    // must never win a day's adoption race or be counted as a model "tried".
    // Track by canonical name so dated snapshots / provider aliases of one model
    // pool their votes (otherwise a split model loses the daily race to an
    // unsplit one and never earns a firstTopDay), and modelFirsts is keyed the
    // same way the cast list and modelsTried count it.
    if (isRealModel(e.model)) {
      const canon = canonicalModel(e.model);
      let models = dayModel.get(date);
      if (!models) {
        models = new Map();
        dayModel.set(date, models);
      }
      models.set(canon, (models.get(canon) ?? 0) + 1);

      const first = modelFirsts.get(canon);
      if (!first) {
        modelFirsts.set(canon, { firstSeen: date, firstTopDay: null });
      } else if (date < first.firstSeen) {
        first.firstSeen = date;
      }
    }
  }

  // Adoption dates: walk days in order, record the first day each model topped.
  for (const date of [...dayModel.keys()].sort()) {
    let top: string | null = null;
    let topCount = -1;
    for (const [model, count] of dayModel.get(date)!) {
      if (count > topCount || (count === topCount && top !== null && model < top)) {
        top = model;
        topCount = count;
      }
    }
    if (top !== null) {
      const first = modelFirsts.get(top)!;
      if (first.firstTopDay === null) first.firstTopDay = date;
    }
  }

  // Longest *sitting*, not longest session id: resumed sessions span days or
  // weeks, so a session's events are split into continuous runs (gap ≤ 30 min)
  // and the longest run wins. 92 replies spread over 27 days is not a sitting.
  const SITTING_GAP_MS = 30 * 60_000;
  let longest: WrappedLongestSession | null = null;
  for (const s of sessions.values()) {
    const ts = s.timestamps.map((t) => Date.parse(t)).sort((a, b) => a - b);
    let runStart = 0;
    for (let i = 1; i <= ts.length; i++) {
      if (i === ts.length || ts[i]! - ts[i - 1]! > SITTING_GAP_MS) {
        const durationMs = ts[i - 1]! - ts[runStart]!;
        if (!longest || durationMs > longest.durationMs) {
          longest = {
            durationMs,
            replies: i - runStart,
            date: localDate(new Date(ts[runStart]!).toISOString(), tz),
            project: resolveProject(s.project),
          };
        }
        runStart = i;
      }
    }
  }

  // Each peak is its own marginal — busiest hour summed over days, busiest day
  // summed over hours — so "10 AM on Thursdays" makes two independently true
  // claims. The heatmap outlines its own argmax cell, which may differ.
  const hourTotals = Array.from({ length: 24 }, () => 0);
  const weekdayTotals = Array.from({ length: 7 }, () => 0);
  for (let wd = 0; wd < 7; wd++) {
    for (let h = 0; h < 24; h++) {
      const v = heat[wd]![h]!;
      hourTotals[h] = hourTotals[h]! + v;
      weekdayTotals[wd] = weekdayTotals[wd]! + v;
    }
  }
  const peakHour = hourTotals.indexOf(Math.max(...hourTotals));
  const peakWeekday = weekdayTotals.indexOf(Math.max(...weekdayTotals));

  const replyCounts = [...sessions.values()].map((s) => s.replies).sort((a, b) => a - b);

  const sessionsByTool = new Map<string, number>();
  const sessionsByProject = new Map<string, number>();
  for (const s of sessions.values()) {
    sessionsByTool.set(s.tool, (sessionsByTool.get(s.tool) ?? 0) + 1);
    const proj = resolveProject(s.project);
    sessionsByProject.set(proj, (sessionsByProject.get(proj) ?? 0) + 1);
  }

  return {
    distinctSessions: sessions.size,
    rhythm: {
      heat,
      peakHour,
      peakWeekday,
      nightsPastMidnight: nightDates.size,
      latestNight: latestNight
        ? { date: latestNight.date, clock: latestNight.clock, weekday: latestNight.weekday }
        : null,
    },
    cacheReadTokens: cacheRead,
    cacheHitRate: cacheableInput > 0 ? cacheRead / cacheableInput : null,
    longestSession: longest,
    medianReplies: median(replyCounts),
    sessionsByTool,
    sessionsByProject,
    modelFirsts,
    nightShare: events.length > 0 ? nightMsgs / events.length : 0,
  };
}

/** Longest run of silent days strictly between two active dates — the
 *  disappearance. Edges of the period don't count: silence before the first
 *  session or after the last one is "hadn't started" / "hasn't happened yet". */
export function longestGapRange(activeDates: string[]): { days: number; from: string; to: string } | null {
  const dates = [...new Set(activeDates)].sort();
  let best: { days: number; from: string; to: string } | null = null;
  for (let i = 1; i < dates.length; i++) {
    const prev = Date.parse(dates[i - 1]!);
    const gap = (Date.parse(dates[i]!) - prev) / 86_400_000 - 1;
    if (gap > (best?.days ?? 0)) {
      best = {
        days: gap,
        from: new Date(prev + 86_400_000).toISOString().slice(0, 10),
        to: new Date(prev + gap * 86_400_000).toISOString().slice(0, 10),
      };
    }
  }
  return best;
}

/** Longest run of consecutive active dates, with its range. */
export function longestStreakRange(activeDates: string[]): { days: number; from: string; to: string } | null {
  const dates = [...new Set(activeDates)].sort();
  if (dates.length === 0) return null;
  let best: { days: number; from: string; to: string } = { days: 1, from: dates[0]!, to: dates[0]! };
  let runFrom = dates[0]!;
  let runDays = 1;
  for (let i = 1; i < dates.length; i++) {
    const prev = dates[i - 1]!;
    const cur = dates[i]!;
    const gap = (Date.parse(cur) - Date.parse(prev)) / 86_400_000;
    if (gap === 1) {
      runDays++;
    } else {
      runFrom = cur;
      runDays = 1;
    }
    if (runDays > best.days) best = { days: runDays, from: runFrom, to: cur };
  }
  return best;
}
