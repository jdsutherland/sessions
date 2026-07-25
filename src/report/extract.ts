import { stat } from 'node:fs/promises';
import type { UsageEvent } from './parsers/types.ts';
import type { ToolId } from './types.ts';
import { parseClaudeCodeFile, dedupeClaude } from './parsers/claude-code.ts';
import { parsePiFile } from './parsers/pi.ts';
import { parseCodexFile } from './parsers/codex.ts';
import { parseOpencode } from './parsers/opencode.ts';
import { walkJsonl } from './parsers/util.ts';
import { openEventCache, type EventCache } from './event-cache.ts';
import { getOpencodeDbPath } from '../opencode.ts';
import { getClaudeDir, getPiDir, getCodexDir } from '../paths.ts';

export interface ReportRoots {
  claudeCode: string;
  pi: string;
  codex: string;
  /** OpenCode's SQLite DB path (not a directory) — its sessions live in one DB. Optional so
   *  callers that predate OpenCode support (and tests) need not supply it. */
  opencode?: string;
}

/**
 * The same roots the search index reads, resolved the same way. These used to be spelled
 * from a raw homedir(), so the SESSIONS_* overrides every other surface honors did nothing
 * here: an MCP server pointed at a sandboxed home still read the operator's real corpus.
 */
export function defaultRoots(): ReportRoots {
  return {
    claudeCode: getClaudeDir(),
    pi: getPiDir(),
    codex: getCodexDir(),
    opencode: getOpencodeDbPath(),
  };
}

/** A transcript, with the stat the mtime prune reads. */
export interface SourceFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Per-file entry points, one per JSONL tool. OpenCode is not here — its sessions live in
 *  one SQLite DB, so it has no files to walk, prune, or stat. */
const FILE_PARSERS: Record<'claude-code' | 'pi' | 'codex', (path: string) => Promise<UsageEvent[]>> = {
  'claude-code': parseClaudeCodeFile,
  pi: parsePiFile,
  codex: parseCodexFile,
};

export interface GatherOptions {
  /** Where to read from. Defaults to the real per-tool roots; supplying it is the test seam. */
  roots?: ReportRoots;
  tools?: Set<ToolId>;
  /** Skip transcripts last written before this epoch-ms instant. See mtimeFloor. */
  since?: number;
  /**
   * Read and write parsed events through the on-disk cache (src/report/event-cache.ts).
   * Defaults on for the real roots and off for supplied ones: the cache lives in the shared
   * cache dir and holds a projection of the user's corpus, which a temp fixture is not.
   */
  cache?: boolean;
}

// The widest UTC offset is ±14h, and a local calendar day is 24h wide, so a window that
// opens on a local date can reach 38h back from that date's midnight UTC. Anything older
// is slack against a filesystem clock that runs behind or an mtime carried over by `cp -p`.
const PRUNE_SLACK_MS = 38 * 60 * 60 * 1000;

/**
 * The mtime floor for a report window opening on local date `startDate` (YYYY-MM-DD).
 *
 * Transcripts are append-only, so a file's mtime is at or after its newest event: one last
 * written before the window opened cannot hold an event inside it and never has to be read.
 * That is what keeps a metrics call proportional to the window instead of to all history.
 *
 * @returns the floor, or undefined for an unparseable date — an unreadable bound must widen
 *   the scan, never silently empty it.
 */
export function mtimeFloor(startDate: string): number | undefined {
  const midnightUtc = Date.parse(`${startDate}T00:00:00Z`);
  return Number.isNaN(midnightUtc) ? undefined : midnightUtc - PRUNE_SLACK_MS;
}

/** Every .jsonl under `root` that could hold an event at or after `since`, with its stat. */
export async function sourceFiles(root: string, since?: number): Promise<SourceFile[]> {
  const paths: string[] = [];
  for await (const path of walkJsonl(root)) paths.push(path);
  const stats = await Promise.all(
    paths.map(async (path): Promise<SourceFile | null> => {
      try {
        const s = await stat(path);
        return since !== undefined && s.mtimeMs < since ? null : { path, mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        // Vanished between the walk and the stat (an active harness rotating files).
        return null;
      }
    }),
  );
  return stats.filter((s): s is SourceFile => s !== null);
}

async function gatherTool(
  tool: 'claude-code' | 'pi' | 'codex',
  root: string,
  since: number | undefined,
  cache: EventCache | null,
  seen: string[],
): Promise<UsageEvent[]> {
  const files = await sourceFiles(root, since);
  const parse = FILE_PARSERS[tool];
  const events: UsageEvent[] = [];
  for (const file of files) {
    seen.push(file.path);
    const cached = cache?.get(file.path, file.mtimeMs, file.size);
    if (cached) {
      events.push(...cached);
      continue;
    }
    const parsed = await parse(file.path);
    cache?.put(file.path, file.mtimeMs, file.size, parsed);
    events.push(...parsed);
  }
  return events;
}

export async function gatherEvents(opts: GatherOptions = {}): Promise<UsageEvent[]> {
  const roots = opts.roots ?? defaultRoots();
  const want = (t: ToolId): boolean => !opts.tools || opts.tools.has(t);
  const cache = (opts.cache ?? !opts.roots) ? openEventCache() : null;
  // Every transcript this scan looked at. Only a scan of every root with no floor and no
  // tool filter has seen them all, and only that scan may conclude the rest are gone.
  const seen: string[] = [];
  const full = opts.since === undefined && !opts.tools;

  const tasks: Promise<UsageEvent[]>[] = [];
  // Claude's dedupe spans files, so it runs over the tool's whole result — not per file,
  // and not over the other tools' events, which carry no dedupeKey.
  if (want('claude-code')) {
    tasks.push(gatherTool('claude-code', roots.claudeCode, opts.since, cache, seen).then(dedupeClaude));
  }
  if (want('pi')) tasks.push(gatherTool('pi', roots.pi, opts.since, cache, seen));
  if (want('codex')) tasks.push(gatherTool('codex', roots.codex, opts.since, cache, seen));
  // OpenCode reads one SQLite DB rather than a tree of files, so there is nothing to key a
  // per-file cache on; its whole-DB query is milliseconds anyway.
  if (want('opencode') && roots.opencode) tasks.push(parseOpencode(roots.opencode));

  try {
    const results = await Promise.all(tasks);
    return results.flat();
  } finally {
    cache?.close(full ? seen : undefined);
  }
}
