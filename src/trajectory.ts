import { existsSync } from 'node:fs';
import { extractSessionMetadata } from './parser';
import { parseSession } from './record';
import { resolveSessionFile, searchSessions } from './cache';
import { readSessionLines, toolForSession } from './session-io';
import { getRepoRoot } from './cli';
import { writeStdoutFully } from './stdout';
import { type Tool } from './types';

// trajectory-v1 (Letta) as a LOSSY PROJECTION of the record — never a parse target.
// The types below are hand-written from schema/trajectory-v1.schema.json so nothing
// the compiled binary carries depends on @letta-ai/trajectory; the package is a
// devDependency oracle only (see src/trajectory.differential.test.ts).
//
// What the record has and trajectory-v1 does not: `index` (the msg_index invariant),
// `genuine` (injection/compaction semantics), `usage`, per-result `isError`, and
// structured tool arguments. What trajectory-v1 demands and the record cannot always
// supply is counted in TrajectoryOmissions rather than fabricated.

export interface TrajectoryMeta {
  role: 'meta';
  source: string;
  cwd?: string;
  git_branch?: string;
  model?: string;
}

export interface TrajectoryUser {
  role: 'user';
  content: string;
  timestamp: string;
}

export interface TrajectoryReasoning {
  role: 'reasoning';
  content: string;
  timestamp: string;
}

export interface TrajectoryAssistant {
  role: 'assistant';
  content: string;
  timestamp: string;
}

export interface TrajectoryToolCall {
  id: string;
  name: string;
  /** A STRING in trajectory-v1; the record holds structured args, so this is their JSON. */
  args: string;
}

/** An assistant record carrying calls must have content:null — prose splits off into its own record. */
export interface TrajectoryAssistantToolCall {
  role: 'assistant';
  content: null;
  tool_calls: TrajectoryToolCall[];
  timestamp: string;
}

export interface TrajectoryTool {
  role: 'tool';
  tool_call_id: string;
  content: string;
  timestamp: string;
}

export type TrajectoryRecord =
  | TrajectoryMeta
  | TrajectoryUser
  | TrajectoryReasoning
  | TrajectoryAssistant
  | TrajectoryAssistantToolCall
  | TrajectoryTool;

/** Records the projection could not carry, counted so the loss is reported, never silent. */
export interface TrajectoryOmissions {
  /** Harness injections on a user-role line: not the human speaking (record.genuine === false). */
  injectedUser: number;
  /** trajectory-v1 requires an ISO-8601 timestamp on every non-meta record; the log had none. */
  noTimestamp: number;
  /** A tool result with no call to join back to (Pi's bashExecution channel, dropped calls). */
  orphanToolResult: number;
}

/**
 * A role trajectory-v1 requires at least one of. The schema does not say so — this is the
 * reference validator's semantic layer (validateTranscript: "Transcript must contain at
 * least one user record") — and every record can satisfy the schema while the document
 * still fails it. Both cases are ordinary, not corrupt: a Claude session driven entirely
 * by the harness (a subagent journal, a review run) has no genuine user turn to project,
 * and a Codex rollout abandoned before the model replied has no assistant turn at all.
 */
export type RequiredRole = 'user' | 'assistant';

export interface TrajectoryExport {
  records: TrajectoryRecord[];
  omissions: TrajectoryOmissions;
  /** Required roles this document has none of. Non-empty means no consumer can read it. */
  missing: RequiredRole[];
}

/**
 * meta.source is free-form in the schema, so we emit the ecosystem's id where the tool
 * has one and our own name otherwise. The reference normalizer files Pi transcripts
 * under `openclaw` — the other name for that format — which is not what wrote them.
 */
const SOURCE_ID: Record<Tool, string> = {
  claude: 'claude-code',
  codex: 'codex',
  pi: 'pi',
  opencode: 'opencode',
};

/** The schema's timestamp pattern. A record whose timestamp fails it is omitted, not repaired. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * The record, projected onto trajectory-v1.
 *
 * Divergences, all deliberate and all counted:
 *   - Injected user turns (AGENTS.md preambles, <environment_context>, task
 *     notifications) are dropped. They arrive on a user-role line but are not the
 *     human speaking, and the record already knows which is which.
 *   - Reasoning is emitted only where the harness wrote text. Claude keeps the
 *     signature and throws the thinking away on 12,768 of 12,778 records, so
 *     parseSession never makes a reasoning record for it and none is invented here.
 *   - One assistant record carries all of a turn's calls; the reference normalizer
 *     emits one record per call. Both satisfy the schema.
 *   - A call the harness gave no id (Codex web_search_call) gets a synthetic one,
 *     because trajectory-v1 requires a non-empty id. Nothing joins to it, and a
 *     result that cannot name its call is omitted rather than guessed at.
 */
export function toTrajectory(lines: string[], tool: Tool): TrajectoryExport {
  const parsed = parseSession(lines, tool);
  const meta = extractSessionMetadata(lines, tool);
  const model = parsed.find((r) => r.model)?.model;

  const head: TrajectoryMeta = { role: 'meta', source: SOURCE_ID[tool] };
  if (meta.cwd) head.cwd = meta.cwd;
  if (meta.branch) head.git_branch = meta.branch;
  if (model) head.model = model;

  const records: TrajectoryRecord[] = [head];
  const omissions: TrajectoryOmissions = { injectedUser: 0, noTimestamp: 0, orphanToolResult: 0 };
  // Ids of calls that actually reached the output — the only ids a result may name.
  const emitted = new Set<string>();
  let synthetic = 0;

  for (const r of parsed) {
    if (r.role === 'user' && !r.genuine) {
      omissions.injectedUser++;
      continue;
    }
    if (!ISO_8601.test(r.timestamp)) {
      omissions.noTimestamp++;
      continue;
    }
    switch (r.role) {
      case 'user':
        records.push({ role: 'user', content: r.text, timestamp: r.timestamp });
        break;
      case 'reasoning':
        records.push({ role: 'reasoning', content: r.text, timestamp: r.timestamp });
        break;
      case 'tool': {
        const id = r.toolCallId ?? '';
        if (!emitted.has(id)) {
          omissions.orphanToolResult++;
          break;
        }
        records.push({ role: 'tool', tool_call_id: id, content: r.text, timestamp: r.timestamp });
        break;
      }
      case 'assistant': {
        // Prose and calls are two records: the schema forbids an assistant carrying both.
        if (r.text.trim()) records.push({ role: 'assistant', content: r.text, timestamp: r.timestamp });
        if (r.toolCalls.length === 0) break;
        const calls = r.toolCalls.map((c) => {
          const id = c.id || `sessions-call-${++synthetic}`;
          emitted.add(id);
          return { id, name: c.name || 'unknown', args: argsString(c.args) };
        });
        records.push({ role: 'assistant', content: null, tool_calls: calls, timestamp: r.timestamp });
        break;
      }
    }
  }

  // Checked over what was emitted, not over what the log held: dropping every injected user
  // turn is what leaves a harness-only session with no user record.
  const roles = new Set(records.map((r) => r.role));
  const missing = (['user', 'assistant'] as const).filter((role) => !roles.has(role));
  return { records, omissions, missing };
}

/** trajectory-v1 wants the arguments as a string; the record holds them parsed. */
function argsString(args: unknown): string {
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    // Cyclic or otherwise unserializable input: an empty object is honest, "{…}" is not.
    return '{}';
  }
}

// ——— CLI: `sessions export` ———

export interface ExportArgs {
  /** A session JSONL file path, or an indexed session id. Empty when --query is used. */
  target: string;
  query: string;
  tool: Tool | '';
  here: boolean;
  limit: number;
  strict: boolean;
}

const VALID_TOOLS = new Set<string>(['claude', 'codex', 'pi', 'opencode']);

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function help(): never {
  process.stderr.write(`sessions export — sessions as trajectory-v1 documents

Writes one trajectory-v1 JSON document per line (JSONL), so a ranked selection
of sessions streams as one payload. With --query the selection is the point:
the same ranking \`sessions <query>\` uses, with automated and throwaway
sessions already filtered out.

trajectory-v1 is a lossy projection of what sessions holds. Dropped on the way
out, and counted on stderr: harness-injected user turns (not the human
speaking), records the log gave no timestamp, and tool results with no call to
join back to. Reasoning appears only where the harness wrote text — Claude
keeps the signature and discards the thinking, so its trajectories carry none.

A whole session is skipped when the projection leaves it without a user record
or without an assistant record — a trajectory-v1 document needs both, so a
harness-only run (every user turn injected) or a rollout with no reply has
nothing a reader could consume.

Usage:
  sessions export <file-path>            Export one session JSONL file
  sessions export <session-id>           Resolve an indexed session id
  sessions export --query "<text>"       Export the top-ranked matches

Options:
  --query <text>   Export the sessions matching this query, best first
  --format <fmt>   Output format (only \`trajectory\` today; the default)
  --tool <name>    With --query: claude, codex, pi, opencode
  --here           With --query: scope to the current git repo
  --limit <n>      With --query: how many sessions to export (default 10)
  --strict         Exit non-zero if a session was skipped, or if any record was
                   dropped for a missing timestamp or an unjoinable tool result
                   (injected turns are a projection choice, not a gap, and
                   never fail --strict on their own)
  -h, --help       Show this help
`);
  process.exit(0);
}

export function parseExportArgs(argv: string[]): ExportArgs {
  const args: ExportArgs = { target: '', query: '', tool: '', here: false, limit: 10, strict: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    switch (a) {
      case '-h':
      case '--help':
        help();
      case '--query':
        args.query = argv[++i] ?? die('--query requires text');
        break;
      case '--format': {
        const v = argv[++i];
        if (v !== 'trajectory') die('--format must be trajectory');
        break;
      }
      case '--tool': {
        const v = argv[++i] ?? '';
        if (!VALID_TOOLS.has(v)) die('--tool requires one of: claude, codex, pi, opencode');
        args.tool = v as Tool;
        break;
      }
      case '--here':
        args.here = true;
        break;
      case '--limit': {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v <= 0) die('--limit must be a positive integer');
        args.limit = v;
        break;
      }
      case '--strict':
        args.strict = true;
        break;
      default:
        if (a.startsWith('-')) die(`unknown option: ${a}`);
        else if (args.target) die('expected exactly one <session> argument');
        else args.target = a;
    }
    i++;
  }
  if (!args.target && !args.query) die('usage: sessions export <file-path | session-id> | --query <text>');
  if (args.target && args.query) die('pass a session or --query, not both');
  return args;
}

/** Resolve one target the way `sessions digest` does: a path first, an indexed id second. */
async function resolveTarget(target: string): Promise<string> {
  if (readSessionLines(target).length > 0) return target;
  if (existsSync(target)) die(`could not read ${target}`);
  const resolved = await resolveSessionFile(target);
  if (!resolved) die(`no session matching ${target} — try \`sessions <query>\` to find it`);
  return resolved;
}

/** A selection, projected: the documents to write, what they dropped, and what could not
 *  become a document at all. Separated from runExport so the skipping is testable without
 *  a process, an index, or a ranked query. */
export interface ExportBatch {
  /** One serialized trajectory-v1 document per exportable session. */
  documents: string[];
  omissions: TrajectoryOmissions;
  /** Sessions left out because trajectory-v1 has no valid document for them. */
  skipped: number;
  /** Why, tallied by reason rather than by session — one session can be missing both. */
  noRole: Record<RequiredRole, number>;
  /** Selected paths that read back as nothing. */
  unreadable: string[];
}

export function projectSessions(paths: string[]): ExportBatch {
  const batch: ExportBatch = {
    documents: [],
    omissions: { injectedUser: 0, noTimestamp: 0, orphanToolResult: 0 },
    skipped: 0,
    noRole: { user: 0, assistant: 0 },
    unreadable: [],
  };
  for (const path of paths) {
    const lines = readSessionLines(path);
    if (lines.length === 0) {
      batch.unreadable.push(path);
      continue;
    }
    const { records, omissions, missing } = toTrajectory(lines, toolForSession(path, lines));
    // A document the reference validator rejects is not an export. Its own omissions go
    // uncounted with it: nothing of this session reached the output for them to describe.
    if (missing.length > 0) {
      for (const role of missing) batch.noRole[role]++;
      batch.skipped++;
      continue;
    }
    batch.omissions.injectedUser += omissions.injectedUser;
    batch.omissions.noTimestamp += omissions.noTimestamp;
    batch.omissions.orphanToolResult += omissions.orphanToolResult;
    batch.documents.push(JSON.stringify(records));
  }
  return batch;
}

/** `2 with no user record, 1 with no assistant record` — the reasons, in a fixed order. */
function skipReasons(noRole: Record<RequiredRole, number>): string {
  return [
    noRole.user && `${noRole.user} with no user record`,
    noRole.assistant && `${noRole.assistant} with no assistant record`,
  ]
    .filter((s): s is string => typeof s === 'string')
    .join(', ');
}

export async function runExport(args: ExportArgs): Promise<void> {
  const paths = args.query
    ? (
        await searchSessions(args.query, {
          tool: args.tool,
          project: getRepoRoot(args.here),
          limit: args.limit,
        })
      ).map((r) => r.filePath)
    : [await resolveTarget(args.target)];

  const { documents, omissions, skipped, noRole, unreadable } = projectSessions(paths);
  for (const path of unreadable) process.stderr.write(`warning: could not read ${path}\n`);

  if (documents.length === 0) {
    die(skipped > 0 ? `no exportable sessions — ${skipReasons(noRole)}` : 'no sessions to export');
  }
  await writeStdoutFully(documents.join('\n') + '\n');

  const dropped = [
    omissions.injectedUser && `${omissions.injectedUser} injected user turn(s)`,
    omissions.noTimestamp && `${omissions.noTimestamp} record(s) with no timestamp`,
    omissions.orphanToolResult && `${omissions.orphanToolResult} unjoinable tool result(s)`,
  ].filter((s): s is string => typeof s === 'string');
  process.stderr.write(
    `exported ${documents.length} session(s)` +
      (skipped ? `; skipped ${skipped} unrepresentable (${skipReasons(noRole)})` : '') +
      (dropped.length ? `; omitted ${dropped.join(', ')}` : '') +
      '\n',
  );

  if (args.strict) {
    if (skipped > 0) die(`--strict: ${skipped} session(s) cannot be a trajectory-v1 document`);
    if (omissions.noTimestamp + omissions.orphanToolResult > 0) {
      die('--strict: the projection dropped records trajectory-v1 cannot represent');
    }
  }
}
