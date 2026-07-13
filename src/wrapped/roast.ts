// The --roast path: ask an installed agent CLI to write a few bespoke roast
// slides from the already-computed stats, then run its output through the same
// validation as --extras. This is the one non-deterministic, model-authored
// seam in wrapped — deliberately opt-in, deliberately fail-open (any failure
// drops the roast and the page still renders), and deliberately fed STATS ONLY
// (no raw message text), with every slide stamped as model-authored so it can
// never impersonate a computed stat (the "Pink Pilates Princess" lesson).

import type { WrappedData, WrappedExtra } from './types.ts';
import { coerceExtras } from './extras.ts';

export type RoastToolId = 'claude' | 'codex' | 'pi';

interface RoastTool {
  id: RoastToolId;
  label: string;
  bin: string;
  /** argv (after bin) that runs the CLI non-interactively with `prompt`. */
  args: (prompt: string) => string[];
}

// Preference order when --roast-with isn't given: Claude first (best taste for
// this), then Codex, then Pi. Each runs its own headless/exec mode.
const ROAST_TOOLS: RoastTool[] = [
  { id: 'claude', label: 'Claude', bin: 'claude', args: (p) => ['-p', p] },
  { id: 'codex', label: 'Codex', bin: 'codex', args: (p) => ['exec', p] },
  { id: 'pi', label: 'Pi', bin: 'pi', args: (p) => ['-p', p] },
];

/** First installed roast tool (honoring `preferred`), or null if none on PATH. */
export function detectRoastTool(preferred?: RoastToolId): RoastTool | null {
  const ordered = preferred ? [...ROAST_TOOLS].sort((a) => (a.id === preferred ? -1 : 1)) : ROAST_TOOLS;
  for (const t of ordered) {
    if (preferred && t.id !== preferred) continue;
    if (Bun.which(t.bin)) return t;
  }
  return null;
}

// A compact, STATS-ONLY digest — counts, names, and already-computed stats that
// already appear on the page. Deliberately excludes free-text (session titles,
// message snippets): the model gets numbers to riff on, never transcript prose.
function roastDigest(d: WrappedData): Record<string, unknown> {
  return {
    year: d.year,
    tokens: d.totals.tokens,
    costUSD: Math.round(d.totals.costUSD),
    sessions: d.totals.sessions,
    activeDays: d.totals.activeDays,
    longestStreakDays: d.totals.longestStreak?.days ?? 0,
    peakHour: d.rhythm.peakHour,
    nightsPastMidnight: d.rhythm.nightsPastMidnight,
    topProjects: d.projects.map((p) => ({ name: p.name, sharePct: Math.round(p.share * 100) })),
    topModels: d.models.map((m) => m.label),
    persona: d.persona ? { name: d.persona.name, axes: d.persona.axes.map((a) => `${a.label}: ${a.lean}`) } : null,
    wordOfYear: d.wordOfYear ? { word: d.wordOfYear.word, count: d.wordOfYear.count } : null,
    phraseCounts: Object.fromEntries((d.content?.phrases ?? []).map((p) => [p.id, p.count])),
    driveBySessions: d.content?.driveBys?.count ?? null,
    abandonedProject: d.content?.abandoned ? d.content.abandoned.name : null,
    errors: d.content?.errors?.totalErrors ?? null,
    topCommands: (d.content?.topCommands ?? []).map((c) => c.name),
  };
}

export function buildRoastPrompt(d: WrappedData): string {
  const digest = JSON.stringify(roastDigest(d), null, 2);
  return `You are the closer at a roast battle, and the target is someone's year of using AI coding agents. Below are their stats (numbers only — no message content).

Write 2-4 short, EDGY roast slides. Be genuinely cutting — sharp, dark, deadpan, a little mean. Land real punches at the absurdity in their numbers; twist the knife. Dry wit and savage one-liners over gentle ribbing. Mild profanity is fine if it lands. The one rule: roast their WORK and these HABITS (the numbers), never protected traits or anything hateful — this is affectionate underneath, like a friend who knows exactly where it hurts. Reference specific figures. No emoji.

Output ONLY a JSON array, no prose around it, matching exactly this schema:
[{"title": "short kicker, <=6 words", "headline": "the punchline, <=110 chars", "subline": "optional extra line, <=180 chars"}]

Their stats:
${digest}`;
}

/** Extract the first JSON array from CLI output (which may wrap it in prose or
 *  a ```json fence). Greedy to the last ] so nested objects survive. */
export function extractJsonArray(out: string): unknown {
  const stripped = out.replace(/```json/gi, '').replace(/```/g, '');
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

export type RoastRunner = (tool: RoastTool, prompt: string, timeoutMs: number) => Promise<string>;

// Default runner: spawn the CLI, capture stdout, hard-kill on timeout. The child
// rides the user's own auth/subscription — wrapped never handles credentials.
const spawnRunner: RoastRunner = async (tool, prompt, timeoutMs) => {
  const proc = Bun.spawn([tool.bin, ...tool.args(prompt)], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  } finally {
    clearTimeout(timer);
  }
};

export interface RoastOptions {
  preferred?: RoastToolId;
  timeoutMs?: number;
  runner?: RoastRunner;
  /** Sink for the one-line status/warning; defaults to stderr. */
  log?: (msg: string) => void;
}

/** Generate roast slides, or [] on any failure (no tool, timeout, unparseable
 *  output). Never throws — the roast is sugar, the page must survive without it. */
export async function runRoast(d: WrappedData, opts: RoastOptions = {}): Promise<WrappedExtra[]> {
  const log = opts.log ?? ((m: string) => process.stderr.write(m + '\n'));
  const tool = detectRoastTool(opts.preferred);
  if (!tool) {
    log(
      opts.preferred
        ? `warning: --roast-with ${opts.preferred}: '${opts.preferred}' not found on PATH; skipping roast`
        : 'warning: --roast: no agent CLI (claude, codex, pi) found on PATH; skipping roast',
    );
    return [];
  }

  log(`roasting your year with ${tool.label}… (this calls ${tool.bin}; may take a moment)`);
  const runner = opts.runner ?? spawnRunner;
  let out: string;
  try {
    out = await runner(tool, buildRoastPrompt(d), opts.timeoutMs ?? 120_000);
  } catch {
    log(`warning: --roast: ${tool.label} failed to run; skipping roast`);
    return [];
  }

  const slides = coerceExtras(extractJsonArray(out));
  if (slides.length === 0) {
    log(`warning: --roast: ${tool.label} returned nothing usable; skipping roast`);
    return [];
  }
  // Force the provenance footnote on every slide so a model-written line can
  // never read as a counted stat, regardless of what the model returned.
  return slides.map((s) => ({ ...s, footnote: `improvised by ${tool.label} from your stats` }));
}
